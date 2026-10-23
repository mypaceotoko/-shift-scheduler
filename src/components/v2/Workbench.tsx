"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/v2/storage";
import { audit, reductions, type Issue } from "@/lib/v2/engine";
import {
  RULES,
  days,
  defaultDay,
  initialState,
  parseWish,
  minutes,
  type Day,
  type Person,
  type Plan,
} from "@/lib/v2/model";
import { Heading, Metric, Workflow } from "./Common";
import { holidayName } from "@/lib/holidays";
export function Overview() {
  const { data: s, replace } = useWorkspace();
  if (!s) return null;
  const plan = s.plan,
    dates = plan
      ? days(plan.start, plan.end)
      : [...new Set(s.people.flatMap((p) => Object.keys(p.wishes)))].sort();
  const unknown = s.people.reduce(
      (n, p) =>
        n +
        dates.filter(
          (d) =>
            !p.wishes[d] ||
            !p.wishes[d].reviewed ||
            p.wishes[d].kind === "unknown",
        ).length,
      0,
    ),
    issues = audit(s),
    stats = reductions(s),
    errors = issues.filter((i) => i.level === "error");
  const next = !s.people.length
    ? [
        "希望表から、今月のシフトを。",
        "写真・PDF・Excelを原本と照合し、自動生成まで進めます。",
        "/import",
        "希望表を取り込む",
      ]
    : unknown
      ? [
          "勤務希望を確認しましょう。",
          `未提出・未確認が${unknown}セルあります。確認できた希望のみを配置します。`,
          "/import",
          "読取確認へ",
        ]
      : !plan?.generatedAt
        ? [
            "希望がそろいました。シフトを生成。",
            "勤務希望と契約条件を守り、実働時間と人員を調整します。",
            "/generate",
            "シフトを自動生成",
          ]
        : [
            "シフト案を、現場で使える形へ。",
            "監査結果から不足時間帯を確認し、調整してExcelに出力できます。",
            "/schedule",
            "監査・調整へ",
          ];
  function sample() {
    if (
      s!.people.length &&
      !confirm(
        "サンプルデータへ置き換えます。現在の状態は「元に戻す」で戻せます。",
      )
    )
      return;
    const next = initialState(),
      ds = days("2026-10-11", "2026-10-17");
    next.people = Array.from({ length: 4 }, (_, i) => ({
      id: "sample-" + i,
      name: "サンプル " + String.fromCharCode(65 + i),
      department: "porter",
      contract: i < 2 ? "kb" : "general",
      active: true,
      allowed: [],
      excluded: [],
      notes: "操作確認用の架空データ",
      wishes: Object.fromEntries(
        ds.map((d, n) => [d, parseWish(n === i ? "／" : "○", true)]),
      ),
    }));
    next.plan = {
      start: ds[0],
      end: ds.at(-1)!,
      assignments: [],
      days: ds.map(defaultDay),
      lockedOff: [],
    };
    replace(next);
  }
  return (
    <>
      <Heading
        title="シフト管理"
        subtitle="希望の確認から完成まで、ひとつのワークスペースで。"
        action={<span className="badge">ルール {RULES.version}</span>}
      />
      <div className="panel-head">
        <span className="muted">
          対象期間　
          <strong>
            {dates[0] ?? "未設定"} → {dates.at(-1) ?? "希望表から設定"}
          </strong>
        </span>
        <Link className="btn small" href="/generate">
          期間を変更 ↗
        </Link>
      </div>
      <section className="hero">
        <div>
          <p className="eyebrow">YOUR NEXT STEP</p>
          <h2>{next[0]}</h2>
          <p>{next[1]}</p>
        </div>
        <Link className="btn" href={next[2]}>
          {next[3]} →
        </Link>
      </section>
      <Workflow
        step={!s.people.length ? 0 : unknown ? 1 : !plan?.generatedAt ? 2 : 3}
      />
      <div className="metrics">
        <Metric
          label="希望提出スタッフ"
          value={`${s.people.filter((p) => dates.some((d) => p.wishes[d]?.raw)).length} / ${s.people.length}`}
          note="提出済み / 登録人数"
        />
        <Metric
          label="未確認セル"
          value={String(unknown)}
          note="未提出・認識不明を含む"
          warn={unknown > 0}
        />
        <Metric
          label="不足・調整必要日"
          value={`${new Set(issues.filter((i) => i.code === "shortage" || i.code === "coverage").map((i) => i.date)).size} 日`}
          note="実働と時間帯を別々に確認"
          warn={issues.some((i) => i.code === "coverage")}
        />
        <Metric
          label="ハード制約違反"
          value={`${errors.length} 件`}
          note="希望・契約・時間指定"
          warn={!!errors.length}
        />
      </div>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>スタッフ別の勤務バランス</h2>
            <span className="badge">希望と実働</span>
          </div>
          {stats.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>スタッフ</th>
                    <th>希望 / 実働</th>
                    <th>割当率</th>
                    <th>削減</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <span className="tiny">{r.days}日出勤</span>
                      </td>
                      <td>
                        {r.wish / 60} / {r.actual / 60}h
                      </td>
                      <td>
                        <div className="bar">
                          <span
                            style={{
                              width: `${Math.min(100, r.ratio * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="tiny">
                          {r.wish ? `${Math.round(r.ratio * 100)}%` : "対象外"}
                        </span>
                      </td>
                      <td>
                        {r.reduced / 60}h
                        <span className="tiny">
                          {(r.reduced / 480).toFixed(2)}日換算
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              希望表を取り込むと、勤務と削減を確認できます。
              <div className="gap">
                <button className="btn" onClick={sample}>
                  サンプルで操作を試す
                </button>
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>確認が必要な項目</h2>
            <Link className="muted" href="/schedule">
              すべて見る ↗
            </Link>
          </div>
          <IssueList
            issues={issues.filter((i) => i.level !== "info").slice(0, 7)}
          />
          {!issues.length ? (
            <div className="empty">生成後に監査結果を表示します。</div>
          ) : null}
        </section>
      </div>
    </>
  );
}
export function IssueList({
  issues,
  onPick,
}: {
  issues: Issue[];
  onPick?: (i: Issue) => void;
}) {
  return (
    <div className="issue-list">
      {issues.map((i, n) =>
        onPick ? (
          <button className="issue" key={n} onClick={() => onPick(i)}>
            <small>
              {i.date}{" "}
              <span
                className={`badge ${i.level === "error" ? "error" : "warn"}`}
              >
                {i.level === "error"
                  ? "要修正"
                  : i.level === "info"
                    ? "要確認"
                    : "調整必要"}
              </span>
            </small>
            {i.message} ↗
          </button>
        ) : (
          <Link className="issue" href={`/schedule/#day-${i.date}`} key={n}>
            <small>{i.date}</small>
            {i.message} ↗
          </Link>
        ),
      )}
    </div>
  );
}
export function Staff() {
  const { data: s, change } = useWorkspace();
  const [name, setName] = useState("");
  if (!s) return null;
  const update = (id: string, patch: Partial<Person>) =>
    change((s) => {
      s.people = s.people.map((p) => (p.id === id ? { ...p, ...patch } : p));
    });
  return (
    <>
      <Heading
        title="スタッフと契約条件"
        subtitle="氏名から契約を推測せず、スタッフIDと契約区分で管理します。"
        action={
          <Link href="/generate" className="btn primary">
            生成へ →
          </Link>
        }
      />
      {s.people.some((p) => p.contract === "unknown") ? (
        <div className="notice warning">
          契約未確認のスタッフは配置対象外です。部署・契約を原本で確認してください。
        </div>
      ) : null}
      <div className="panel toolbar">
        <label>
          正式氏名
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            change((s) => {
              s.people.push({
                id: crypto.randomUUID(),
                name: name.trim(),
                active: true,
                department: "porter",
                contract: "unknown",
                allowed: [],
                excluded: [],
                notes: "",
                wishes: {},
              });
            });
            setName("");
          }}
        >
          ＋ スタッフを追加
        </button>
      </div>
      <div className="stack gap">
        {s.people.map((p) => (
          <section className="panel" key={p.id}>
            <div className="panel-head">
              <h2>
                {p.name}{" "}
                <span
                  className={`badge ${p.contract === "unknown" ? "warn" : "ok"}`}
                >
                  {p.contract === "kb"
                    ? "KB双葉 · 4h/8h"
                    : p.contract === "general"
                      ? "一般"
                      : "契約未確認"}
                </span>
              </h2>
              <label className="check">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => update(p.id, { active: e.target.checked })}
                />
                有効
              </label>
            </div>
            <div className="form-grid">
              <label>
                正式氏名
                <input
                  defaultValue={p.name}
                  onBlur={(e) => {
                    if (e.target.value.trim())
                      update(p.id, { name: e.target.value.trim() });
                  }}
                />
              </label>
              <label>
                部署
                <select
                  value={p.department}
                  onChange={(e) =>
                    update(p.id, {
                      department: e.target.value as Person["department"],
                    })
                  }
                >
                  <option value="porter">PORTER</option>
                  <option value="front">フロント</option>
                </select>
              </label>
              <label>
                契約区分
                <select
                  aria-label={`${p.name} 契約区分`}
                  value={p.contract}
                  onChange={(e) =>
                    update(p.id, {
                      contract: e.target.value as Person["contract"],
                    })
                  }
                >
                  <option value="unknown">要確認（配置対象外）</option>
                  <option value="general">一般スタッフ</option>
                  <option value="kb">KB双葉（実働4h/8h）</option>
                </select>
              </label>
              {(["maxWeek", "maxTotal", "maxConsecutive"] as const).map(
                (key, i) => (
                  <label key={key}>
                    {
                      [
                        "週の最大勤務日数",
                        "期間の最大勤務日数",
                        "連続勤務の目安",
                      ][i]
                    }
                    <input
                      type="number"
                      min={key === "maxConsecutive" ? 1 : 0}
                      max={key === "maxWeek" ? 7 : 62}
                      defaultValue={p[key] ?? ""}
                      placeholder="指定なし"
                      onBlur={(e) =>
                        update(p.id, {
                          [key]:
                            e.target.value === "" ? undefined : +e.target.value,
                        })
                      }
                    />
                  </label>
                ),
              )}
              <label>
                許可する勤務コード（空欄＝部署内すべて）
                <input
                  defaultValue={p.allowed.join(",")}
                  placeholder="B,C,F,CUSTOM"
                  onBlur={(e) =>
                    update(p.id, {
                      allowed: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                禁止コード
                <input
                  defaultValue={p.excluded.join(",")}
                  onBlur={(e) =>
                    update(p.id, {
                      excluded: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                業務上の配置メモ
                <textarea
                  rows={2}
                  defaultValue={p.notes}
                  onBlur={(e) => update(p.id, { notes: e.target.value })}
                />
                <span className="tiny">メモは手動調整時の参照情報です。</span>
              </label>
            </div>
            <div className="toolbar gap">
              <span className="tiny">
                ID {p.id} · 希望{Object.keys(p.wishes).length}日分
              </span>
              <button
                className="btn small danger"
                onClick={() => {
                  if (
                    confirm(
                      "スタッフを無効にします。勤務・希望データは保持し、有効に戻すことで復帰できます。",
                    )
                  )
                    update(p.id, { active: false });
                }}
              >
                無効にする
              </button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
export function CreatePlan() {
  const { data: s, change, notice } = useWorkspace();
  const ds = s?.people.flatMap((p) => Object.keys(p.wishes)).sort() ?? [];
  const today = new Date(),
    base = new Date(
      today.getFullYear(),
      today.getMonth() - (today.getDate() < 11 ? 1 : 0),
      11,
    ),
    last = new Date(base.getFullYear(), base.getMonth() + 1, 10),
    iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [start, setStart] = useState(s?.plan?.start ?? ds[0] ?? iso(base)),
    [end, setEnd] = useState(s?.plan?.end ?? ds.at(-1) ?? iso(last)),
    [configs, setConfigs] = useState<Day[]>(s?.plan?.days ?? []),
    [preserve, setPreserve] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  if (!s) return null;
  const period = days(start, end).slice(0, 63),
    config = (d: string) => configs.find((c) => c.date === d) ?? defaultDay(d),
    patch = (d: string, p: Partial<Day>) =>
      setConfigs([
        ...configs.filter((c) => c.date !== d),
        { ...config(d), ...p },
      ]);
  function run() {
    if (!period.length || period.length > 62) {
      setError("期間は1〜62日にしてください");
      return;
    }
    setBusy(true);
    setError("");
    const w = new Worker(
      new URL("../../lib/v2/generator.worker.ts", import.meta.url),
    );
    worker.current = w;
    w.onmessage = (e: MessageEvent<{ plan?: Plan; error?: string }>) => {
      setBusy(false);
      if (e.data.error) setError(e.data.error);
      if (e.data.plan) {
        const plan = e.data.plan;
        change((s) => {
          s.plan = plan;
        });
        notice("シフト案を作成しました。監査・調整へ進んでください。");
      }
      w.terminate();
      worker.current = null;
    };
    w.onerror = () => {
      setBusy(false);
      setError("計算処理を開始できません。再読み込みして再度お試しください");
      w.terminate();
      worker.current = null;
    };
    w.postMessage({
      state: s,
      start,
      end,
      configs: period.map(config),
      preserve,
    });
  }
  return (
    <>
      <Heading
        title="月間シフトを生成"
        subtitle="確認済みの希望を、契約・実働・時間帯の条件で組み合わせます。"
        action={
          <Link href="/members" className="btn">
            スタッフ確認
          </Link>
        }
      />
      <Workflow step={2} />
      <section className="panel">
        <div className="form-grid">
          <label>
            開始日
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            終了日
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <div className="notice">
          PORTERは平日24h以内、土日祝28h目安・上限30h。フロントは別集計です。確認できない希望・契約は配置しません。
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={preserve}
            onChange={(e) => setPreserve(e.target.checked)}
          />
          手動変更と手動公休を保持して再生成
        </label>
        <div className="toolbar gap">
          <button
            className="btn primary"
            disabled={busy || !s.people.some((p) => p.active)}
            onClick={run}
          >
            {busy ? "組み合わせを計算中…" : "✦ シフト案を自動生成"}
          </button>
          {busy ? (
            <button
              className="btn"
              onClick={() => {
                worker.current?.terminate();
                worker.current = null;
                setBusy(false);
              }}
            >
              中止（現在の案を保持）
            </button>
          ) : null}
          {s.plan?.generatedAt ? (
            <Link href="/schedule" className="btn">
              監査・調整へ →
            </Link>
          ) : null}
        </div>
      </section>
      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}
      <section className="panel gap">
        <div className="panel-head">
          <h2>休館・祝日・営業時間</h2>
          <span className="muted">当月原本で確認</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日付</th>
                <th>P休館</th>
                <th>フロント休館</th>
                <th>祝日扱い</th>
                <th>開始</th>
                <th>終了</th>
                <th>イベント</th>
              </tr>
            </thead>
            <tbody>
              {period.map((date) => {
                const d = config(date);
                return (
                  <tr key={date}>
                    <td>
                      {date}
                      <span className="tiny">{holidayName(date)}</span>
                    </td>
                    <td>
                      <input
                        aria-label={`${date} PORTER休館`}
                        type="checkbox"
                        checked={d.porterClosed}
                        onChange={(e) =>
                          patch(date, { porterClosed: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${date} フロント休館`}
                        type="checkbox"
                        checked={d.frontClosed}
                        onChange={(e) =>
                          patch(date, { frontClosed: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${date} 祝日扱い`}
                        type="checkbox"
                        checked={d.holiday ?? !!holidayName(date)}
                        onChange={(e) =>
                          patch(date, { holiday: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${date} 開始`}
                        type="time"
                        value={d.open}
                        onChange={(e) => patch(date, { open: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${date} 終了`}
                        type="time"
                        value={d.close}
                        onChange={(e) => patch(date, { close: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${date} イベント`}
                        defaultValue={d.event}
                        onBlur={(e) => patch(date, { event: e.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
export function Settings() {
  const { data: s, change } = useWorkspace();
  const [code, setCode] = useState(""),
    [start, setStart] = useState("10:00"),
    [end, setEnd] = useState("14:00"),
    [rest, setRest] = useState(0),
    [dept, setDept] = useState<"porter" | "front">("porter");
  if (!s) return null;
  return (
    <>
      <Heading
        title="業務ルールと設定"
        subtitle={`共通ルール ${RULES.version} · 希望と契約条件を最優先。`}
      />
      <section className="panel">
        <h2>生成・監査の基準</h2>
        <div className="notice">
          KB双葉は実働4h・8hのみ。○は8h基準。6h以内は原則休憩なし、6h超は60分休憩。空欄・不鮮明・未確認・有給は配置対象外です。
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={s.balance}
            onChange={(e) =>
              change((s) => {
                s.balance = e.target.checked;
              })
            }
          />
          希望に対する割当率を考慮する
        </label>
        <label className="gap">
          連続勤務の目安
          <input
            style={{ width: 130 }}
            type="number"
            min={1}
            max={62}
            defaultValue={s.consecutive}
            onBlur={(e) =>
              change((s) => {
                s.consecutive = +e.target.value;
              })
            }
          />
        </label>
      </section>
      <section className="panel gap">
        <div className="panel-head">
          <h2>部署別の勤務コード</h2>
          <span className="badge">フロントAは8:45〜17:45</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>部署</th>
                <th>コード</th>
                <th>勤務</th>
                <th>休憩</th>
                <th>実働</th>
              </tr>
            </thead>
            <tbody>
              {s.shifts.map((t) => (
                <tr key={t.department + t.code}>
                  <td>{t.department === "porter" ? "PORTER" : "フロント"}</td>
                  <td>{t.code}</td>
                  <td>
                    {t.start}–{t.end}
                  </td>
                  <td>{t.rest}分</td>
                  <td>{(minutes(t.end) - minutes(t.start) - t.rest) / 60}h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h2 className="gap">短時間の勤務コードを追加</h2>
        <div className="form-grid gap">
          <label>
            部署
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value as typeof dept)}
            >
              <option value="porter">PORTER</option>
              <option value="front">フロント</option>
            </select>
          </label>
          <label>
            コード
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label>
            出勤
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            退勤
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label>
            休憩（分）
            <input
              type="number"
              min={0}
              max={120}
              value={rest}
              onChange={(e) => setRest(+e.target.value)}
            />
          </label>
        </div>
        <button
          className="btn gap"
          disabled={
            !code ||
            s.shifts.some((t) => t.department === dept && t.code === code)
          }
          onClick={() => {
            change((s) => {
              s.shifts.push({ code, department: dept, start, end, rest });
            });
            setCode("");
          }}
        >
          コードを追加
        </button>
      </section>
      <details className="panel gap">
        <summary>行動予定表の業務基準と対応範囲</summary>
        <p className="subtitle">
          10:00〜22:30・30分刻み、フロント最低2人、Fは基本1時間。休憩者を人数から除外してロッカーを配置。P応援は許可担当者のみ。会議・ゴミ曜日・男女ローテーションは当月原本で確認します。
        </p>
        <div className="notice warning">
          この版は月間シフト・勤務帯と休憩の監査に対応します。F・ロ・ゴミ・P・事務の行動予定表自動配置は未実装です。
        </div>
      </details>
    </>
  );
}
