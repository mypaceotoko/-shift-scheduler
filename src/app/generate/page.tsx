"use client";

import { useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import { generateSchedule, type GenerateWarning } from "@/lib/scheduler";
import { rangeISO } from "@/lib/dateUtils";

export default function GeneratePage() {
  const { members, shiftTypes, settings, schedule, setSchedule } = useAppStore();
  // Pick a sensible default period. Priority:
  // 1. existing schedule's period (user already configured it)
  // 2. the span of imported member preferences (matches OCR/Excel input)
  // 3. hard-coded fallback (shouldn't normally hit)
  const prefDates = members.flatMap((m) => Object.keys(m.preferences ?? {})).sort();
  const fallbackStart = prefDates[0] ?? "2026-04-26";
  const fallbackEnd = prefDates[prefDates.length - 1] ?? "2026-05-10";
  const [startDate, setStartDate] = useState(schedule?.startDate ?? fallbackStart);
  const [endDate, setEndDate] = useState(schedule?.endDate ?? fallbackEnd);
  const [warnings, setWarnings] = useState<GenerateWarning[]>([]);
  const [keepManual, setKeepManual] = useState(true);
  const [treatBlankAsAvailable, setTreatBlankAsAvailable] = useState(true);
  const [lastAssigned, setLastAssigned] = useState<number | null>(null);

  function run() {
    const result = generateSchedule({
      startDate,
      endDate,
      members,
      shiftTypes,
      settings,
      dayConfigs: schedule?.dayConfigs?.filter((d) => d.date >= startDate && d.date <= endDate),
      existing: keepManual ? schedule : null,
      treatBlankAsAvailable,
    });
    setSchedule(result.schedule);
    setWarnings(result.warnings);
    setLastAssigned(result.schedule.assignments.length);
  }

  const days = rangeISO(startDate, endDate);

  // Diagnostic: how many member-days inside the requested period have an
  // "available" / fixed / restricted preference? Helps users notice when the
  // OCR-imported preferences fall on a different month.
  const overlapCount = members.reduce((acc, m) => {
    let c = 0;
    for (const d of days) {
      const p = m.preferences?.[d];
      if (p?.status === "available" || p?.status === "fixed" || p?.status === "restricted") c++;
    }
    return acc + c;
  }, 0);
  const importedDateRange = prefDates.length > 0
    ? `${prefDates[0]} 〜 ${prefDates[prefDates.length - 1]}`
    : null;

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
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={treatBlankAsAvailable}
              onChange={(e) => setTreatBlankAsAvailable(e.target.checked)}
            />
            <span>
              空欄も候補にする
              <span className="ml-1 text-xs text-slate-500">（／・休 など明示の不可は除外）</span>
            </span>
          </label>
        </Field>
      </section>

      {members.length > 0 && overlapCount === 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">この期間に「希望」が0件です。</p>
          <p className="mt-1 text-xs">
            メンバーは {members.length} 名いますが、{startDate}〜{endDate} の範囲で
            「○ / 固定 / 時間帯」希望が見つかりません。
            {importedDateRange && (
              <>
                <br />
                取り込まれた希望表の日付範囲: <strong>{importedDateRange}</strong>
                — 期間が一致しているか確認してください。
              </>
            )}
            <br />
            「空欄も候補にする」をONにすれば、明示的に休のセル以外は出勤可とみなして埋めます。
          </p>
        </div>
      )}

      {members.length === 0 ? (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="mb-2 font-medium">メンバーがまだ登録されていません。</p>
          <p className="mb-3 text-xs">
            希望表（Excel・CSV・画像）を読み込めば、メンバーが自動で取り込まれます。手動で登録もできます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/import"
              className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
            >
              希望表を読み込む →
            </Link>
            <Link
              href="/members"
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              メンバー管理へ
            </Link>
          </div>
        </div>
      ) : (
        <div className="mb-6 flex gap-2">
          <button
            onClick={run}
            className="rounded bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            {schedule ? "再生成" : "生成する"}
          </button>
        </div>
      )}

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
          {lastAssigned === 0 && (
            <p className="mt-1 text-xs text-rose-600">
              0件しか入りませんでした。期間や希望表の日付、上の「空欄も候補にする」設定を見直してください。
            </p>
          )}
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
