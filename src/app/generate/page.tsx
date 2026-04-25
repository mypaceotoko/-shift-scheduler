"use client";

import { useState } from "react";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import { generateSchedule, type GenerateWarning } from "@/lib/scheduler";
import { rangeISO } from "@/lib/dateUtils";

export default function GeneratePage() {
  const { members, shiftTypes, settings, schedule, setSchedule } = useAppStore();
  const [startDate, setStartDate] = useState(schedule?.startDate ?? "2026-04-26");
  const [endDate, setEndDate] = useState(schedule?.endDate ?? "2026-05-10");
  const [warnings, setWarnings] = useState<GenerateWarning[]>([]);
  const [keepManual, setKeepManual] = useState(true);

  function run() {
    const result = generateSchedule({
      startDate,
      endDate,
      members,
      shiftTypes,
      settings,
      dayConfigs: schedule?.dayConfigs?.filter((d) => d.date >= startDate && d.date <= endDate),
      existing: keepManual ? schedule : null,
    });
    setSchedule(result.schedule);
    setWarnings(result.warnings);
  }

  const days = rangeISO(startDate, endDate);

  return (
    <div>
      <PageHeader
        title="シフト生成"
        description="期間と必要人数を指定して、自動でシフト案を作成します。手動編集した枠は維持できます。"
      />

      <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Field label="開始日">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="終了日">
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="期間">
          <p className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-sm">{days.length} 日間</p>
        </Field>
        <Field label="オプション">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepManual}
              onChange={(e) => setKeepManual(e.target.checked)}
            />
            手動編集を維持して再計算
          </label>
        </Field>
      </section>

      <div className="mb-6 flex gap-2">
        <button
          onClick={run}
          disabled={members.length === 0}
          className="rounded bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:bg-slate-300"
        >
          {schedule ? "再生成" : "生成する"}
        </button>
        {members.length === 0 && (
          <p className="text-xs text-slate-500">先にメンバーを登録してください。</p>
        )}
      </div>

      {warnings.length > 0 && (
        <section className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <h3 className="mb-2 font-semibold">警告 ({warnings.length} 件)</h3>
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.date}: {w.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {schedule && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <p className="text-sm">
            生成済み: {schedule.assignments.length} 件 / 期間 {schedule.startDate} - {schedule.endDate}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            「シフト確認・編集」画面でカレンダー表示・調整ができます。
          </p>
        </section>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
