import { isoWeekKey, addDays } from "../dateUtils";
import { isOffDay } from "../holidays";
import {
  type State,
  type Plan,
  type Person,
  type Day,
  type Assignment,
  RULES,
  minutes,
  time,
  days,
  defaultDay,
} from "./model";
export interface Issue {
  date: string;
  personId?: string;
  code: string;
  level: "error" | "warning" | "info";
  message: string;
}
export const work = (a: Assignment) =>
  minutes(a.end) - minutes(a.start) - a.rest;
export const budget = (d: Day) => {
  const h = d.holiday ?? isOffDay(d.date);
  return {
    target: d.porterClosed ? 0 : h ? RULES.holidayTarget : RULES.weekday,
    limit: d.porterClosed ? 0 : h ? RULES.holidayLimit : RULES.weekday,
  };
};
export const total = (s: State, d: string) =>
  s.plan?.assignments
    .filter(
      (a) =>
        a.date === d &&
        s.people.find((p) => p.id === a.personId)?.department === "porter",
    )
    .reduce((n, a) => n + work(a), 0) ?? 0;
function windowStart(p: Person, date: string, s: State) {
  const w = p.wishes[date];
  return w?.fromOpening
    ? (s.shifts
        .filter((t) => t.department === p.department)
        .map((t) => t.start)
        .sort()[0] ?? "09:30")
    : (w?.start ?? "09:30");
}
export function desired(p: Person, date: string, s: State) {
  const w = p.wishes[date];
  if (!w || !w.reviewed || ["off", "leave", "unknown"].includes(w.kind))
    return 0;
  if (w.kind === "available") return 480;
  const shift = s.shifts.find(
    (t) => t.department === p.department && t.code === w.code,
  );
  const duration =
    w.kind === "window"
      ? minutes(w.end!) - minutes(windowStart(p, date, s))
      : shift
        ? minutes(shift.end) - minutes(shift.start)
        : 0;
  return Math.max(
    0,
    Math.min(
      480,
      duration -
        (w.kind === "fixed" ? (shift?.rest ?? 0) : duration > 360 ? 60 : 0),
    ),
  );
}
export function violations(
  a: Assignment,
  p: Person | undefined,
  d: Day | undefined,
  s: State,
): string[] {
  const e: string[] = [];
  if (!p || !p.active) return ["スタッフが未登録または無効です"];
  const w = p.wishes[a.date];
  if (p.contract === "unknown") e.push("契約区分が未確認です");
  if (!d || (p.department === "porter" ? d.porterClosed : d.frontClosed))
    e.push("期間外または休館日です");
  if (!w || !w.reviewed || w.kind === "unknown")
    e.push("希望が未提出・未確認です");
  if (w?.kind === "off" || w?.kind === "leave")
    e.push("希望休・有給への配置です");
  const duration = minutes(a.end) - minutes(a.start),
    n = work(a);
  if (!Number.isFinite(n) || n <= 0 || n > 480)
    e.push("実働は0時間超・8時間以内です");
  if (a.start >= a.end || a.rest < 0 || a.rest >= duration)
    e.push("勤務時刻・休憩が不正です");
  if (duration > 360 && a.rest < 60)
    e.push("6時間を超える拘束には60分休憩を設定してください");
  if (duration <= 360 && a.rest !== 0) e.push("6時間以内は原則休憩なしです");
  if (
    a.rest &&
    (!a.breakStart ||
      a.breakStart < a.start ||
      minutes(a.breakStart) + a.rest > minutes(a.end))
  )
    e.push("休憩の開始時刻が勤務範囲外または未設定です");
  if (p.contract === "kb" && !RULES.kbMinutes.some((t) => t === n))
    e.push("KB双葉は実働4時間または8時間のみです");
  const definition = s.shifts.find(
    (t) => t.department === p.department && t.code === a.code,
  );
  if (
    a.code !== "CUSTOM" &&
    (!definition ||
      definition.start !== a.start ||
      definition.end !== a.end ||
      definition.rest !== a.rest)
  )
    e.push("部署の勤務コードと時刻が一致しません");
  if (w?.kind === "fixed" && w.code !== a.code)
    e.push("指定の勤務コードと異なります");
  if (
    w?.kind === "window" &&
    (a.start < windowStart(p, a.date, s) || a.end > w.end!)
  )
    e.push("時間指定の範囲外です");
  if (p.allowed.length && !p.allowed.includes(a.code))
    e.push("許可されていないコードです");
  if (p.excluded.includes(a.code)) e.push("禁止コードです");
  if (d && a.end > d.close) e.push("営業終了時刻を超えています");
  return e;
}
export function gaps(
  d: Day,
  assignments: Assignment[],
  s: State,
  dept: "porter" | "front",
) {
  if (dept === "porter" ? d.porterClosed : d.frontClosed) return [];
  const list = assignments.filter(
      (a) =>
        a.date === d.date &&
        s.people.find((p) => p.id === a.personId)?.department === dept,
    ),
    result: { start: string; end: string; have: number; need: number }[] = [];
  for (let t = minutes(d.open); t < minutes(d.close); t += 15) {
    const need =
      dept === "front"
        ? RULES.frontMinimum
        : t >= minutes(RULES.porterEveningStart)
          ? RULES.porterEveningMinimum
          : (d.holiday ?? isOffDay(d.date))
            ? RULES.holidayMinimum
            : RULES.porterMinimum;
    const have = new Set(
      list
        .filter(
          (a) =>
            t >= minutes(a.start) &&
            t < minutes(a.end) &&
            !(
              a.breakStart &&
              t >= minutes(a.breakStart) &&
              t < minutes(a.breakStart) + a.rest
            ),
        )
        .map((a) => a.personId),
    ).size;
    if (have < need) {
      const prev = result.at(-1);
      if (
        prev &&
        prev.end === time(t) &&
        prev.have === have &&
        prev.need === need
      )
        prev.end = time(Math.min(t + 15, minutes(d.close)));
      else
        result.push({
          start: time(t),
          end: time(Math.min(t + 15, minutes(d.close))),
          have,
          need,
        });
    }
  }
  return result;
}
export function reductions(s: State) {
  const plan = s.plan;
  if (!plan) return [];
  return s.people
    .filter((p) => p.active)
    .map((p) => {
      const entries = days(plan.start, plan.end).map((date) => {
        const wish = desired(p, date, s),
          actual = plan.assignments
            .filter((a) => a.personId === p.id && a.date === date)
            .reduce((n, a) => n + work(a), 0);
        return { date, wish, actual, reduction: Math.max(0, wish - actual) };
      });
      const wish = entries.reduce((n, x) => n + x.wish, 0),
        actual = entries.reduce((n, x) => n + x.actual, 0),
        reduced = entries.reduce((n, x) => n + x.reduction, 0);
      return {
        id: p.id,
        name: p.name,
        department: p.department,
        contract: p.contract,
        wish,
        actual,
        reduced,
        ratio: wish ? actual / wish : 0,
        wishDays: entries.filter((x) => x.wish > 0).length,
        days: entries.filter((x) => x.actual > 0).length,
        reducedDays: entries.filter((x) => x.reduction > 0).length,
        offDays: entries.filter((x) => x.reduction > 0 && x.actual === 0)
          .length,
        shortDays: entries.filter((x) => x.reduction > 0 && x.actual > 0)
          .length,
        entries,
      };
    });
}
export function audit(s: State): Issue[] {
  if (!s.plan) return [];
  const plan = s.plan,
    result: Issue[] = [],
    seen = new Set<string>();
  const push = (
    date: string,
    code: string,
    message: string,
    level: Issue["level"] = "error",
    personId?: string,
  ) => result.push({ date, code, message, level, personId });
  for (const a of plan.assignments) {
    if (a.date < plan.start || a.date > plan.end)
      push(a.date, "period", "対象期間外の配置です", "error", a.personId);
    const p = s.people.find((p) => p.id === a.personId);
    const key = a.date + "|" + a.personId;
    if (seen.has(key))
      push(a.date, "duplicate", "同一スタッフの重複配置", "error", a.personId);
    seen.add(key);
    for (const e of violations(
      a,
      p,
      plan.days.find((d) => d.date === a.date),
      s,
    ))
      push(
        a.date,
        "constraint",
        `${p?.name ?? "不明"}：${e}`,
        "error",
        a.personId,
      );
  }
  for (const date of days(plan.start, plan.end)) {
    const d = plan.days.find((d) => d.date === date);
    if (!d) {
      push(date, "config", "日別設定がありません");
      continue;
    }
    if (d.open >= d.close) {
      push(date, "config", "営業開始と終了の順が不正です");
      continue;
    }
    const b = budget(d),
      n = total(s, date);
    if (n > b.limit)
      push(
        date,
        "budget",
        `PORTER ${n / 60}h / 上限${b.limit / 60}h`,
        "warning",
      );
    else if (n > b.target)
      push(
        date,
        "budget",
        `PORTER ${n / 60}h / 目安${b.target / 60}h`,
        "warning",
      );
    if (n < b.target)
      push(
        date,
        "shortage",
        `PORTER実働 ${n / 60}h / 目安${b.target / 60}h`,
        "warning",
      );
    for (const dept of ["porter", "front"] as const) {
      if (!s.people.some((p) => p.active && p.department === dept)) continue;
      for (const g of gaps(d, plan.assignments, s, dept))
        push(
          date,
          "coverage",
          `${dept === "front" ? "フロント" : "PORTER"} ${g.start}–${g.end}：${g.have}/${g.need}人`,
          "warning",
        );
    }
    const unknown = s.people.filter(
      (p) =>
        p.active &&
        (!p.wishes[date] ||
          p.wishes[date].kind === "unknown" ||
          !p.wishes[date].reviewed),
    );
    if (unknown.length)
      push(
        date,
        "unconfirmed",
        `未提出・未確認 ${unknown.length}人（配置対象外）`,
        "info",
        unknown[0].id,
      );
  }
  for (const p of s.people) {
    const dates = [
      ...new Set(
        plan.assignments.filter((a) => a.personId === p.id).map((a) => a.date),
      ),
    ].sort();
    let run = 0,
      last = "";
    const weeks: Record<string, number> = {};
    for (const d of dates) {
      run = last && addDays(last, 1) === d ? run + 1 : 1;
      last = d;
      const wk = isoWeekKey(d);
      weeks[wk] = (weeks[wk] ?? 0) + 1;
      if (run === (p.maxConsecutive ?? s.consecutive) + 1)
        push(d, "consecutive", `${p.name}：連続勤務${run}日`, "warning", p.id);
      if (p.maxWeek !== undefined && weeks[wk] === p.maxWeek + 1)
        push(d, "weekly", `${p.name}：週勤務上限超過`, "error", p.id);
    }
    if (p.maxTotal !== undefined && dates.length > p.maxTotal)
      push(
        dates.at(-1)!,
        "total",
        `${p.name}：期間の勤務日数超過`,
        "error",
        p.id,
      );
  }
  const stats = reductions(s);
  for (const dept of ["porter", "front"])
    for (const contract of ["general", "kb"]) {
      const group = stats.filter(
          (x) => x.department === dept && x.contract === contract && x.wish > 0,
        ),
        mean = group.reduce((n, x) => n + x.ratio, 0) / (group.length || 1);
      for (const r of group)
        if (group.length > 1 && r.ratio < mean - 0.2)
          push(
            plan.start,
            "fairness",
            `${r.name}：希望への割当${Math.round(r.ratio * 100)}%（同部署・同契約平均${Math.round(mean * 100)}%）`,
            "warning",
            r.id,
          );
    }
  return result;
}
function candidates(p: Person, d: Day, s: State): Assignment[] {
  const w = p.wishes[d.date];
  if (
    !w?.reviewed ||
    ["unknown", "off", "leave"].includes(w.kind) ||
    p.contract === "unknown"
  )
    return [];
  const result: Assignment[] = [];
  const add = (
    start: string,
    end: string,
    code = "CUSTOM",
    rest = minutes(end) - minutes(start) > 360 ? 60 : 0,
  ) => {
    const a: Assignment = {
      personId: p.id,
      date: d.date,
      start,
      end,
      code,
      rest,
      manual: false,
    };
    if (!rest) {
      result.push(a);
      return;
    }
    for (
      let b = Math.ceil((minutes(start) + 180) / 60) * 60;
      b + rest <= minutes(end) - 120;
      b += 60
    )
      result.push({ ...a, breakStart: time(b) });
  };
  if (w.kind === "fixed") {
    const t = s.shifts.find(
      (t) => t.department === p.department && t.code === w.code,
    );
    if (t) add(t.start, t.end, t.code, t.rest);
  } else {
    if (w.kind === "available")
      for (const t of s.shifts.filter((t) => t.department === p.department))
        add(t.start, t.end, t.code, t.rest);
    const start =
        w.kind === "window"
          ? minutes(windowStart(p, d.date, s))
          : minutes(d.open),
      end = Math.min(
        w.kind === "window" ? minutes(w.end!) : minutes(d.close),
        minutes(d.close),
      );
    if (w.kind === "window" && end - start <= 540) add(time(start), time(end));
    for (const length of p.contract === "kb" ? [240, 540] : [240, 360, 540])
      for (let t = start; t + length <= end; t += 30)
        add(time(t), time(t + length));
  }
  const seen = new Set<string>();
  return result.filter((a) => {
    const key = [a.code, a.start, a.end, a.rest, a.breakStart].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return violations(a, p, d, s).length === 0;
  });
}
export function generate(
  s: State,
  start: string,
  end: string,
  configs: Day[],
  preserve = true,
): Plan {
  const dates = days(start, end);
  if (!dates.length || dates.length > 62)
    throw new Error("対象期間は1〜62日にしてください");
  const config = dates.map(
    (d) => configs.find((x) => x.date === d) ?? defaultDay(d),
  );
  if (config.some((d) => d.open >= d.close))
    throw new Error("営業時間を確認してください");
  const manual = preserve
      ? (s.plan?.assignments ?? []).filter(
          (a) => a.manual && dates.includes(a.date),
        )
      : [],
    lockedOff = preserve ? (s.plan?.lockedOff ?? []) : [];
  for (const a of manual) {
    const errors = violations(
      a,
      s.people.find((p) => p.id === a.personId),
      config.find((d) => d.date === a.date),
      s,
    );
    if (errors.length)
      throw new Error(
        `保護セル ${a.date}：${errors.join(" / ")}。先に修正してください`,
      );
  }
  const assignments: Assignment[] = [];
  const assigned: Record<string, number> = {},
    wishToDate: Record<string, number> = {};
  for (const d of config) {
    const locks = manual.filter((a) => a.date === d.date);
    assignments.push(...locks);
    for (const p of s.people)
      wishToDate[p.id] = (wishToDate[p.id] ?? 0) + desired(p, d.date, s);
    for (const a of locks)
      assigned[a.personId] = (assigned[a.personId] ?? 0) + work(a);
    for (const dept of ["porter", "front"] as const) {
      if (dept === "porter" ? d.porterClosed : d.frontClosed) continue;
      const choices = s.people
        .filter(
          (p) =>
            p.active &&
            p.department === dept &&
            !locks.some((a) => a.personId === p.id),
        )
        .map((p) => ({ p, options: candidates(p, d, s) }))
        .sort((a, b) => a.options.length - b.options.length);
      const initial = locks.filter(
        (a) => s.people.find((p) => p.id === a.personId)?.department === dept,
      );
      let beam = [
        {
          items: initial,
          n: initial.reduce((n, a) => n + work(a), 0),
          score: 0,
          fair: 0,
        },
      ];
      for (const { p, options } of choices) {
        const worked = new Set(
          [...assignments, ...manual]
            .filter((a) => a.personId === p.id)
            .map((a) => a.date),
        );
        const week = [...worked].filter(
          (x) => isoWeekKey(x) === isoWeekKey(d.date),
        ).length;
        let streak = 0,
          prev = addDays(d.date, -1);
        while (worked.has(prev)) {
          streak++;
          prev = addDays(prev, -1);
        }
        const blocked =
          lockedOff.includes(d.date + "|" + p.id) ||
          (p.maxTotal !== undefined && worked.size >= p.maxTotal) ||
          (p.maxWeek !== undefined && week >= p.maxWeek);
        const next: typeof beam = [];
        for (const b of beam)
          for (const a of [null, ...(blocked ? [] : options)]) {
            const n = a ? work(a) : 0;
            if (dept === "porter" && b.n + n > budget(d).limit) continue;
            const items = a ? [...b.items, a] : b.items;
            const lack = gaps(d, items, s, dept).reduce(
              (n, g) =>
                n +
                (minutes(g.end) - minutes(g.start)) *
                  ((g.need - g.have) ** 2 +
                    (g.have === 0 ? 4 : 0) +
                    (g.start >= RULES.porterEveningStart ? 2 : 0)),
              0,
            );
            const fair =
              b.fair +
              (s.balance && wishToDate[p.id]
                ? (((assigned[p.id] ?? 0) + n) / wishToDate[p.id] - 0.85) ** 2 *
                  60
                : 0) +
              (a && streak >= (p.maxConsecutive ?? s.consecutive) ? 200 : 0);
            next.push({
              items,
              n: b.n + n,
              fair,
              score:
                lack * 8 +
                fair +
                (dept === "porter"
                  ? Math.max(0, budget(d).target - b.n - n) * 0.03
                  : 0),
            });
          }
        next.sort((a, b) => a.score - b.score);
        beam = next.slice(0, 40);
        if (!beam.length)
          throw new Error("人件費を超える保護セルを先に調整してください");
      }
      for (const a of beam[0].items.filter((a) => !initial.includes(a))) {
        assignments.push(a);
        assigned[a.personId] = (assigned[a.personId] ?? 0) + work(a);
      }
    }
  }
  const plan: Plan = {
    start,
    end,
    assignments,
    days: config,
    lockedOff,
    generatedAt: new Date().toISOString(),
    ruleVersion: RULES.version,
  };
  const errors = audit({ ...s, plan }).filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join(" / "));
  return plan;
}
