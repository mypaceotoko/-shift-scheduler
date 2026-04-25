"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import {
  applyImportedPreferences,
  importPreferencesFromBuffer,
  parseCellPreference,
  type ImportedPreferences,
} from "@/lib/excel";
import { extractGridFromOcr, type OcrWord } from "@/lib/imageOcr";
import type { DayPreference } from "@/lib/types";

export default function ImportPage() {
  const router = useRouter();
  const { members, importState, schedule, shiftTypes, settings } = useAppStore();
  const [imported, setImported] = useState<ImportedPreferences | null>(null);
  const [defaultYear, setDefaultYear] = useState<number>(new Date().getFullYear());
  const [startMonth, setStartMonth] = useState<number>(new Date().getMonth() + 1);
  const [filename, setFilename] = useState<string>("");
  const [addMissing, setAddMissing] = useState(true);

  // Image OCR state
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrText, setOcrText] = useState<string>("");
  const [ocrError, setOcrError] = useState<string>("");
  const [ocrSummary, setOcrSummary] = useState<string>("");
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function onExcelFile(file: File) {
    setFilename(file.name);
    const buf = await file.arrayBuffer();
    const result = importPreferencesFromBuffer(buf, defaultYear);
    setImported(result);
  }

  function onImageFile(file: File) {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setImageUrl(url);
    setOcrText("");
    setOcrError("");
  }

  async function runOcr() {
    if (!imageUrl) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrError("");
    setOcrText("");
    setOcrSummary("");
    try {
      // Lazy-load tesseract to keep main bundle small.
      const Tesseract = (await import("tesseract.js")).default;
      const result = await Tesseract.recognize(imageUrl, "jpn+eng", {
        logger: (m) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      setOcrText(result.data.text || "");

      const words: OcrWord[] = (result.data.words ?? []).map((w) => ({
        text: String(w.text ?? "").trim(),
        bbox: w.bbox as { x0: number; y0: number; x1: number; y1: number },
        confidence: w.confidence,
      }));

      const grid = extractGridFromOcr(words, {
        startYear: defaultYear,
        startMonth,
      });
      if (grid) {
        const next: ImportedPreferences = {
          byMember: grid.preferences,
          dates: grid.dates,
          uncertain: [],
          warnings: grid.warnings,
        };
        for (const [name, prefs] of Object.entries(grid.preferences)) {
          for (const [date, pref] of Object.entries(prefs)) {
            if (pref.status === "uncertain") {
              next.uncertain.push({
                member: name,
                date,
                raw: grid.cells[name][date] ?? "",
              });
            }
          }
        }
        setImported(next);
        setOcrSummary(
          `画像から ${grid.members.length} 名 / ${grid.dates.length} 日分を構造化しました。下表で内容を修正できます。`,
        );
      } else {
        setOcrSummary(
          "表構造を自動検出できませんでした。生テキストを参考に、Excelで取り込むか下表を手動入力してください。",
        );
      }
    } catch (e) {
      setOcrError((e as Error).message);
    } finally {
      setOcrRunning(false);
    }
  }

  function applyToStore(navigateToGenerate = false) {
    if (!imported) return;
    const next = applyImportedPreferences(members, imported, { addMissing });
    importState({
      members: next,
      shiftTypes,
      schedule,
      settings,
    });
    if (navigateToGenerate) {
      router.push("/generate");
    } else {
      alert("希望表を反映しました。メンバー画面で確認できます。");
    }
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
        description="Excelから自動取り込み、または画像をプレビュー＋OCRで読み取って下表で修正します。空欄は「未提出 = シフトに入れない」、○は「希望提出 = 出勤可」、／は「不可」と解釈します。"
      />

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Excel / CSV ファイル</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => e.target.files?.[0] && onExcelFile(e.target.files[0])}
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
          </p>
          {filename && <p className="mt-2 text-xs text-slate-700">読み込み: {filename}</p>}
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">画像から読み取り</h3>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => e.target.files?.[0] && onImageFile(e.target.files[0])}
            className="text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <label>
              開始月:
              <input
                type="number"
                min={1}
                max={12}
                value={startMonth}
                onChange={(e) => setStartMonth(Number(e.target.value))}
                className="ml-1 w-16 rounded border border-slate-300 px-1"
              />
            </label>
            <label>
              年:
              <input
                type="number"
                value={defaultYear}
                onChange={(e) => setDefaultYear(Number(e.target.value))}
                className="ml-1 w-20 rounded border border-slate-300 px-1"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={runOcr}
              disabled={!imageUrl || ocrRunning}
              className="rounded bg-brand-500 px-3 py-1.5 text-xs text-white hover:bg-brand-600 disabled:bg-slate-300"
            >
              {ocrRunning ? `OCR 実行中… ${ocrProgress}%` : "OCR を実行 (jpn+eng)"}
            </button>
            <p className="text-xs text-slate-500">
              ※ 手書きの○や複雑な表は誤認識しやすいです。下表で修正してください。
            </p>
          </div>
          {ocrSummary && (
            <p className="mt-2 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
              {ocrSummary}
            </p>
          )}
          {ocrError && <p className="mt-2 text-xs text-rose-600">エラー: {ocrError}</p>}
        </div>
      </section>

      {imageUrl && (
        <section className="mb-6 rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">プレビュー</h3>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="希望表"
              className="max-h-[480px] w-full rounded border border-slate-200 object-contain"
            />
            <div className="overflow-auto">
              <h4 className="mb-1 text-xs font-semibold text-slate-600">OCR結果（生テキスト）</h4>
              <pre className="max-h-[480px] overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-tight text-slate-700">
                {ocrText || (ocrRunning ? "実行中…" : "未実行")}
              </pre>
            </div>
          </div>
        </section>
      )}

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
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs">
                <input
                  type="checkbox"
                  checked={addMissing}
                  onChange={(e) => setAddMissing(e.target.checked)}
                />
                <span className="ml-1">名前が一致しないメンバーは新規追加</span>
              </label>
              <button
                onClick={() => applyToStore(false)}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                メンバーに反映
              </button>
              <button
                onClick={() => applyToStore(true)}
                className="rounded bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
              >
                反映 → シフト生成へ
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
