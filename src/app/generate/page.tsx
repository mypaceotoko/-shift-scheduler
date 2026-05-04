"use client";

import { useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import { generateSchedule, type GenerateWarning } from "@/lib/scheduler";
import { rangeISO } from "@/lib/dateUtils";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function GeneratePage() {
  const {
    members,
    shiftTypes,
    settings,
    schedule,
    setSchedule,
    setSettings,
    learnedPatterns,
    clearLearnedPatterns,
  } = useAppStore();
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
      learnedPatterns,
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

  // Rules editor: edits update settings on blur. All fields persist via the
  // Zustand `persist` middleware, so changes carry over to next sessions and
  // future generations.
  function patchSettings(patch: Partial<typeof settings>) {
    setSettings({ ...settings, ...patch });
  }

  function setWeekdayCount(weekday: number, count: number) {
    const next = settings.requiredByWeekday.map((r) =>
      r.weekday === weekday ? { ...r, count } : r,
    );
    patchSettings({ requiredByWeekday: next });
  }

  function setMemberTarget(name: string, target: number) {
    const next = { ...(settings.memberTargets ?? {}) };
    if (Number.isFinite(target) && target > 0) next[name] = target;
    else delete next[name];
    patchSettings({ memberTargets: next });
  }

  function removeMemberTarget(name: string) {
    const next = { ...(settings.memberTargets ?? {}) };
    delete next[name];
    patchSettings({ memberTargets: next });
  }

  function addMemberTarget() {
    const name = prompt("対象メンバー名（姓だけでも可）を入力してください");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const target = Number(prompt("月間目安日数を入力してください", "10") ?? "0");
    if (!Number.isFinite(target) || target <= 0) return;
    setMemberTarget(trimmed, target);
  }

  return (
    <div>
      <PageHeader
        title="シフト生成"
        description="期間と必要人数を指定して、自動でシフト案を作成します。手動編集した枠は維持できます。"
      />

      <section className="mb-6 rounded-md border border-slate-200 bg-white">
        <details open>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            ハウスルール / 適用条件
            <span className="ml-2 text-xs font-normal text-slate-500">
              ここで編集した内容は保存され、次回以降の自動生成に反映されます
            </span>
          </summary>
          <div className="space-y-5 border-t border-slate-200 px-4 py-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                ルールメモ (自由記述・人間用)
              </label>
              <textarea
                key={settings.houseRules ?? ""}
                defaultValue={settings.houseRules ?? ""}
                onBlur={(e) => patchSettings({ houseRules: e.target.value })}
                rows={8}
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs leading-relaxed text-slate-700"
                placeholder={"例: 朝はB番スタート、19時以降1人OK..."}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                ※ メモ自体はそのまま保存されます。実際の自動生成に効くのは下の構造化された設定です。
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                1日の最大人数 (曜日別)
              </label>
              <div className="grid grid-cols-7 gap-1 text-center text-xs">
                {WEEKDAY_LABELS.map((lbl, i) => {
                  const rule = settings.requiredByWeekday.find((r) => r.weekday === i);
                  return (
                    <label key={i} className="block">
                      <span className={`block text-[10px] ${i === 0 || i === 6 ? "text-rose-500" : "text-slate-500"}`}>
                        {lbl}
                      </span>
                      <input
                        type="number"
                        step="0.5"
                        min={0}
                        max={20}
                        defaultValue={rule?.count ?? 4}
                        onBlur={(e) => setWeekdayCount(i, Number(e.target.value))}
                        className="w-full rounded border border-slate-300 px-1 py-0.5 text-center text-xs"
                      />
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                例: 火水木金=3, 月土日=3.5(6h枠あり)
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  朝のオープニングシフト
                </label>
                <select
                  value={settings.morningShiftCode ?? "B"}
                  onChange={(e) => patchSettings({ morningShiftCode: e.target.value })}
                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                >
                  {shiftTypes
                    .filter((s) => !s.isOff && s.countAs >= 1)
                    .map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  選択コードを各メンバーの優先候補シフトに置く（例: B = 10:00 開店）
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  既定の最大連勤 / 週上限
                </label>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">最大連勤</span>
                  <input
                    type="number"
                    min={1}
                    max={14}
                    defaultValue={settings.defaultMaxConsecutive}
                    onBlur={(e) => patchSettings({ defaultMaxConsecutive: Number(e.target.value) })}
                    className="w-14 rounded border border-slate-300 px-1 py-0.5 text-center"
                  />
                  <span className="text-slate-500">日</span>
                  <span className="ml-3 text-slate-500">週上限</span>
                  <input
                    type="number"
                    min={1}
                    max={7}
                    defaultValue={settings.defaultMaxPerWeek}
                    onBlur={(e) => patchSettings({ defaultMaxPerWeek: Number(e.target.value) })}
                    className="w-14 rounded border border-slate-300 px-1 py-0.5 text-center"
                  />
                  <span className="text-slate-500">日</span>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs font-medium text-slate-600">
                  メンバー別 月間目安日数 (優先順位の根拠)
                </label>
                <button
                  type="button"
                  onClick={addMemberTarget}
                  className="rounded border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  + 追加
                </button>
              </div>
              <div className="space-y-1">
                {Object.entries(settings.memberTargets ?? {}).length === 0 && (
                  <p className="text-[11px] text-slate-400">
                    まだ目安が設定されていません。「+ 追加」または個別メンバー名を入力。
                  </p>
                )}
                {Object.entries(settings.memberTargets ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, target]) => (
                    <div key={name} className="flex items-center gap-2 text-xs">
                      <span className="w-24 truncate">{name}</span>
                      <input
                        type="number"
                        min={0}
                        max={31}
                        defaultValue={target}
                        onBlur={(e) => setMemberTarget(name, Number(e.target.value))}
                        className="w-16 rounded border border-slate-300 px-1 py-0.5 text-center"
                      />
                      <span className="text-slate-500">日 / 月</span>
                      <button
                        type="button"
                        onClick={() => removeMemberTarget(name)}
                        title="削除"
                        className="ml-2 rounded px-1 text-rose-500 hover:bg-rose-50 hover:text-rose-700"
                      >
                        ×
                      </button>
                    </div>
                  ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                目安より少ないメンバーが優先的に割り当てられます。姓だけ (例: 鈴木) でも、フルネーム (鈴木 絢也) と一致します。
              </p>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-slate-700">
                    手動編集の学習パターン
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    シフト確認画面でセルを編集/削除すると、(メンバー × 曜日 × コード) の傾向が
                    自動で記録され、次回の自動生成でソフトに反映されます。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("学習した手動編集パターンを全て消去します。よろしいですか？")) {
                      clearLearnedPatterns();
                    }
                  }}
                  className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-rose-50 hover:text-rose-700"
                >
                  パターンをクリア
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-600 sm:grid-cols-4">
                <div>
                  <span className="text-slate-500">学習イベント数</span>
                  <div className="font-medium">{learnedPatterns?.totalEvents ?? 0} 件</div>
                </div>
                <div>
                  <span className="text-slate-500">対象メンバー</span>
                  <div className="font-medium">
                    {Object.keys(learnedPatterns?.memberDayCode ?? {}).length} 名
                  </div>
                </div>
                <div>
                  <span className="text-slate-500">最終更新</span>
                  <div className="font-medium">
                    {learnedPatterns?.updatedAt
                      ? new Date(learnedPatterns.updatedAt).toLocaleString("ja-JP")
                      : "—"}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500">影響度</span>
                  <div className="font-medium">弱バイアス（既存ルール優先）</div>
                </div>
              </div>
            </div>
          </div>
        </details>
      </section>

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
