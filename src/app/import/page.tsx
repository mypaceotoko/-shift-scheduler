"use client";

import { useState } from "react";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import {
  applyImportedPreferences,
  importPreferencesFromBuffer,
  parseCellPreference,
  type ImportedPreferences,
} from "@/lib/excel";
import type { DayPreference } from "@/lib/types";

export default function ImportPage() {
  const { members, importState, schedule, shiftTypes, settings } = useAppStore();
  const [imported, setImported] = useState<ImportedPreferences | null>(null);
  const [defaultYear, setDefaultYear] = useState<number>(new Date().getFullYear());
  const [filename, setFilename] = useState<string>("");
  const [imageNote, setImageNote] = useState<string>("");
  const [addMissing, setAddMissing] = useState(true);

  async function onFile(file: File) {
    setFilename(file.name);
    const buf = await file.arrayBuffer();
    const result = importPreferencesFromBuffer(buf, defaultYear);
    setImported(result);
  }

  function applyToStore() {
    if (!imported) return;
    const next = applyImportedPreferences(members, imported, { addMissing });
    importState({
      members: next,
      shiftTypes,
      schedule,
      settings,
    });
    alert("希望表を反映しました。メンバー画面で確認できます。");
  }

  function updateCell(memberName: string, date: string, raw: string) {
    if (!imported) return;
    const pref: DayPreference = parseCellPreference(raw);
    const next = {
      ...imported,
      byMember: {
        ...imported.byMember,
        [memberName]: {
          ...(imported.byMember[memberName] ?? {}),
          [date]: pref,
        },
      },
    };
    next.uncertain = next.uncertain.filter((u) => !(u.member === memberName && u.date === date));
    if (pref.status === "uncertain") {
      next.uncertain.push({ member: memberName, date, raw });
    }
    setImported(next);
  }

  return (
    <div>
      <PageHeader
        title="希望表の読み取り"
        description="Excelファイルから希望表を読み込み、不確定なセルを修正します。画像はOCRが未実装のため、現状は手動補助として利用してください。"
      />

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Excel / CSV ファイル</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              className="text-sm"
            />
            <label className="text-xs text-slate-500">
              既定年:
              <input
                type="number"
                value={defaultYear}
                onChange={(e) => setDefaultYear(Number(e.target.value))}
                className="ml-1 w-20 rounded border border-slate-300 px-1"
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            1列目にメンバー名、ヘッダー行に日付（例: 2026-04-26 や 4/26）を含むシートを想定。
            空欄は「希望なし」、○は「出勤可」、／は「不可」、A〜F は固定シフト、13-18 などは時間帯指定として解釈します。
          </p>
          {filename && <p className="mt-2 text-xs text-slate-700">読み込み: {filename}</p>}
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">画像から希望表（β）</h3>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setImageNote(`「${f.name}」を選択。OCRは未実装のため、画像を見ながら下の表を直接編集してください。`);
            }}
            className="text-sm"
          />
          {imageNote && <p className="mt-2 text-xs text-slate-500">{imageNote}</p>}
          <p className="mt-2 text-xs text-slate-500">
            画像OCRは将来差し替え可能なように <code>parseCellPreference</code> を共通化しています。
            別エンジン（Tesseract.js / 外部API）を <code>src/lib/excel.ts</code> 同様の形で追加できます。
          </p>
        </div>
      </section>

      {imported && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-slate-700">読み取り結果</p>
              <p className="text-xs text-slate-500">
                日付 {imported.dates.length} 件 / メンバー {Object.keys(imported.byMember).length} 名
                {imported.uncertain.length > 0 && (
                  <span className="ml-2 text-amber-600">
                    要確認 {imported.uncertain.length} 件
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs">
                <input
                  type="checkbox"
                  checked={addMissing}
                  onChange={(e) => setAddMissing(e.target.checked)}
                />
                <span className="ml-1">名前が一致しないメンバーは新規追加</span>
              </label>
              <button
                onClick={applyToStore}
                className="rounded bg-brand-500 px-3 py-1.5 text-sm text-white hover:bg-brand-600"
              >
                メンバーに反映
              </button>
            </div>
          </div>

          {imported.warnings.length > 0 && (
            <ul className="mb-3 list-disc rounded bg-amber-50 px-6 py-2 text-xs text-amber-700">
              {imported.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="cell-base sticky left-0 bg-slate-50 text-left pl-2">メンバー</th>
                  {imported.dates.map((d) => (
                    <th key={d} className="cell-base">{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(imported.byMember).map(([name, prefs]) => (
                  <tr key={name}>
                    <td className="cell-base sticky left-0 bg-white text-left pl-2 font-medium">
                      {name}
                    </td>
                    {imported.dates.map((d) => {
                      const p = prefs[d];
                      return (
                        <td
                          key={d}
                          className={`cell-base p-0 ${
                            p?.status === "uncertain" ? "bg-amber-100" : ""
                          }`}
                        >
                          <input
                            defaultValue={p?.note ?? ""}
                            onBlur={(e) => updateCell(name, d, e.target.value)}
                            className="h-full w-full bg-transparent text-center text-xs outline-none"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
