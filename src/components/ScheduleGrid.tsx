"use client";

import clsx from "clsx";
import { useMemo } from "react";
import { useAppStore } from "@/lib/store";
import { rangeISO, weekdayLabel, isWeekend } from "@/lib/dateUtils";
import { dailyHeadcount, effectiveCountAs } from "@/lib/scheduler";
import type { Assignment } from "@/lib/types";

export default function ScheduleGrid({ editable = true }: { editable?: boolean }) {
  const { schedule, members, shiftTypes, updateAssignment, removeAssignment, updateDayConfig } =
    useAppStore();

  const dates = useMemo(
    () => (schedule ? rangeISO(schedule.startDate, schedule.endDate) : []),
    [schedule],
  );
  if (!schedule) {
    return <p className="text-sm text-slate-500">スケジュールがまだ生成されていません。</p>;
  }

  const codes = ["", ...shiftTypes.map((s) => s.code)];

  function cellFor(date: string, memberId: string): Assignment | undefined {
    return schedule!.assignments.find((a) => a.date === date && a.memberId === memberId);
  }

  function onCellChange(date: string, memberId: string, code: string) {
    if (!code) {
      removeAssignment(date, memberId);
      return;
    }
    updateAssignment({
      date,
      memberId,
      shiftCode: code,
      manuallyEdited: true,
      warnings: [],
    });
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="border-collapse text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="cell-base sticky left-0 z-10 bg-slate-50 min-w-[140px] text-left pl-2">
              メンバー
            </th>
            {dates.map((d) => (
              <th
                key={d}
                className={clsx(
                  "cell-base font-medium",
                  isWeekend(d) && "bg-rose-50 text-rose-700",
                )}
              >
                <div>{d.slice(5)}</div>
                <div className="text-[11px] text-slate-500">({weekdayLabel(d)})</div>
              </th>
            ))}
            <th className="cell-base bg-slate-50">合計</th>
          </tr>
          <tr>
            <th className="cell-base sticky left-0 z-10 bg-slate-50 text-left pl-2 text-xs">
              イベント
            </th>
            {dates.map((d) => {
              const cfg = schedule.dayConfigs.find((x) => x.date === d);
              return (
                <th key={d} className={clsx("cell-base text-[11px] font-normal", cfg?.closed && "bg-slate-300 text-slate-500")}>
                  {editable ? (
                    <input
                      defaultValue={cfg?.events.join(",") ?? ""}
                      onBlur={(e) =>
                        updateDayConfig(d, {
                          events: e.target.value
                            .split(/[,、]/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      className="w-full bg-transparent text-center text-[11px] outline-none"
                      placeholder="-"
                    />
                  ) : (
                    cfg?.events.join(",")
                  )}
                </th>
              );
            })}
            <th className="cell-base bg-slate-50"></th>
          </tr>
        </thead>
        <tbody>
          {members
            .filter((m) => m.active)
            .map((m) => {
              let total = 0;
              return (
                <tr key={m.id}>
                  <td className="cell-base sticky left-0 z-10 bg-white text-left pl-2 font-medium">
                    {m.name}
                  </td>
                  {dates.map((d) => {
                    const a = cellFor(d, m.id);
                    const cfg = schedule.dayConfigs.find((x) => x.date === d);
                    if (a) total += effectiveCountAs(a, shiftTypes);
                    const pref = m.preferences[d];
                    const unavailable = pref?.status === "unavailable";
                    return (
                      <td
                        key={d}
                        className={clsx(
                          "cell-base p-0",
                          a?.shiftCode && shiftTypes.find((s) => s.code === a.shiftCode)?.color,
                          a?.manuallyEdited && "ring-1 ring-inset ring-brand-500",
                          unavailable && !a && "bg-slate-100 text-slate-300",
                          cfg?.closed && "bg-slate-200",
                        )}
                        title={a?.warnings?.join(", ") ?? pref?.note ?? ""}
                      >
                        {editable ? (
                          <select
                            value={a?.shiftCode ?? ""}
                            onChange={(e) => onCellChange(d, m.id, e.target.value)}
                            disabled={cfg?.closed}
                            className="h-full w-full bg-transparent text-center text-sm outline-none"
                          >
                            {codes.map((c) => (
                              <option key={c} value={c}>
                                {c || (unavailable ? "／" : "")}
                              </option>
                            ))}
                          </select>
                        ) : (
                          a?.shiftCode ?? (unavailable ? "／" : "")
                        )}
                      </td>
                    );
                  })}
                  <td className="cell-base bg-slate-50 font-medium">{total}</td>
                </tr>
              );
            })}
          <tr>
            <td className="cell-base sticky left-0 z-10 bg-slate-50 text-left pl-2 font-semibold">
              出勤人数
            </td>
            {dates.map((d) => {
              const cfg = schedule.dayConfigs.find((x) => x.date === d);
              const need = cfg?.requiredCount ?? 0;
              const have = dailyHeadcount(schedule, shiftTypes, d);
              const short = !cfg?.closed && have + 1e-9 < need;
              return (
                <td
                  key={d}
                  className={clsx(
                    "cell-base font-semibold",
                    short ? "bg-rose-100 text-rose-700" : "bg-slate-50",
                    cfg?.closed && "bg-slate-200 text-slate-500",
                  )}
                >
                  {cfg?.closed ? "—" : `${have}/${need}`}
                </td>
              );
            })}
            <td className="cell-base bg-slate-50"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
