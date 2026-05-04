import type {
  Assignment,
  DayConfig,
  LearnedPatterns,
  Member,
  Schedule,
  SchedulerSettings,
  ShiftType,
} from "./types";
import { addDays, isoWeekKey, rangeISO } from "./dateUtils";

export interface GenerateInput {
  startDate: string;
  endDate: string;
  members: Member[];
  shiftTypes: ShiftType[];
  settings: SchedulerSettings;
  /** Existing day configs (events, closed). If missing, auto-derived from settings. */
  dayConfigs?: DayConfig[];
  /** Existing schedule to preserve manually-edited assignments. */
  existing?: Schedule | null;
  /** When true, treat cells with no preference (empty or OCR/Excel produced
   *  status="unavailable" with no explicit ／/x/休/OFF marker) as "available".
   *  This is useful when the input is partial (handwritten / blurry photo /
   *  small staff sheet) so the generator can still fill in shifts instead of
   *  producing an empty schedule. Explicit ／/x/休 cells stay unavailable. */
  treatBlankAsAvailable?: boolean;
  /** Recorded patterns from past manual edits. Used as a soft tie-breaker:
   *  members get a small score bonus on weekdays they've been manually placed
   *  on, and code selection prefers codes that have been hand-set before for
   *  that (member, weekday). Explicit settings (priority, target, morning
   *  shift) still dominate. */
  learnedPatterns?: LearnedPatterns;
}

export interface GenerateResult {
  schedule: Schedule;
  warnings: GenerateWarning[];
}

export interface GenerateWarning {
  date: string;
  level: "info" | "warning" | "error";
  message: string;
}

interface CandidateInfo {
  member: Member;
  shiftCode: string;
  weight: number;
  reason: string;
  forced?: boolean;
}

/** Build a fresh schedule covering the period using greedy assignment + balancing.
 *  - Honors fixed/restricted/unavailable preferences.
 *  - Respects allowedShifts / excludedShifts on the member.
 *  - Balances total assignments across active members when settings.balanceWorkload.
 *  - Enforces maxPerWeek and maxConsecutive heuristically.
 *  - Manually-edited entries from `existing` are preserved verbatim. */
