"use client";

import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import type { ShiftType } from "@/lib/types";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function SettingsPage() {
  const { settings, setSettings, shiftTypes, setShiftTypes, resetAll } = useAppStore();

  function setRequiredCount(weekday: number, count: number) {
    setSettings({
      ...settings,
      requiredByWeekday: settings.requiredByWeekday.map((r) =>
        r.weekday === weekday ? { ...r, count } : r,
      ),
    });
  }

  function updateShift(idx: number, patch: Partial<ShiftType>) {
    setShiftTypes(shiftTypes.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function addShift() {
    setShiftTypes([
      ...shiftTypes,
      { code: "X", label: "新規シフト", start: "10:00", end: "19:00", countAs: 1 },
    ]);
  }
  function removeShift(idx: number) {
    setShiftTypes(shiftTypes.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <PageHeader
        title="設定"
        description="必要人数ルール、シフト種別、各種既定値を編集します。"
      />

      <section className="mb-6 rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">曜日別の必要人数</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-7">
          {settings.requiredByWeekday.map((r) => (
            <label key={r.weekday} className="text-sm">
              <span className="mb-1 block text-xs text-slate-500">
                {WEEKDAY_LABELS[r.weekday]}
              </span>
              <input
                type="number"
                step="0.5"
                value={r.count}
                onChange={(e) => setRequiredCount(r.weekday, Number(e.target.value))}
                className="w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">既定値</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">最大連勤数</span>
            <input
              type="number"
              value={settings.defaultMaxConsecutive}
              onChange={(e) =>
                setSettings({ ...settings, defaultMaxConsecutive: Number(e.target.value) })
              }
              className="w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">週あたり最大出勤数</span>
            <input
              type="number"
              value={settings.defaultMaxPerWeek}
              onChange={(e) =>
                setSettings({ ...settings, defaultMaxPerWeek: Number(e.target.value) })
              }
              className="w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.balanceWorkload}
              onChange={(e) => setSettings({ ...settings, balanceWorkload: e.target.checked })}
            />
            <span>勤務回数を均等化</span>
          </label>
        </div>
      </section>

      <section className="mb-6 rounded-md border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">シフト種別</h3>
          <button onClick={addShift} className="rounded bg-brand-500 px-3 py-1 text-xs text-white">
            追加
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-1 text-left">コード</th>
              <th className="py-1 text-left">ラベル</th>
              <th className="py-1 text-left">開始</th>
              <th className="py-1 text-left">終了</th>
              <th className="py-1 text-left">重み</th>
              <th className="py-1 text-left">休</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shiftTypes.map((s, idx) => (
              <tr key={idx} className="border-t border-slate-100">
                <td className="py-1">
                  <input
                    value={s.code}
                    onChange={(e) => updateShift(idx, { code: e.target.value })}
                    className="w-16 rounded border border-slate-300 px-1"
                  />
                </td>
                <td className="py-1">
                  <input
                    value={s.label}
                    onChange={(e) => updateShift(idx, { label: e.target.value })}
                    className="w-full rounded border border-slate-300 px-1"
                  />
                </td>
                <td className="py-1">
                  <input
                    value={s.start}
                    onChange={(e) => updateShift(idx, { start: e.target.value })}
                    className="w-20 rounded border border-slate-300 px-1"
                  />
                </td>
                <td className="py-1">
                  <input
                    value={s.end}
                    onChange={(e) => updateShift(idx, { end: e.target.value })}
                    className="w-20 rounded border border-slate-300 px-1"
                  />
                </td>
                <td className="py-1">
                  <input
                    type="number"
                    step="0.5"
                    value={s.countAs}
                    onChange={(e) => updateShift(idx, { countAs: Number(e.target.value) })}
                    className="w-16 rounded border border-slate-300 px-1"
                  />
                </td>
                <td className="py-1">
                  <input
                    type="checkbox"
                    checked={!!s.isOff}
                    onChange={(e) => updateShift(idx, { isOff: e.target.checked })}
                  />
                </td>
                <td className="py-1 text-right">
                  <button
                    onClick={() => removeShift(idx)}
                    className="text-xs text-rose-600 hover:underline"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-rose-200 bg-rose-50 p-4">
        <h3 className="mb-2 text-sm font-semibold text-rose-700">危険操作</h3>
        <button
          onClick={() => {
            if (confirm("全データを初期化します。よろしいですか?")) resetAll();
          }}
          className="rounded bg-rose-500 px-3 py-1.5 text-sm text-white hover:bg-rose-600"
        >
          全データを初期化
        </button>
      </section>
    </div>
  );
}
