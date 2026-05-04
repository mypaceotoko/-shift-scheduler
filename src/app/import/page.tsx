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
import { preprocessImageForOcr } from "@/lib/imagePreprocess";
import type { DayPreference } from "@/lib/types";

export default function ImportPage() {
  const router = useRouter();
  const { members, importState, schedule, shiftTypes, settings } = useAppStore();
  const [imported, setImported] = useState<ImportedPreferences | null>(null);
  // Default year/month from the existing schedule's startDate when present, so
  // the OCR/Excel date detection lands on the same period the user already
  // configured for shift generation. Otherwise fall back to today.
  const [defaultYear, setDefaultYear] = useState<number>(() =>
    schedule?.startDate ? Number(schedule.startDate.slice(0, 4)) : new Date().getFullYear(),
  );
  const [startMonth, setStartMonth] = useState<number>(() =>
    schedule?.startDate ? Number(schedule.startDate.slice(5, 7)) : new Date().getMonth() + 1,
  );
  // Range-based filter for imported preferences. Defaults to the existing
  // schedule's window (or the current month) so re-imports stay scoped to the
  // period the user is actually working on.
  const today = new Date();
  const monthStartIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const monthEndIso = (() => {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const [rangeStart, setRangeStart] = useState<string>(
    schedule?.startDate ?? monthStartIso,
  );
  const [rangeEnd, setRangeEnd] = useState<string>(
    schedule?.endDate ?? monthEndIso,
  );
  const [useRangeFilter, setUseRangeFilter] = useState<boolean>(true);
  // Cache the most recent file so changing the date range can re-run the
  // parser without forcing the user to re-pick the file.
  const [lastBuffer, setLastBuffer] = useState<ArrayBuffer | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [addMissing, setAddMissing] = useState(true);
  const [importError, setImportError] = useState<string>("");

  // Image OCR state
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStage, setOcrStage] = useState<string>("");
  const [ocrText, setOcrText] = useState<string>("");
  const [ocrError, setOcrError] = useState<string>("");
  const [ocrSummary, setOcrSummary] = useState<string>("");
  const [usePreprocess, setUsePreprocess] = useState(true);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function autoApply(result: ImportedPreferences) {
    if (result.dates.length === 0 || Object.keys(result.byMember).length === 0) return;
    const next = applyImportedPreferences(members, result, { addMissing: true });
    importState({ members: next, shiftTypes, schedule, settings });
  }

  function runParse(buf: ArrayBuffer) {
    const result = importPreferencesFromBuffer(buf, defaultYear, startMonth, {
      rangeStart: useRangeFilter ? rangeStart : undefined,
      rangeEnd: useRangeFilter ? rangeEnd : undefined,
    });
    setImported(result);
    // Auto-apply only when no out-of-range exclusions happened — otherwise the
    // user may want to confirm the window first via the review section.
    if (!result.excludedOutOfRange) autoApply(result);
  }

  async function onExcelFile(file: File) {
    setFilename(file.name);
    setImportError("");
    try {
      const buf = await file.arrayBuffer();
      setLastBuffer(buf);
      runParse(buf);
    } catch (e) {
      setImportError(`ファイルの読み込みに失敗しました: ${(e as Error).message}`);
    }
  }

  function reparseWithCurrentSettings() {
    if (!lastBuffer) return;
    setImportError("");
    try {
      runParse(lastBuffer);
    } catch (e) {
      setImportError(`再解析に失敗しました: ${(e as Error).message}`);
    }
  }

  function onImageFile(file: File) {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setImageUrl(url);
    setProcessedUrl(null);
    setOcrText("");
    setOcrError("");
  }

  async function runOcr() {
    if (!imageUrl) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrStage(usePreprocess ? "画像を前処理中…" : "OCRを準備中…");
    setOcrError("");
    setOcrText("");
    setOcrSummary("");
    try {
      // Step 1: optional image preprocessing (grayscale + contrast + binarization).
      let inputImage: string = imageUrl;
      if (usePreprocess) {
        try {
          inputImage = await preprocessImageForOcr(imageUrl);
          setProcessedUrl(inputImage);
        } catch (e) {
          // Fall back to the raw image rather than aborting.
          console.warn("Image preprocessing failed, falling back to raw image:", e);
          setProcessedUrl(null);
        }
      } else {
        setProcessedUrl(null);
      }

      setOcrStage("OCRを実行中…");
      // Lazy-load tesseract to keep main bundle small.
      const Tesseract = (await import("tesseract.js")).default;
      // Notes on Tesseract config:
      // - PSM (page segmentation mode) is left to the engine default (auto).
      //   PSM 6 ("uniform block") was tested but often fused an entire row of
      //   shift cells (e.g. ○○○○○○○) into one word whose bounding box covers
      //   the name column too — breaking name detection downstream.
      // - preserve_interword_spaces keeps space tokens between glyphs so that
      //   adjacent date cells stay distinguishable in the raw text output.
      const recognizeOptions = {
        logger: (m: { status: string; progress?: number }) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
        preserve_interword_spaces: "1",
      } as unknown as Parameters<typeof Tesseract.recognize>[2];
      const result = await Tesseract.recognize(inputImage, "jpn+eng", recognizeOptions);
      setOcrText(result.data.text || "");

      const words: OcrWord[] = (result.data.words ?? [])
        .map((w) => ({
          text: String(w.text ?? "").trim(),
          bbox: w.bbox as { x0: number; y0: number; x1: number; y1: number },
          confidence: w.confidence,
        }))
        // Drop the noisiest words — they typically come from grid ruling or
        // smudges and only confuse row/column clustering.
        .filter((w) => w.text.length > 0 && w.confidence >= 30);

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
        autoApply(next);
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
      setOcrStage("");
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

  /** Rename a member. Preserves the row order in the byMember record so the
   *  table doesn't reshuffle. No-op when the new name is empty or duplicated. */
  function renameMember(oldName: string, rawNew: string) {
    if (!imported) return;
    const newName = rawNew.trim();
    if (!newName || newName === oldName) return;
    if (imported.byMember[newName]) {
      alert(`メンバー名「${newName}」は既に存在します。`);
      return;
    }
    const nextByMember: Record<string, Record<string, DayPreference>> = {};
    for (const [n, prefs] of Object.entries(imported.byMember)) {
      nextByMember[n === oldName ? newName : n] = prefs;
    }
    setImported({
      ...imported,
      byMember: nextByMember,
      uncertain: imported.uncertain.map((u) =>
        u.member === oldName ? { ...u, member: newName } : u,
      ),
    });
  }

  function removeMember(name: string) {
    if (!imported) return;
    if (!confirm(`「${name}」を読み取り結果から削除しますか？\n（既にメンバー画面に反映済みの場合は、メンバー画面から別途削除してください）`)) return;
    const nextByMember = { ...imported.byMember };
    delete nextByMember[name];
    setImported({
      ...imported,
      byMember: nextByMember,
      uncertain: imported.uncertain.filter((u) => u.member !== name),
    });
  }

  function addMember() {
    if (!imported) return;
    let name = "新メンバー";
    let i = 2;
    while (imported.byMember[name]) {
      name = `新メンバー${i++}`;
    }
    const blankPrefs: Record<string, DayPreference> = {};
    for (const d of imported.dates) {
      blankPrefs[d] = { status: "unavailable", note: "" };
    }
    setImported({
      ...imported,
      byMember: { ...imported.byMember, [name]: blankPrefs },
    });
  }

  return (
    <div>
      <PageHeader
        title="希望表の読み取り"
        description="Excelから自動取り込み、または画像をプレビュー＋OCRで読み取って下表で修正します。空欄は「未提出 = シフトに入れない」、○は「希望提出 = 出勤可」、／は「不可」と解釈します。"
      />

      <section className="mb-4 rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">読み込み対象期間</h3>
          <label className="text-xs text-slate-600">
            <input
              type="checkbox"
              checked={useRangeFilter}
              onChange={(e) => setUseRangeFilter(e.target.checked)}
              className="mr-1"
            />
            この期間に絞り込む（範囲外のセルは除外）
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <label>
            開始日:
            <input
              type="date"
              value={rangeStart}
              disabled={!useRangeFilter}
              onChange={(e) => setRangeStart(e.target.value)}
              className="ml-1 rounded border border-slate-300 px-1"
            />
          </label>
          <label>
            終了日:
            <input
              type="date"
              value={rangeEnd}
              disabled={!useRangeFilter}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="ml-1 rounded border border-slate-300 px-1"
            />
          </label>
          {lastBuffer && (
            <button
              type="button"
              onClick={reparseWithCurrentSettings}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              現在のファイルで再解析
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          指定期間にあてはまる希望だけが取り込まれます。範囲外のセルは取り込まず、件数は下の確認パネルに表示されます。
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          ヒント: 期間を指定しておくと、Excelに月・年が無くても自動で正しい月・年に揃えて読み取ります（日付ずれを防止）。
        </p>
      </section>

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
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <label>
              年:
              <input
                type="number"
                value={defaultYear}
                onChange={(e) => setDefaultYear(Number(e.target.value))}
                className="ml-1 w-20 rounded border border-slate-300 px-1"
              />
            </label>
            <label>
              開始月:
              <input
                type="number"
                min={1}
                max={12}
                value={startMonth}
                onChange={(e) => setStartMonth(Number(e.target.value))}
                className="ml-1 w-14 rounded border border-slate-300 px-1"
              />
            </label>
            <span className="text-slate-400">（月見出し行が検出できない場合のフォールバック）</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            1列目にメンバー名、ヘッダー行に日付（例: 2026-04-26 や 4/26 や 4月）を含むシートを想定。
          </p>
          {filename && <p className="mt-2 text-xs text-slate-700">読み込み: {filename}</p>}
          {importError && <p className="mt-2 text-xs text-rose-600">{importError}</p>}
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={runOcr}
              disabled={!imageUrl || ocrRunning}
              className="rounded bg-brand-500 px-3 py-1.5 text-xs text-white hover:bg-brand-600 disabled:bg-slate-300"
            >
              {ocrRunning
                ? `${ocrStage || "OCR 実行中…"} ${ocrProgress}%`
                : "OCR を実行 (jpn+eng)"}
            </button>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={usePreprocess}
                onChange={(e) => setUsePreprocess(e.target.checked)}
              />
              画像を前処理（推奨）
            </label>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            ※ 前処理ではグレースケール化・コントラスト強調・二値化を行い、文字認識の精度を上げます。手書きの○や複雑な表は誤認識しやすいので下表で修正してください。
          </p>
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
            <div className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="希望表"
                className="max-h-[360px] w-full rounded border border-slate-200 object-contain"
              />
              {processedUrl && (
                <details className="text-xs text-slate-600">
                  <summary className="cursor-pointer">前処理後の画像（OCRに渡される画像）</summary>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={processedUrl}
                    alt="前処理後"
                    className="mt-1 max-h-[360px] w-full rounded border border-slate-200 object-contain"
                  />
                </details>
              )}
            </div>
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
          {/* Confirmation panel — surfaces what the parser actually understood
              before the user commits the import. */}
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">メンバー</div>
              <div className="text-base font-semibold text-slate-700">
                {Object.keys(imported.byMember).length}
              </div>
            </div>
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">日付</div>
              <div className="text-base font-semibold text-slate-700">{imported.dates.length}</div>
            </div>
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">希望(○/固定/時間帯)</div>
              <div className="text-base font-semibold text-emerald-600">
                {(imported.records ?? []).filter(
                  (r) =>
                    r.wishValue === "available" ||
                    r.wishValue === "fixed" ||
                    r.wishValue === "restricted",
                ).length}
              </div>
            </div>
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">要確認</div>
              <div className="text-base font-semibold text-amber-600">
                {imported.uncertain.length}
              </div>
            </div>
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">範囲外で除外</div>
              <div className="text-base font-semibold text-slate-500">
                {imported.excludedOutOfRange ?? 0}
              </div>
            </div>
            <div className="rounded border border-slate-200 px-2 py-1">
              <div className="text-[10px] uppercase text-slate-400">採用シート</div>
              <div
                className="truncate text-base font-semibold text-slate-700"
                title={`${imported.selectedSheet ?? "-"} (${imported.selectedStrategy ?? "-"})`}
              >
                {imported.selectedSheet ?? "-"}
              </div>
            </div>
          </div>

          {/* Show a low-confidence list separately so the user can scan
              suspicious cells without reading the whole table. */}
          {(imported.records ?? []).some((r) => r.confidence < 0.5) && (
            <details className="mb-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              <summary className="cursor-pointer">
                信頼度が低いセル（参考: {(imported.records ?? []).filter((r) => r.confidence < 0.5).length} 件）
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {(imported.records ?? [])
                  .filter((r) => r.confidence < 0.5)
                  .slice(0, 50)
                  .map((r, i) => (
                    <li key={`${r.sourceCell}-${i}`}>
                      {r.memberName} / {r.date} / 「{r.rawCell || "(空)"}」
                      {" "}<span className="text-slate-500">{r.sourceSheet}!{r.sourceCell}</span>
                    </li>
                  ))}
              </ul>
            </details>
          )}

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
              {imported.dates.length > 0 && Object.keys(imported.byMember).length > 0 && imported.excludedOutOfRange === 0 && (
                <p className="mt-1 text-xs text-emerald-600">メンバーに自動反映しました。修正後は「メンバーに反映」を再度押してください。</p>
              )}
              {(imported.excludedOutOfRange ?? 0) > 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  指定期間外のセルがあります — 内容を確認してから「メンバーに反映」を押してください。
                </p>
              )}
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

          <p className="mb-2 text-xs text-slate-500">
            メンバー名・セル内容はそのままクリックして編集できます（フォーカスを外すと確定）。
            行頭の <span className="text-rose-500">×</span> で行削除、表下の「+ メンバー追加」で行追加。
          </p>

          <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-emerald-300 bg-emerald-50" />
              出勤可 (○)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-blue-300 bg-blue-50" />
              固定シフト
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-indigo-300 bg-indigo-50" />
              時間帯指定
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-amber-300 bg-amber-100" />
              要確認
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-slate-200 bg-white" />
              不可・未提出
            </span>
          </div>

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
                    <td className="cell-base sticky left-0 bg-white text-left pl-1">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => removeMember(name)}
                          title="この行を削除"
                          aria-label={`${name} を削除`}
                          className="rounded px-1 text-rose-500 hover:bg-rose-50 hover:text-rose-700"
                        >
                          ×
                        </button>
                        <input
                          key={`name-${name}`}
                          defaultValue={name}
                          onBlur={(e) => renameMember(name, e.target.value)}
                          className="w-24 rounded border border-transparent bg-transparent px-1 font-medium outline-none focus:border-slate-300 focus:bg-white"
                        />
                      </div>
                    </td>
                    {imported.dates.map((d) => {
                      const p = prefs[d];
                      const bg =
                        p?.status === "available"
                          ? "bg-emerald-50"
                          : p?.status === "fixed"
                            ? "bg-blue-50"
                            : p?.status === "restricted"
                              ? "bg-indigo-50"
                              : p?.status === "uncertain"
                                ? "bg-amber-100"
                                : "";
                      return (
                        <td key={d} className={`cell-base p-0 ${bg}`}>
                          <input
                            key={`${name}-${d}`}
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

          <div className="mt-2">
            <button
              type="button"
              onClick={addMember}
              className="rounded border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-600 hover:border-slate-400 hover:bg-slate-50"
            >
              + メンバー追加
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