export function generateSchedule(input: GenerateInput): GenerateResult {
  const { startDate, endDate, members, shiftTypes, settings } = input;
  const dates = rangeISO(startDate, endDate);
  const warnings: GenerateWarning[] = [];

  // settings.requiredByWeekday is the single source of truth for required count.
  // Existing day configs are preserved for events/closed only - their stale
  // requiredCount is overwritten so settings changes always take effect on regen.
  const dayConfigs: DayConfig[] = dates.map((date) => {
    const fromInput = input.dayConfigs?.find((d) => d.date === date);
    const weekday = new Date(date).getDay();
    const required =
      settings.requiredByWeekday.find((r) => r.weekday === weekday)?.count ?? 4;
    if (fromInput) {
      return { ...fromInput, requiredCount: required };
    }
    return { date, requiredCount: required, events: [], closed: false };
  });

  // Index helpers
  const memberById = new Map(members.map((m) => [m.id, m]));
  const activeMembers = members.filter((m) => m.active);

  // Carry over manual edits
  const preservedAssignments: Assignment[] = (input.existing?.assignments ?? []).filter(
    (a) => a.manuallyEdited && memberById.has(a.memberId) && a.date >= startDate && a.date <= endDate,
  );

  const totalsByMember = new Map<string, number>();
  const weeklyByMember = new Map<string, Map<string, number>>();
  const lastDateByMember = new Map<string, string>();
  const consecutiveByMember = new Map<string, number>();

  for (const a of preservedAssignments) {
    const w = isoWeekKey(a.date);
    totalsByMember.set(a.memberId, (totalsByMember.get(a.memberId) ?? 0) + 1);
    const wm = weeklyByMember.get(a.memberId) ?? new Map();
    wm.set(w, (wm.get(w) ?? 0) + 1);
    weeklyByMember.set(a.memberId, wm);
  }

  const assignments: Assignment[] = [...preservedAssignments];

  for (const day of dayConfigs) {
    if (day.closed) continue;

    // Already-assigned members for this day (from manual edits)
    const assignedMemberIds = new Set(
      assignments.filter((a) => a.date === day.date).map((a) => a.memberId),
    );
    let weight = assignments
      .filter((a) => a.date === day.date)
      .reduce((sum, a) => sum + effectiveCountAs(a, shiftTypes), 0);

    // 1. Honor fixed/restricted preferences, but never exceed requiredCount.
    //    Sort by member priority so higher-priority members win the limited slots.
    //    For time-range (restricted) preferences, attempt to trim to half-shift
    //    when full duration would exceed the cap.
    const target = day.requiredCount;
    const preferred = activeMembers
      .filter((m) => !assignedMemberIds.has(m.id))
      .map((m) => ({ m, pref: m.preferences[day.date] }))
      .filter(
        (x) =>
          (x.pref?.status === "fixed" && x.pref.shiftCode) ||
          (x.pref?.status === "restricted" && x.pref.customRange),
      )
      .sort((a, b) => b.m.priority - a.m.priority);

    for (const { m, pref } of preferred) {
      const remaining = target - weight;
      if (remaining <= 1e-9) {
        warnings.push({
          date: day.date,
          level: "warning",
          message: `${m.name} の希望 (${pref!.note ?? pref!.shiftCode ?? "時間帯指定"}) は人数上限により未割当`,
        });
        continue;
      }

      if (pref!.status === "fixed" && pref!.shiftCode) {
        const shift = shiftTypes.find((s) => s.code === pref!.shiftCode);
        if (!shift) continue;
        if (shift.countAs > remaining + 1e-9) {
          warnings.push({
            date: day.date,
            level: "warning",
            message: `${m.name} の固定希望 ${pref!.shiftCode} (重み ${shift.countAs}) は残り ${remaining} に収まらず未割当`,
          });
          continue;
        }
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: pref!.shiftCode,
          customRange: undefined,
          manuallyEdited: false,
          warnings: [],
        });
        assignedMemberIds.add(m.id);
        weight += shift.countAs;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      } else if (pref!.status === "restricted" && pref!.customRange) {
        const range = pref!.customRange;
        const fullWeight = weightForRange(range);
        let chosenRange = range;
        let chosenWeight = fullWeight;
        let trimmed = false;
        if (fullWeight > remaining + 1e-9) {
          if (remaining + 1e-9 >= 0.5) {
            chosenRange = trimRangeToHalf(range);
            chosenWeight = 0.5;
            trimmed = true;
          } else {
            warnings.push({
              date: day.date,
              level: "warning",
              message: `${m.name} の時間帯希望 ${range.start}-${range.end} は人数上限により未割当`,
            });
            continue;
          }
        }
        const code = chooseShiftForRange(shiftTypes, chosenRange) ?? "CUSTOM";
        const cellWarnings: string[] = [];
        if (trimmed)
          cellWarnings.push(`人数上限のため ${range.start}-${range.end} → ${chosenRange.start}-${chosenRange.end} に短縮`);
        if (code === "CUSTOM") cellWarnings.push("カスタム時間帯");
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: code,
          customRange: chosenRange,
          manuallyEdited: false,
          warnings: cellWarnings,
        });
        assignedMemberIds.add(m.id);
        weight += chosenWeight;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      }
    }

    // 2. Greedy fill until requiredCount reached using prioritized candidates.
    //    Two house-rules applied here:
    //    a. **Distinct shift codes per day** — if T is already assigned, the
    //       next person should not also be T. We try unused codes first; only
    //       fall back to a duplicate when no fresh code fits the remaining
    //       capacity. Custom-range / "CUSTOM" assignments are exempt because
    //       they are time-window slots, not coded shifts.
    //    b. **Chronological progression** — `candidateShiftCodes` orders codes
    //       so the morning opening shift is first, then later full shifts in
    //       start-time order, then half shifts, then before-morning shifts
    //       last. This implements "朝はB番スタート" and "B → C → D → F" naturally.
    //
    //    Two-pass refill: the first pass enforces all soft constraints (week
    //    cap, consecutive cap). If the day still falls short, the second pass
    //    relaxes those to fill required headcount, recording a warning per
    //    relaxed pick so the user can see exactly where rules were stretched.
    const periodProgress =
      dayConfigs.length > 0
        ? dayConfigs.findIndex((d) => d.date === day.date) / dayConfigs.length
        : 0;
    let safety = 0;
    let relaxed = false;
    while (weight + 1e-9 < target && safety++ < 50) {
      const candidates = collectCandidates({
        day,
        members: activeMembers,
        assignedMemberIds,
        shiftTypes,
        settings,
        totalsByMember,
        weeklyByMember,
        consecutiveByMember,
        lastDateByMember,
        treatBlankAsAvailable: input.treatBlankAsAvailable === true,
        learnedPatterns: input.learnedPatterns,
        relaxCaps: relaxed,
        periodProgress,
      });
      if (candidates.length === 0) {
        if (!relaxed) {
          // Strict pass exhausted — try once more with caps relaxed before
          // giving up on the day.
          relaxed = true;
          continue;
        }
        break;
      }
      candidates.sort((a, b) => b.weight - a.weight);
      const remainingCap = target - weight;

      // Codes already used today — exclude custom-range slots.
      const usedCodes = new Set(
        assignments
          .filter((a) => a.date === day.date && !a.customRange && a.shiftCode !== "CUSTOM")
          .map((a) => a.shiftCode),
      );

      let pickedMember: Member | undefined;
      let chosenCode: string | undefined;
      let chosenWeight = 0;

      // Two-pass selection: prefer (member, unused code) first; only fall back
      // to a duplicate code when no unique pairing fits remaining capacity.
      const weekdayKey = String(new Date(day.date).getDay());
      const tryFind = (allowDuplicate: boolean) => {
        for (const c of candidates) {
          const baseAllowed = candidateShiftCodes(c.member, shiftTypes, settings);
          // Reorder this member's codes by learned-pattern frequency for the
          // current weekday. Codes the user has historically picked for this
          // (member, weekday) bubble to the top while preserving the original
          // chronological order as a tiebreaker.
          const learnedForCell =
            input.learnedPatterns?.memberDayCode[c.member.id]?.[weekdayKey] ?? {};
          const allowed = baseAllowed
            .map((code, idx) => ({ code, idx, learned: learnedForCell[code] ?? 0 }))
            .sort((a, b) => (b.learned - a.learned) || (a.idx - b.idx))
            .map((x) => x.code);
          for (const code of allowed) {
            if (!allowDuplicate && usedCodes.has(code)) continue;
            const s = shiftTypes.find((t) => t.code === code);
            if (!s || s.countAs > remainingCap + 1e-9) continue;
            pickedMember = c.member;
            chosenCode = code;
            chosenWeight = s.countAs;
            return true;
          }
        }
        return false;
      };
      if (!tryFind(false)) tryFind(true);

      if (!pickedMember || !chosenCode) {
        if (!relaxed) {
          relaxed = true;
          continue;
        }
        break;
      }
      const cellWarnings: string[] = [];
      if (usedCodes.has(chosenCode)) cellWarnings.push(`${chosenCode}が重複（他コードで埋め切れず）`);
      if (relaxed) {
        cellWarnings.push("制約緩和で割当（連勤/週上限の限界に近い可能性）");
        warnings.push({
          date: day.date,
          level: "info",
          message: `${pickedMember.name} を ${chosenCode} で緩和割当（連勤・週上限が限界のため）`,
        });
      }
      assignments.push({
        date: day.date,
        memberId: pickedMember.id,
        shiftCode: chosenCode,
        customRange: undefined,
        manuallyEdited: false,
        warnings: cellWarnings,
      });
      assignedMemberIds.add(pickedMember.id);
      weight += chosenWeight;
      bumpCounters(pickedMember.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
    }

    if (weight + 1e-9 < target) {
      const short = +(target - weight).toFixed(1);
      warnings.push({
        date: day.date,
        level: "error",
        message: `必要人数 ${target} に対して ${weight} 名のみ割当（${short} 不足）。希望提出が少ない可能性があります。`,
      });
    }
  }

  // Post-pass fairness review: surface per-member deviation from monthly
  // targets so the user can see where the schedule under- or over-shot.
  for (const m of activeMembers) {
    const target = lookupMemberTarget(settings.memberTargets, m.name);
    if (target <= 0) continue;
    const actual = totalsByMember.get(m.id) ?? 0;
    const gap = target - actual;
    if (Math.abs(gap) >= Math.max(2, target * 0.15)) {
      warnings.push({
        date: dates[0] ?? "",
        level: gap > 0 ? "warning" : "info",
        message:
          gap > 0
            ? `${m.name}: 月間目標 ${target} 回に対して ${actual} 回 (${gap} 回不足)`
            : `${m.name}: 月間目標 ${target} 回に対して ${actual} 回 (${-gap} 回超過)`,
      });
    }
  }

  const schedule: Schedule = {
    id: input.existing?.id ?? `sch_${Date.now()}`,
    name: input.existing?.name ?? `${startDate} - ${endDate}`,
    startDate,
    endDate,
    assignments,
    dayConfigs,
    generatedAt: new Date().toISOString(),
  };

  return { schedule, warnings };
}

