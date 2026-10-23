"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useWorkspace } from "@/lib/v2/storage";
import {
  audit,
  budget,
  reductions,
  total,
  violations,
  work,
  type Issue,
} from "@/lib/v2/engine";
import {
  assignmentSchema,
  days,
  minutes,
  time,
  type Assignment,
} from "@/lib/v2/model";
import { Heading, Workflow } from "./Common";
import { IssueList } from "./Workbench";
export default function Review() {
  const { data: s, change, undo, redo, canUndo, canRedo } = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState("table"),
    [filter, setFilter] = useState("action"),
    [edit, setEdit] = useState<Assignment | null>(null),
    [error, setError] = useState("");
  if (!s) return null;
  const plan = s.plan;
  if (!plan)
    return (
      <div className="empty">
        <h1>シフト案を作成しましょう</h1>
        <Link className="btn primary gap" href="/generate">
          シフト生成へ →
        </Link>
      </div>
    );
  const issues = audit(s),
    stats = reductions(s),
    dates = days(plan.start, plan.end),
    person = s.people.find((p) => p.id === edit?.personId);
  function open(date: string, id: string) {
    setEdit(
      plan!.assignments.find((a) => a.personId === id && a.date === date) ?? {
        date,
        personId: id,
        code: "CUSTOM",
        start: "10:00",
        end: "14:00",
        rest: 0,
        manual: true,
      },
    );
    setError("");
    dialog.current?.showModal();
  }
  function choose(code: string) {
    if (!edit || !person) return;
    const t = s!.shifts.find(
      (t) => t.department === person.department && t.code === code,
    );
    setEdit(
      t
        ? {
            ...edit,
            ...t,
            breakStart: t.rest
              ? time(Math.ceil((minutes(t.start) + 240) / 60) * 60)
              : undefined,
          }
        : {
            ...edit,
            code: "CUSTOM",
            start: "10:00",
            end: "14:00",
            rest: 0,
            breakStart: undefined,
          },
    );
  }
  function save() {
    if (!edit) return;
    const parsed = assignmentSchema.safeParse(edit);
    if (!parsed.success) {
      setError("勤務・休憩の入力形式を確認してください");
      return;
    }
    const errors = violations(
      parsed.data,
      person,
      plan!.days.find((d) => d.date === edit.date),
      s!,
    );
    if (errors.length) {
      setError(errors.join(" / "));
      return;
    }
    change((s) => {
      if (!s.plan) return;
      s.plan.assignments = [
        ...s.plan.assignments.filter(
          (a) => a.date !== edit.date || a.personId !== edit.personId,
        ),
        { ...parsed.data, manual: true },
      ];
      s.plan.lockedOff = s.plan.lockedOff.filter(
        (x) => x !== edit.date + "|" + edit.personId,
      );
    });
    dialog.current?.close();
  }
  function focus(i: Issue) {
    setView("table");
    setTimeout(() => {
      const id = i.personId ? `cell-${i.date}-${i.personId}` : `day-${i.date}`;
      document
        .getElementById(id)
        ?.scrollIntoView({ block: "center", inline: "center" });
      document.getElementById(id)?.focus();
    }, 0);
  }
  return (
    <>
      <Heading
        title="シフトの監査・調整"
        subtitle={`${plan.start} → ${plan.end} · 手動変更も、その場で監査。`}
        action={
          <Link className="btn primary" href="/export">
            Excel出力 →
          </Link>
        }
      />
      <Workflow step={3} />
      <div
        className="toolbar"
        style={{ justifyContent: "space-between", marginBottom: 15 }}
      >
        <div className="toggle">
          <button
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            スタッフ別の表
          </button>
          <button aria-pressed={view === "day"} onClick={() => setView("day")}>
            日付別（スマホ向け）
          </button>
        </div>
        <div className="toolbar">
          <button className="btn small" onClick={undo} disabled={!canUndo}>
            ↶ 元に戻す
          </button>
          <button className="btn small" onClick={redo} disabled={!canRedo}>
            ↷ やり直す
          </button>
        </div>
      </div>
      {issues.some((i) => i.level === "error") ? (
        <div className="notice danger">
          ハード制約違反があります。解消するまでExcel出力できません。
        </div>
      ) : null}
      {view === "table" ? (
        <div className="table-wrap">
          <table className="schedule">
            <thead>
              <tr>
                <th>スタッフ / 日付</th>
                {dates.map((date) => (
                  <th key={date} id={`day-${date}`} tabIndex={-1}>
                    {date.slice(5)}
                    <span className="tiny">
                      {plan.days.find((d) => d.date === date)?.event}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.people
                .filter((p) => p.active)
                .map((p) => (
                  <tr key={p.id}>
                    <th>
                      {p.name}
                      <span className="tiny">
                        {p.department === "porter" ? "PORTER" : "フロント"} ·{" "}
                        {p.contract === "kb"
                          ? "KB双葉"
                          : p.contract === "general"
                            ? "一般"
                            : "契約未確認"}
                      </span>
                    </th>
                    {dates.map((d) => {
                      const a = plan.assignments.find(
                          (a) => a.personId === p.id && a.date === d,
                        ),
                        w = p.wishes[d],
                        problem = issues.some(
                          (i) =>
                            i.date === d &&
                            i.personId === p.id &&
                            i.level === "error",
                        );
                      return (
                        <td key={d}>
                          <button
                            id={`cell-${d}-${p.id}`}
                            className={`cell ${a?.manual ? "manual" : ""} ${problem ? "problem" : ""}`}
                            aria-label={`${p.name} ${d} ${a?.code ?? "未配置"}を編集`}
                            onClick={() => open(d, p.id)}
                          >
                            {a
                              ? a.code === "CUSTOM"
                                ? `${a.start}–${a.end}`
                                : a.code
                              : plan.lockedOff.includes(d + "|" + p.id)
                                ? "休（手動）"
                                : w?.kind === "leave"
                                  ? "有給"
                                  : w?.kind === "off"
                                    ? "／"
                                    : "—"}
                            {a ? (
                              <span className="tiny">
                                {work(a) / 60}h {a.manual ? "· 手動" : ""}
                              </span>
                            ) : null}
                          </button>
                          <span className="tiny">
                            希望 {w?.raw || "未提出"}
                            {w && !w.reviewed ? " ?" : ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              <tr>
                <th>PORTER実働 / 目安</th>
                {dates.map((d) => (
                  <td key={d}>
                    {total(s, d) / 60} /{" "}
                    {budget(plan.days.find((x) => x.date === d)!).target / 60}h
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="day-list">
          {plan.days.map((d) => (
            <section className="day-card" key={d.date}>
              <div className="panel-head">
                <h2>{d.date.slice(5)}</h2>
                <span className="badge">
                  P {total(s, d.date) / 60}/{budget(d).target / 60}h
                </span>
              </div>
              <span className="tiny">
                {[
                  d.porterClosed ? "P休館" : "",
                  d.frontClosed ? "F休館" : "",
                  d.event,
                ]
                  .filter(Boolean)
                  .join(" / ")}
              </span>
              <ul>
                {plan.assignments
                  .filter((a) => a.date === d.date)
                  .map((a) => (
                    <li key={a.personId}>
                      <span>
                        {s.people.find((p) => p.id === a.personId)?.name}
                      </span>
                      <button
                        className="btn small"
                        onClick={() => open(a.date, a.personId)}
                      >
                        {a.code === "CUSTOM" ? `${a.start}–${a.end}` : a.code} ·{" "}
                        {work(a) / 60}h
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="legend">
        下線：手動変更（再生成で保持） / 希望：原本の内容 /
        未確認・未提出は自動配置対象外
      </p>
      <section className="panel gap">
        <div className="panel-head">
          <h2>監査結果</h2>
          <select
            aria-label="監査フィルター"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="action">修正・調整が必要</option>
            <option value="error">ハード制約違反</option>
            <option value="all">未確認情報も表示</option>
          </select>
        </div>
        <IssueList
          issues={issues.filter(
            (i) =>
              filter === "all" ||
              (filter === "error" ? i.level === "error" : i.level !== "info"),
          )}
          onPick={focus}
        />
        {!issues.length ? (
          <div className="empty">監査上の問題はありません。</div>
        ) : null}
      </section>
      <section className="panel gap">
        <div className="panel-head">
          <h2>勤務・削減の公平性</h2>
          <span className="muted">有給・公休・未提出は削減対象外</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>スタッフ</th>
                <th>希望日数</th>
                <th>希望時間</th>
                <th>出勤日数</th>
                <th>実働</th>
                <th>削減</th>
                <th>8h換算</th>
                <th>全休 / 短縮</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.wishDays}</td>
                  <td>{r.wish / 60}h</td>
                  <td>{r.days}</td>
                  <td>{r.actual / 60}h</td>
                  <td>{r.reduced / 60}h</td>
                  <td>{(r.reduced / 480).toFixed(2)}日</td>
                  <td>
                    {r.offDays} / {r.shortDays}日
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <dialog className="dialog" ref={dialog} onClose={() => setEdit(null)}>
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <h2>
              {person?.name} · {edit.date}
            </h2>
            <p className="subtitle">
              希望：{person?.wishes[edit.date]?.raw || "未提出"}
            </p>
            <div className="form-grid gap">
              <label>
                勤務コード
                <select
                  value={edit.code}
                  onChange={(e) => choose(e.target.value)}
                >
                  {s.shifts
                    .filter((t) => t.department === person?.department)
                    .map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.code} {t.start}–{t.end}
                      </option>
                    ))}
                  <option value="CUSTOM">短時間・時間指定</option>
                </select>
              </label>
              <label>
                休憩（分）
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={edit.rest}
                  onChange={(e) => setEdit({ ...edit, rest: +e.target.value })}
                />
              </label>
              {edit.code === "CUSTOM" ? (
                <>
                  <label>
                    出勤
                    <input
                      type="time"
                      value={edit.start}
                      onChange={(e) =>
                        setEdit({ ...edit, start: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    退勤
                    <input
                      type="time"
                      value={edit.end}
                      onChange={(e) =>
                        setEdit({ ...edit, end: e.target.value })
                      }
                    />
                  </label>
                </>
              ) : null}
              {edit.rest > 0 ? (
                <label>
                  休憩開始
                  <input
                    type="time"
                    value={edit.breakStart ?? ""}
                    onChange={(e) =>
                      setEdit({ ...edit, breakStart: e.target.value })
                    }
                  />
                </label>
              ) : null}
            </div>
            {error ? (
              <div className="notice danger" role="alert">
                {error}
              </div>
            ) : null}
            <div className="toolbar">
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  change((s) => {
                    if (!s.plan) return;
                    s.plan.assignments = s.plan.assignments.filter(
                      (a) =>
                        a.date !== edit.date || a.personId !== edit.personId,
                    );
                    s.plan.lockedOff = [
                      ...new Set([
                        ...s.plan.lockedOff,
                        edit.date + "|" + edit.personId,
                      ]),
                    ];
                  });
                  dialog.current?.close();
                }}
              >
                公休にする
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  change((s) => {
                    if (!s.plan) return;
                    s.plan.assignments = s.plan.assignments.map((a) =>
                      a.date === edit.date && a.personId === edit.personId
                        ? { ...a, manual: false }
                        : a,
                    );
                    s.plan.lockedOff = s.plan.lockedOff.filter(
                      (x) => x !== edit.date + "|" + edit.personId,
                    );
                  });
                  dialog.current?.close();
                }}
              >
                再生成の保護を解除
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => dialog.current?.close()}
              >
                閉じる
              </button>
              <button className="btn primary" type="submit">
                勤務を保存
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </>
  );
}
