import type { DayPreference } from "./types";
import { parseCellPreference } from "./excel";

/** A single recognized word from Tesseract with spatial coordinates. */
export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface ExtractedGrid {
  dates: string[];
  members: string[];
  /** member name -> date -> raw cell text */
  cells: Record<string, Record<string, string>>;
  /** member name -> date -> parsed preference */
  preferences: Record<string, Record<string, DayPreference>>;
  warnings: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function centerY(w: OcrWord): number {
  return (w.bbox.y0 + w.bbox.y1) / 2;
}

function centerX(w: OcrWord): number {
  return (w.bbox.x0 + w.bbox.x1) / 2;
}

/** Group OCR words into rows by clustering on Y center. */
function groupByRow(words: OcrWord[], yTolerance = 18): OcrWord[][] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rows: OcrWord[][] = [];
  for (const w of sorted) {
    const cy = centerY(w);
    let placed = false;
    for (const row of rows) {
      const rowMid =
        row.reduce((s, x) => s + centerY(x), 0) / row.length;
      if (Math.abs(cy - rowMid) < yTolerance) {
        row.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([w]);
  }
  for (const r of rows) r.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return rows;
}

/** Reconstruct a member×date grid from raw OCR words.
 *  Returns null if the table structure cannot be detected. */
export function extractGridFromOcr(
  words: OcrWord[],
  options: { startYear: number; startMonth: number },
): ExtractedGrid | null {
  if (words.length < 10) return null;

  const rows = groupByRow(words);

  // Locate the header row: the row with the most distinct day-of-month numbers (1-31).
  let headerIdx = -1;
  let bestDateCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const count = rows[i].filter((w) => {
      const t = w.text.trim();
      if (!/^\d{1,2}$/.test(t)) return false;
      const n = Number(t);
      return n >= 1 && n <= 31;
    }).length;
    if (count > bestDateCount) {
      bestDateCount = count;
      headerIdx = i;
    }
  }
  if (headerIdx < 0 || bestDateCount < 5) return null;

  // Extract date columns from the header row.
  const headerWords = rows[headerIdx]
    .filter((w) => /^\d{1,2}$/.test(w.text))
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);

  let curYear = options.startYear;
  let curMonth = options.startMonth;
  let prevDay = 0;
  const dateColumns: { iso: string; x0: number; x1: number; cx: number }[] = [];
  for (const w of headerWords) {
    const day = Number(w.text);
    if (prevDay > 0 && day < prevDay - 5) {
      // Day number dropped sharply → new month begins.
      if (curMonth === 12) {
        curMonth = 1;
        curYear += 1;
      } else {
        curMonth += 1;
      }
    }
    const iso = `${curYear}-${pad2(curMonth)}-${pad2(day)}`;
    dateColumns.push({
      iso,
      x0: w.bbox.x0,
      x1: w.bbox.x1,
      cx: centerX(w),
    });
    prevDay = day;
  }

  // Estimate column boundaries midway between adjacent header word centers.
  const colBounds: { start: number; end: number; iso: string }[] = [];
  for (let i = 0; i < dateColumns.length; i++) {
    const cx = dateColumns[i].cx;
    const prev = i > 0 ? dateColumns[i - 1].cx : cx - 40;
    const next = i < dateColumns.length - 1 ? dateColumns[i + 1].cx : cx + 40;
    colBounds.push({
      start: (prev + cx) / 2,
      end: (cx + next) / 2,
      iso: dateColumns[i].iso,
    });
  }

  const firstColX = dateColumns[0].x0 - 5;

  // Member rows are rows below the header whose leftmost cluster contains kanji/kana.
  const memberRows: { name: string; words: OcrWord[] }[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const leftWords = row.filter((w) => w.bbox.x1 <= firstColX + 10);
    if (leftWords.length === 0) continue;
    const name = leftWords.map((w) => w.text).join(" ").trim();
    if (!name) continue;
    if (!/[぀-ヿ一-龯]/.test(name)) continue;
    if (/(出勤人数|合計|メンバー|イベント|WEEK|DATE)/.test(name)) continue;
    memberRows.push({ name, words: row });
  }
  if (memberRows.length === 0) return null;

  const cells: Record<string, Record<string, string>> = {};
  const preferences: Record<string, Record<string, DayPreference>> = {};
  for (const m of memberRows) {
    cells[m.name] = {};
    preferences[m.name] = {};
    for (const col of colBounds) {
      const inCell = m.words.filter((w) => {
        const cx = centerX(w);
        return cx >= col.start && cx < col.end;
      });
      const raw = inCell.map((w) => w.text).join(" ").trim();
      cells[m.name][col.iso] = raw;
      preferences[m.name][col.iso] = parseCellPreference(raw);
    }
  }

  return {
    dates: dateColumns.map((d) => d.iso),
    members: memberRows.map((m) => m.name),
    cells,
    preferences,
    warnings:
      bestDateCount < dateColumns.length
        ? [`日付ヘッダーの一部が認識できませんでした (${bestDateCount} 列)`]
        : [],
  };
}