function bumpCounters(
  memberId: string,
  date: string,
  totals: Map<string, number>,
  weekly: Map<string, Map<string, number>>,
  last: Map<string, string>,
  consecutive: Map<string, number>,
) {
  totals.set(memberId, (totals.get(memberId) ?? 0) + 1);
  const wk = isoWeekKey(date);
  const wm = weekly.get(memberId) ?? new Map();
  wm.set(wk, (wm.get(wk) ?? 0) + 1);
  weekly.set(memberId, wm);
  const prev = last.get(memberId);
  if (prev && addDays(prev, 1) === date) {
    consecutive.set(memberId, (consecutive.get(memberId) ?? 1) + 1);
  } else {
    consecutive.set(memberId, 1);
  }
  last.set(memberId, date);
}

function collectCandidates(args: {
  day: DayConfig;
  members: Member[];
  assignedMemberIds: Set<string>;
  shiftTypes: ShiftType[];
  settings: SchedulerSettings;
  totalsByMember: Map<string, number>;
  weeklyByMember: Map<string, Map<string, number>>;
  consecutiveByMember: Map<string, number>;
  lastDateByMember: Map<string, string>;
  treatBlankAsAvailable: boolean;
  learnedPatterns?: LearnedPatterns;
  /** When true, allow candidates that hit weekly / consecutive caps. Used as a
   *  second-pass relaxation to keep required headcount filled. */
  relaxCaps?: boolean;
  /** 0..1, how far through the period we are. Used to ramp up the
   *  member-target term as we approach the end so under-target members get
   *  prioritized increasingly hard. */
  periodProgress?: number;
}): CandidateInfo[] {
  const out: CandidateInfo[] = [];
  for (const m of args.members) {
    if (args.assignedMemberIds.has(m.id)) continue;
    const pref = m.preferences[args.day.date];
    // Eligibility:
    // - explicit ○ ("available") is always eligible
    // - fixed/restricted are handled earlier (step 1); skip them here
    // - in relaxed mode, treat missing/blank-unavailable cells as eligible too
    //   so partial OCR/Excel input still yields a usable schedule. Cells that
    //   the user explicitly marked unavailable (note: "／","x","休","公休","OFF")
    //   stay excluded.
    let eligible = pref?.status === "available";
    if (!eligible && args.treatBlankAsAvailable) {
      const note = (pref?.note ?? "").trim();
      const explicitlyOff = /^(?:\/|／|x|X|×|✕|休|公休|OFF|off)$/.test(note);
      if (!pref) eligible = true;
      else if (pref.status === "unavailable" && !explicitlyOff) eligible = true;
      else if (pref.status === "uncertain") eligible = true;
    }
    if (!eligible) continue;

    // Determine candidate shift codes for this member.
    const allowed = candidateShiftCodes(m, args.shiftTypes, args.settings);
    if (allowed.length === 0) continue;

    // Capacity checks
    const week = isoWeekKey(args.day.date);
    const weeklyCount = args.weeklyByMember.get(m.id)?.get(week) ?? 0;
    const maxWeek = m.constraints.maxPerWeek ?? args.settings.defaultMaxPerWeek;
    const overWeekCap = weeklyCount >= maxWeek;
    if (overWeekCap && !args.relaxCaps) continue;

    const consecutive = args.consecutiveByMember.get(m.id) ?? 0;
    const last = args.lastDateByMember.get(m.id);
    const isConsecutive = last && addDays(last, 1) === args.day.date;
    const maxConsecutive = m.constraints.maxConsecutive ?? args.settings.defaultMaxConsecutive;
    const overConsecutive = !!isConsecutive && consecutive >= maxConsecutive;
    if (overConsecutive && !args.relaxCaps) continue;

    // Score:
    // - balanceTerm pulls down members who already have many shifts
    // - priorityTerm = member.priority (higher = more wanted)
    // - targetGapTerm boosts members who are still under their monthly target
    //   so the schedule converges toward the per-member targets the user set
    //   in settings.memberTargets (e.g. 鈴木:22, 浜野:22, ...).
    // - prefBonus mildly favors explicit ○
    const total = args.totalsByMember.get(m.id) ?? 0;
    const balanceTerm = args.settings.balanceWorkload ? -total * 2 : 0;
    const priorityTerm = m.priority;
    const target = lookupMemberTarget(args.settings.memberTargets, m.name);
    const targetGap = target > 0 ? Math.max(0, target - total) : 0;
    // Ramp up the target term as the period progresses: at the start of the
    // month a small nudge is enough; near the end, under-target members get a
    // much stronger boost so we converge to monthly goals instead of leaving
    // a permanent gap. progress=0 → 3x, progress=1 → 8x.
    const progress = args.periodProgress ?? 0;
    const targetWeight = 3 + progress * 5;
    const targetTerm = targetGap * targetWeight;
    const prefBonus = pref?.status === "available" ? 1 : 0;
    const capPenalty = (overWeekCap ? -8 : 0) + (overConsecutive ? -8 : 0);

    // Soft learning bonus: count past manual on/off events on this weekday for
    // this member. On-events bias up, off-events bias down. Weight is small
    // (0.4 / 0.6) to keep explicit settings dominant; learning only matters
    // for breaking ties between otherwise-equivalent candidates.
    const wkKey = String(new Date(args.day.date).getDay());
    const learnedOnCounts = args.learnedPatterns?.memberDayCode[m.id]?.[wkKey] ?? {};
    const learnedOnSum = Object.values(learnedOnCounts).reduce((a, b) => a + b, 0);
    const learnedOff = args.learnedPatterns?.memberDayOff[m.id]?.[wkKey] ?? 0;
    const learningTerm = learnedOnSum * 0.4 - learnedOff * 0.6;

    const weight = balanceTerm + priorityTerm + targetTerm + prefBonus + learningTerm + capPenalty;

    // Pick best shift for this member - first in the (re-ordered) allowed list.
    out.push({
      member: m,
      shiftCode: allowed[0],
      weight,
      reason: pref?.note ?? "auto",
    });
  }
  return out;
}

