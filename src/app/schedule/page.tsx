"use client";

import { useState } from "react";
import PageHeader from "@/components/PageHeader";
import ScheduleGrid from "@/components/ScheduleGrid";
import { useAppStore } from "@/lib/store";
import { computeStats, dailyHeadcount } from "@/lib/scheduler";
import { rangeISO } from "@/lib/dateUtils";

type ViewMode = "by-member" | "by-date";

export default function SchedulePage() {
  const { schedule, members, shiftTypes } = useAppStore();
  const [view, setView] = useState<ViewMode>("by-member");

  if (!schedule) {
    return (
      <div>
        <PageHeader title="シフト確認・編集" />
        <p className="text-sm text-slate-500">
          まだシフトが生成されていません。「シフト生成」画面から作成してください。
        </p>
      </div>
    );
  }

  const stats = computeStats(schedule, shiftTypes);

  return (
    <div>
      <PageHeader
        title="シフト確認・編集"
        description="セルをクリックして直接編集できます。空欄を選ぶと割り当てを解除します。"
        action={
          <div className="flex rounded border border-slate-300 text-sm">
            <button
              className={`px-3 py-1 ${view === "by-member" ? "bg-brand-500 text-white" : "bg-white"}`}
              onClick={() => setView("by-member")}
            >
              メンバー別
            </button>
            <button
              className={`px-3 py-1 ${view === "by-date" ? "bg-brand-500 text-white" : "bg-white"}`}
              onClick={() => setView("by-date")}
            >
              日付別
            </button>
          </div>
        }
      />

      {view === "by-member" ? (
        <ScheduleGrid />
      ) : (
        <DayView />
      )}

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">メンバー別合計</h3>
          <table className="w-full text-sm">
            <tbody>
              {members.map((m) => {
                const s = stats.find((x) => x.memberId === m.id);
                return (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="py-1">{m.name}</td>
                    <td className="py-1 text-right">{s?.totalCount ?? 0} 日</td>
                    <td className="py-1 text-right text-slate-500">
                      重み {s?.weightedTotal ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">日別合計（不足日強調）</h3>
          <ul className="text-sm">
            {schedule.dayConfigs.map((cfg) => {
              const have = dailyHeadcount(schedule, shiftTypes, cfg.date);
              const short = !cfg.closed && have + 1e-9 < cfg.requiredCount;
              return (
                <li
                  key={cfg.date}
                  className={`flex justify-between border-t border-slate-100 py-1 ${
                    short ? "text-rose-700" : ""
                  }`}
                >
                  <span>{cfg.date}</span>
                  <span>
                    {cfg.closed ? "休館日" : `${have} / ${cfg.requiredCount}`}
                    {short ? " (不足)" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}

function DayView() {
  const { schedule, members, shiftTypes } = useAppStore();
  if (!schedule) return null;
  const dates = rangeISO(schedule.startDate, schedule.endDate);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {dates.map((d) => {
        const cfg = schedule.dayConfigs.find((x) => x.date === d);
        const items = schedule.assignments
          .filter((a) => a.date === d)
          .map((a) => ({ ...a, name: members.find((m) => m.id === a.memberId)?.name ?? "?" }))
          .sort((a, b) => a.shiftCode.localeCompare(b.shiftCode));
        const have = dailyHeadcount(schedule, shiftTypes, d);
        const need = cfg?.requiredCount ?? 0;
        const short = !cfg?.closed && have + 1e-9 < need;
        return (
          <div
            key={d}
            className={`rounded-md border p-3 ${
              short ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="mb-2 flex justify-between">
              <p className="text-sm font-semibold">{d}</p>
              <p className="text-xs text-slate-500">
                {cfg?.closed ? "休館日" : `${have}/${need}`}
              </p>
            </div>
            {cfg?.events.length ? (
              <p className="mb-1 text-xs text-rose-600">{cfg.events.join(" / ")}</p>
            ) : null}
            <ul className="text-sm">
              {items.length === 0 ? (
                <li className="text-xs text-slate-400">割り当てなし</li>
              ) : (
                items.map((a) => (
                  <li key={`${a.date}-${a.memberId}`} className="flex justify-between">
                    <span>{a.name}</span>
                    <span className="text-xs text-slate-500">
                      {a.customRange
                        ? `${a.customRange.start}-${a.customRange.end}`
                        : a.shiftCode}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