/** Look up a target by name. Tries the full member name first, then the
 *  last-name (Japanese surname before the first whitespace). This lets users
 *  set targets as just "鈴木" while members are stored as "鈴木 絢也". */
function lookupMemberTarget(
  targets: Record<string, number> | undefined,
  memberName: string,
): number {
  if (!targets) return 0;
  if (targets[memberName] != null) return targets[memberName];
  const surname = memberName.split(/\s+/)[0];
  if (surname && targets[surname] != null) return targets[surname];
  return 0;
}

/** Return the member's allowed shift codes, ordered for greedy selection.
 *
 *  Order priority (lower rank = picked first):
 *  - 0    morning opening shift (settings.morningShiftCode, e.g. "B")
 *  - 1..n other full shifts at-or-after the morning shift, sorted by start time
 *         (e.g. C 11:00 → D 12:00 → F 14:00)
 *  - 200+ half shifts (countAs < 1, e.g. "A") — only used to top off 0.5
 *         remaining capacity on 3.5-person days
 *  - 500+ full shifts that start *before* the morning shift (e.g. S 9:30,
 *         T 9:45) — rarely used, kept as last-resort.
 *
 *  This implements the house rules:
 *  - 「朝はB番スタート」 → B is index 0 for any member trained on B
 *  - 「B → C → D → F のチェーン」 → chronological after morning
 *  - 「Aなし」(unless we need 0.5) → A is in the half-shift band, after fulls
 */
function candidateShiftCodes(
  member: Member,
  shiftTypes: ShiftType[],
  settings: SchedulerSettings,
): string[] {
  const allowed = member.constraints.allowedShifts;
  const excluded = new Set(member.constraints.excludedShifts ?? []);
  const candidates = (allowed && allowed.length > 0
    ? allowed
    : shiftTypes.filter((s) => !s.isOff).map((s) => s.code)
  ).filter((c) => !excluded.has(c));

  const morning = settings.morningShiftCode;
  const morningShift = morning ? shiftTypes.find((s) => s.code === morning) : undefined;
  const morningMin = morningShift ? timeToMin(morningShift.start) : 0;

  function rank(code: string): number {
    const s = shiftTypes.find((t) => t.code === code);
    if (!s || s.isOff) return 9999;
    if (code === morning) return 0;
    const start = timeToMin(s.start);
    const isHalf = s.countAs < 1;
    const isEarlier = morningShift !== undefined && start < morningMin;
    if (isHalf) return 200 + start; // half shifts after fulls, ordered by start
    if (isEarlier) return 500 + start; // before-morning fulls last
    return 1 + start; // normal full shifts: chronological after morning
  }

  return candidates.slice().sort((a, b) => rank(a) - rank(b));
}

function chooseShiftForRange(
  shiftTypes: ShiftType[],
  range: { start: string; end: string },
): string | undefined {
  // Pick the working shift fully contained within the restriction range.
  const matches = shiftTypes.filter(
    (s) => !s.isOff && s.start >= range.start && s.end <= range.end,
  );
  if (matches.length > 0) return matches[0].code;
  return undefined;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Headcount weight for a custom time window. ≥6h counts as 1.0, otherwise 0.5. */
function weightForRange(range: { start: string; end: string }): number {
  const hours = (timeToMin(range.end) - timeToMin(range.start)) / 60;
  return hours >= 6 ? 1 : 0.5;
}

/** Effective countAs for an assignment, handling CUSTOM-range assignments. */
export function effectiveCountAs(a: Assignment, shiftTypes: ShiftType[]): number {
  const found = shiftTypes.find((s) => s.code === a.shiftCode);
  if (found) return found.countAs;
  if (a.customRange) return weightForRange(a.customRange);
  return 1;
}

/** Shorten a range to ~4 hours by pushing the start later. Keeps the original
 *  end time on the assumption that closing-time coverage is more critical. */
function trimRangeToHalf(range: { start: string; end: string }): { start: string; end: string } {
  const endMin = timeToMin(range.end);
  const startMin = Math.max(timeToMin(range.start), endMin - 240);
  return { start: minToTime(startMin), end: range.end };
}

// =============================================================================
// Helpers used by UI for stats
// =============================================================================

export interface MemberStats {
  memberId: string;
  totalCount: number;
  weightedTotal: number;
}

export function computeStats(schedule: Schedule, shiftTypes: ShiftType[]): MemberStats[] {
  const map = new Map<string, MemberStats>();
  for (const a of schedule.assignments) {
    const stat = map.get(a.memberId) ?? {
      memberId: a.memberId,
      totalCount: 0,
      weightedTotal: 0,
    };
    const shift = shiftTypes.find((s) => s.code === a.shiftCode);
    stat.totalCount += 1;
    stat.weightedTotal += shift?.countAs ?? 1;
    map.set(a.memberId, stat);
  }
  return [...map.values()];
}

export function dailyHeadcount(schedule: Schedule, shiftTypes: ShiftType[], date: string): number {
  return schedule.assignments
    .filter((a) => a.date === date)
    .reduce((sum, a) => sum + effectiveCountAs(a, shiftTypes), 0);
}
