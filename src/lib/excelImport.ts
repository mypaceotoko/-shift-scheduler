/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Robust Excel preference-table importer.
 *
 * Goals (vs. the legacy single-sheet, single-strategy parser):
 *  - Scan every sheet, pick the one most likely to be a shift-preference table.
 *  - Try multiple table-detection strategies and pick the highest-scoring result.
 *  - Tolerate merged cells, blank rows/columns, decorative columns, and header
 *    rows that aren't on row 1.
 *  - Normalize cell text (full/half-width, dashes, circle glyphs, slashes,
 *    common Japanese shift symbols) before interpretation.
 *  - Accept multi-piece cells like "○ 13-18" or "B 短縮".
 *  - Optionally clip output to a user-chosen [startDate, endDate] window and
 *    report how many rows were dropped because they fell outside it.
 *  - Return both the legacy member→date→preference map and a flat normalized
 *    record list (one record per (member, date) cell) so downstream UI can
 *    show confidence, source sheet, and source cell to the user.
 */

import * as XLSX from "xlsx";
import type { DayPreference } from "./types";
import { parseCellPreference } from "./cellParser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single normalized preference record extracted from a cell. */
export interface PreferenceRecord {
  memberName: string;
  /** ISO date "YYYY-MM-DD". */
  date: string;
  /** Shift-type code like "B", "T" when the cell contained a fixed code. */
  shiftType: string | null;
  /** The wish marker the cell expressed: "available" / "unavailable" /
   *  "fixed" / "restricted" / "uncertain" — same as DayPreferenceStatus. */
  wishValue: string | null;
  /** Restricted custom range (HH:mm) or null. */
  startTime: string | null;
  endTime: string | null;
  /** Original cell value, before normalization. */
  rawCell: string;
  /** Sheet the cell came from. */
  sourceSheet: string;
  /** A1-style reference (e.g. "C7") or "row,col" if uncomputable. */
  sourceCell: string;
  /** 0..1; lower means the parser is less sure about its interpretation. */
  confidence: number;
}

export interface ImportOptions {
  /** Year to assume when the header has month/day only (e.g. "4/26"). */
  defaultYear: number;
  /** Month to assume when the header has only a day number and no "X月" row.
   *  Used as a starting month; auto-increments when day numbers wrap. */
  startMonth?: number;
  /** Inclusive start of the wanted period (ISO date). Out-of-range cells are
   *  dropped and counted in `excludedOutOfRange`. */
  rangeStart?: string;
  /** Inclusive end of the wanted period (ISO date). */
  rangeEnd?: string;
}

export interface ImportResult {
  records: PreferenceRecord[];
  /** Member name -> dateISO -> preference. Same shape as legacy importer. */
  byMember: Record<string, Record<string, DayPreference>>;
  /** Distinct dates that survived range filtering, sorted ascending. */
  dates: string[];
  /** Distinct member names, in extraction order. */
  members: string[];
  /** Cells the parser couldn't confidently interpret. */
  uncertain: { member: string; date: string; raw: string; sourceCell: string }[];
  /** Per-sheet diagnostic info — sheets considered and their scores. */
  diagnostics: {
    sheet: string;
    strategy: string;
    score: number;
    members: number;
    dates: number;
    parsed: number;
    uncertain: number;
  }[];
  /** Sheet finally selected. */
  selectedSheet: string | null;
  /** Strategy used on the selected sheet. */
  selectedStrategy: string | null;
  /** Records that fell outside [rangeStart, rangeEnd]. */
  excludedOutOfRange: number;
  /** Soft warnings (non-fatal). */
  warnings: string[];
  /** Hard errors (fatal — but other sheets/data still returned). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Cell normalization (extended set of synonyms beyond parseCellPreference)
// ---------------------------------------------------------------------------

/** Normalize a cell value's outer form: full-width → ASCII, dash variants,
 *  circle variants, slashes, NBSP/全角 spaces, etc. Does NOT change semantics —
 *  downstream code still needs to inspect the result. */
export function normalizeCellText(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[　 ]/g, " ") // 全角space, NBSP
    .replace(/[‐‑‒–—―ー−ｰ]/g, "-")
    .replace(/[〜～]/g, "~")
    .replace(/[：﹕]/g, ":")
    .replace(/[◯〇⚪⭕◦●∘⊙◎○]/g, "○")
    .replace(/[／⁄∕]/g, "/")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Synonym map for whole-cell single-token preference markers.
 *  Returned status mirrors DayPreferenceStatus; "code:X" means "treat as
 *  fixed shift code X"; "time:HH-HH" means restricted range. */
const SINGLE_TOKEN_SYNONYMS: Record<string, string> = {
  // available
  "○": "available",
  "可": "available",
  "出": "available",
  "出勤": "available",
  "OK": "available",
  "ok": "available",
  // unavailable
  "/": "unavailable",
  "x": "unavailable",
  "X": "unavailable",
  "✕": "unavailable",
  "×": "unavailable",
  "休": "unavailable",
  "公休": "unavailable",
  "OFF": "unavailable",
  "off": "unavailable",
  "不可": "unavailable",
  "NG": "unavailable",
  "ng": "unavailable",
  "-": "unavailable",
  // restricted shorthands. We translate to a representative range; the user
  // can refine in the review UI. These match common Japanese shift sheets.
  "早": "time:09:00-13:00",
  "遅": "time:13:00-22:00",
  "夜": "time:18:00-23:00",
  "AM": "time:09:00-13:00",
  "am": "time:09:00-13:00",
  "PM": "time:13:00-18:00",
  "pm": "time:13:00-18:00",
  // ambiguous — keep but lower confidence
  "△": "uncertain",
  "▲": "uncertain",
  "?": "uncertain",
  "？": "uncertain",
};

/** Parse a possibly-multi-token cell into a single DayPreference plus
 *  confidence. We split on common separators and pick the most informative
 *  token (time-range > shift code > availability marker > uncertain). */
export function parseCellAdvanced(raw: unknown): {
  pref: DayPreference;
  confidence: number;
} {
  const original = String(raw ?? "");
  const text = normalizeCellText(original);
  if (!text) {
    return { pref: { status: "unavailable", note: "" }, confidence: 1 };
  }

  // Single-token fast path through the synonym map (case-sensitive then -insensitive).
  const direct = SINGLE_TOKEN_SYNONYMS[text] ?? SINGLE_TOKEN_SYNONYMS[text.toLowerCase()];
  if (direct) {
    return synonymToPref(direct, original);
  }

  // Try splitting on whitespace / common separators and parsing each piece.
  const tokens = text.split(/[\s,、。]+/).filter(Boolean);
  if (tokens.length > 1) {
    const parsedTokens = tokens.map((t) => {
      const syn = SINGLE_TOKEN_SYNONYMS[t] ?? SINGLE_TOKEN_SYNONYMS[t.toLowerCase()];
      if (syn) return synonymToPref(syn, t).pref;
      return parseCellPreference(t);
    });
    // Rank: restricted > fixed > available > unavailable > uncertain.
    // We want the most specific signal to win — e.g. "○ 13-18" → restricted.
    const rank: Record<string, number> = {
      restricted: 5,
      fixed: 4,
      available: 3,
      unavailable: 2,
      uncertain: 1,
    };
    let best: DayPreference = parsedTokens[0];
    for (const p of parsedTokens) {
      if ((rank[p.status] ?? 0) > (rank[best.status] ?? 0)) best = p;
    }
    // Lower confidence when we had to mediate between conflicting tokens.
    const distinct = new Set(parsedTokens.map((p) => p.status));
    const confidence = distinct.size > 1 ? 0.6 : 0.9;
    return { pref: { ...best, note: original.trim() }, confidence };
  }

  // Fall back to the legacy single-cell parser.
  const pref = parseCellPreference(original);
  const confidence = pref.status === "uncertain" ? 0.2 : 0.85;
  return { pref, confidence };
}

function synonymToPref(
  syn: string,
  original: string,
): { pref: DayPreference; confidence: number } {
  if (syn === "available") {
    return { pref: { status: "available", note: original }, confidence: 0.95 };
  }
  if (syn === "unavailable") {
    return { pref: { status: "unavailable", note: original }, confidence: 0.95 };
  }
  if (syn === "uncertain") {
    return { pref: { status: "uncertain", note: original }, confidence: 0.3 };
  }
  if (syn.startsWith("time:")) {
    const [start, end] = syn.slice(5).split("-");
    return {
      pref: {
        status: "restricted",
        customRange: { start, end },
        note: original,
      },
      confidence: 0.7,
    };
  }
  if (syn.startsWith("code:")) {
    return {
      pref: { status: "fixed", shiftCode: syn.slice(5), note: original },
      confidence: 0.9,
    };
  }
  return { pref: { status: "uncertain", note: original }, confidence: 0.2 };
}

// ---------------------------------------------------------------------------
// Date / month detection
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Convert any plausible header cell value into an ISO date, or null.
 *  Recognizes Excel serials, "YYYY-MM-DD", "M/D", "M/D(曜)", "M月D日". */
export function headerToISO(v: unknown, defaultYear: number): string | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + v * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    return null;
  }
  const raw = String(v).trim();
  if (!raw) return null;
  const s = normalizeCellText(raw);
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\([^)]*\))?$/);
  if (m) return `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  m = s.match(/^(\d{1,2})月(\d{1,2})日?$/);
  if (m) return `${defaultYear}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  return null;
}

/** Pull a 1..31 day number out of a cell ("12", "12日", "12(月)"). */
export function extractDayNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 31) {
    return Math.round(v);
  }
  const s = normalizeCellText(v).replace(/\([^)]*\)$/, "").replace(/日$/, "");
  const m = s.match(/^(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 31 ? n : null;
  }
  return null;
}

/** Pull a 1..12 month number out of "4月", "４月", "2026年4月", or an Excel serial. */
export function parseMonthLabel(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 1000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + raw * 86400000);
    return d.getUTCMonth() + 1;
  }
  const s = normalizeCellText(raw);
  const m = s.match(/(\d{1,2})\s*月/);
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? month : null;
}

function looksLikeDateCell(v: unknown): boolean {
  if (typeof v === "number" && Number.isFinite(v) && v > 1000) return true;
  const s = normalizeCellText(v);
  if (!s) return false;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}(\([^)]*\))?$/.test(s)) return true;
  if (/^\d{1,2}月\d{1,2}日?$/.test(s)) return true;
  if (/^\d{1,2}(日)?(\([^)]*\))?$/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Member-name heuristics
// ---------------------------------------------------------------------------

const NON_MEMBER_LABELS = new Set([
  "曜日", "日", "日付", "週", "week", "day",
  "出勤人数", "合計", "計", "総計", "備考", "note", "memo",
  "シフト", "希望", "name", "名前", "氏名", "メンバー", "member",
  "イベント", "event",
]);

function isLikelyName(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (NON_MEMBER_LABELS.has(t)) return false;
  if (NON_MEMBER_LABELS.has(t.toLowerCase())) return false;
  if (looksLikeDateCell(t)) return false;
  if (/^\d+(\.\d+)?$/.test(t)) return false; // pure numbers
  if (t.length > 20) return false;
  // At least one Kanji / Hiragana / Katakana / Latin letter.
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]/u.test(t)) return false;
  // Reject single-char preference markers that snuck in.
  if (/^[○×△/x休-]+$/.test(normalizeCellText(t))) return false;
  return true;
}

/** Normalize a member name for matching: strip whitespace, full→half width,
 *  collapse spaces. Used both during extraction (to dedupe rows) and by the
 *  applier in excel.ts (already does similar normalization). */
export function normalizeMemberName(s: string): string {
  return normalizeCellText(s).replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Workbook → 2D array (with merged-cell propagation)
// ---------------------------------------------------------------------------

/** Read a sheet as a 2D array, but also fill merged-cell areas so every cell
 *  inside a merge carries the top-left value. SheetJS's sheet_to_json leaves
 *  merged-cell tail positions empty by default. */
export function sheetToMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: true,
    raw: true,
  });
  const merges = sheet["!merges"] ?? [];
  for (const m of merges) {
    const tl = aoa[m.s.r]?.[m.s.c];
    if (tl == null || tl === "") continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      if (!aoa[r]) aoa[r] = [];
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (aoa[r][c] === "" || aoa[r][c] == null) {
          aoa[r][c] = tl;
        }
      }
    }
  }
  return aoa;
}

// ---------------------------------------------------------------------------
// Strategy: header-based extraction
// ---------------------------------------------------------------------------

interface DateColumn {
  col: number;
  date: string;
}

interface Extraction {
  strategy: string;
  members: string[];
  dates: string[];
  records: PreferenceRecord[];
  uncertainCount: number;
  parsedCount: number;
  warnings: string[];
}

/** Score an extraction: more members and dates is better; many uncertain cells
 *  drag the score down; we also reward "filled" cells so a strategy that picks
 *  up actual values beats a sparse one. */
function scoreExtraction(e: Extraction): number {
  const filled = e.records.filter(
    (r) => r.wishValue && r.wishValue !== "unavailable",
  ).length;
  return (
    e.members.length * 4 +
    e.dates.length * 2 +
    filled * 1 -
    e.uncertainCount * 0.5
  );
}

/** Build a date column map for a candidate header row, optionally using a
 *  preceding "X月" context row to disambiguate bare day numbers. Returns null
 *  when fewer than 3 dates resolve. */
function buildDateColumns(
  rows: unknown[][],
  headerRowIdx: number,
  monthByCol: Map<number, number>,
  defaultYear: number,
  startMonth: number,
): DateColumn[] | null {
  const header = rows[headerRowIdx];
  if (!header) return null;
  const out: DateColumn[] = [];
  let prevMonth = -1;
  let yearOffset = 0;
  let fallbackMonth = startMonth;
  let prevDayNum: number | null = null;
  for (let c = 0; c < header.length; c++) {
    const cell = header[c];
    let iso = headerToISO(cell, defaultYear);
    if (!iso) {
      const dayNum = extractDayNumber(cell);
      if (dayNum !== null) {
        let month: number;
        if (monthByCol.size > 0) {
          month = monthByCol.get(c) ?? -1;
        } else {
          if (prevDayNum !== null && dayNum < prevDayNum - 5) {
            fallbackMonth = (fallbackMonth % 12) + 1;
          }
          month = fallbackMonth;
          prevDayNum = dayNum;
        }
        if (month > 0) {
          if (prevMonth > 0 && prevMonth > month) yearOffset++;
          prevMonth = month;
          iso = `${defaultYear + yearOffset}-${pad2(month)}-${pad2(dayNum)}`;
        }
      }
    }
    if (iso) out.push({ col: c, date: iso });
  }
  return out.length >= 3 ? out : null;
}

/** Look in the rows preceding `headerRowIdx` (within `lookback` rows) for a
 *  "X月" context row and return a column → month map. */
function detectMonthContext(
  rows: unknown[][],
  headerRowIdx: number,
  lookback = 10,
): Map<number, number> {
  const out = new Map<number, number>();
  for (let r = Math.max(0, headerRowIdx - lookback); r < headerRowIdx; r++) {
    const row = rows[r];
    if (!row) continue;
    const hasMonth = row.some((c) => parseMonthLabel(c) !== null);
    if (!hasMonth) continue;
    let cur = -1;
    for (let c = 0; c < row.length; c++) {
      const m = parseMonthLabel(row[c]);
      if (m !== null) cur = m;
      if (cur > 0) out.set(c, cur);
    }
    return out;
  }
  return out;
}

/** Find the column most likely to contain member names: walk every column and
 *  count how many cells below `headerRowIdx` look like names. Pick the leftmost
 *  column that crosses a minimum threshold and isn't a date column. */
function findNameColumn(
  rows: unknown[][],
  headerRowIdx: number,
  dateCols: Set<number>,
): number | null {
  const maxCol = rows.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  let best = -1;
  let bestCount = 0;
  for (let c = 0; c < maxCol; c++) {
    if (dateCols.has(c)) continue;
    let count = 0;
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const v = rows[r]?.[c];
      if (v == null) continue;
      const s = String(v).trim();
      if (isLikelyName(s)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return bestCount >= 1 ? best : null;
}

function colLetter(col: number): string {
  let s = "";
  let n = col;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function extractWithHeader(
  rows: unknown[][],
  sheetName: string,
  headerRowIdx: number,
  options: ImportOptions,
  strategy: string,
): Extraction | null {
  const monthByCol = detectMonthContext(rows, headerRowIdx);
  const dateCols = buildDateColumns(
    rows,
    headerRowIdx,
    monthByCol,
    options.defaultYear,
    options.startMonth ?? 1,
  );
  if (!dateCols) return null;
  const dateColSet = new Set(dateCols.map((d) => d.col));
  const nameCol = findNameColumn(rows, headerRowIdx, dateColSet);
  if (nameCol == null) return null;

  const records: PreferenceRecord[] = [];
  const memberOrder: string[] = [];
  const seenMembers = new Set<string>();
  const warnings: string[] = [];
  let uncertain = 0;
  let parsed = 0;

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const rawName = String(row[nameCol] ?? "").trim();
    if (!rawName) continue;
    if (NON_MEMBER_LABELS.has(rawName)) continue;
    if (NON_MEMBER_LABELS.has(rawName.toLowerCase())) continue;
    if (rawName.includes("出勤人数") || rawName.includes("合計")) break;
    if (!isLikelyName(rawName)) continue;
    const name = rawName;
    if (!seenMembers.has(name)) {
      seenMembers.add(name);
      memberOrder.push(name);
    }
    for (const { col, date } of dateCols) {
      const raw = row[col];
      const rawStr = raw == null ? "" : String(raw);
      const { pref, confidence } = parseCellAdvanced(raw);
      records.push({
        memberName: name,
        date,
        shiftType: pref.shiftCode ?? null,
        wishValue: pref.status,
        startTime: pref.customRange?.start ?? null,
        endTime: pref.customRange?.end ?? null,
        rawCell: rawStr,
        sourceSheet: sheetName,
        sourceCell: `${colLetter(col)}${r + 1}`,
        confidence,
      });
      if (pref.status === "uncertain") uncertain++;
      else if (rawStr.trim() !== "") parsed++;
    }
  }

  return {
    strategy,
    members: memberOrder,
    dates: dateCols.map((d) => d.date),
    records,
    uncertainCount: uncertain,
    parsedCount: parsed,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Strategies A/B/C: enumerate header-row candidates
// ---------------------------------------------------------------------------

/** Strategy A: any row whose cells (excluding column 0) yield ≥3 ISO dates
 *  via headerToISO. This is the fastest, most-confident detector. */
function strategyA_explicitDates(
  rows: unknown[][],
  sheetName: string,
  options: ImportOptions,
): Extraction[] {
  const out: Extraction[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let hits = 0;
    for (let c = 1; c < row.length; c++) {
      if (headerToISO(row[c], options.defaultYear)) hits++;
    }
    if (hits >= 3) {
      const ex = extractWithHeader(rows, sheetName, r, options, "A:explicit-dates");
      if (ex) out.push(ex);
    }
  }
  return out;
}

/** Strategy B: rows of bare day-numbers (1..31). Useful for templates where
 *  the date row only has "1 2 3 …". Requires either (i) a "X月" context row
 *  above or (ii) startMonth fallback. */
function strategyB_dayNumbers(
  rows: unknown[][],
  sheetName: string,
  options: ImportOptions,
): Extraction[] {
  const out: Extraction[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let hits = 0;
    for (let c = 1; c < row.length; c++) {
      if (extractDayNumber(row[c]) !== null) hits++;
    }
    if (hits >= 5) {
      const ex = extractWithHeader(rows, sheetName, r, options, "B:day-numbers");
      if (ex) out.push(ex);
    }
  }
  return out;
}

/** Strategy C: density-based. Consider the row that maximizes the count of
 *  cells matching looksLikeDateCell. Useful when neither A nor B matched
 *  cleanly (e.g. mixed formats). */
function strategyC_density(
  rows: unknown[][],
  sheetName: string,
  options: ImportOptions,
): Extraction[] {
  let bestRow = -1;
  let bestHits = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let hits = 0;
    for (let c = 0; c < row.length; c++) {
      if (looksLikeDateCell(row[c])) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestRow = r;
    }
  }
  if (bestRow < 0 || bestHits < 3) return [];
  const ex = extractWithHeader(rows, sheetName, bestRow, options, "C:density");
  return ex ? [ex] : [];
}

/** Strategy D: try the same table transposed. Some sheets put dates as rows
 *  and members as columns. We swap and re-run strategies A/B. */
function strategyD_transposed(
  rows: unknown[][],
  sheetName: string,
  options: ImportOptions,
): Extraction[] {
  const maxC = rows.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  const transposed: unknown[][] = [];
  for (let c = 0; c < maxC; c++) {
    const t: unknown[] = [];
    for (let r = 0; r < rows.length; r++) t.push(rows[r]?.[c] ?? "");
    transposed.push(t);
  }
  const out: Extraction[] = [];
  for (const ex of strategyA_explicitDates(transposed, sheetName, options)) {
    out.push({ ...ex, strategy: ex.strategy + "+transposed" });
  }
  for (const ex of strategyB_dayNumbers(transposed, sheetName, options)) {
    out.push({ ...ex, strategy: ex.strategy + "+transposed" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sheet-likeness scoring (for choosing among multiple sheets)
// ---------------------------------------------------------------------------

/** Heuristic: how shift-table-like is this sheet? Cheap pre-filter that helps
 *  us spend strategy effort on the most promising sheet first, but we still
 *  run all sheets to be safe — some workbooks hide the real table behind a
 *  decorative cover sheet. */
function sheetLikenessHint(rows: unknown[][]): number {
  let dateCells = 0;
  let symbolCells = 0;
  for (const row of rows) {
    if (!row) continue;
    for (const c of row) {
      if (looksLikeDateCell(c)) dateCells++;
      const s = normalizeCellText(c);
      if (s === "○" || s === "/" || s === "x" || s === "×" || s === "休") symbolCells++;
    }
  }
  return dateCells * 2 + symbolCells;
}

// ---------------------------------------------------------------------------
// Top-level: parseWorkbook
// ---------------------------------------------------------------------------

export function parseWorkbook(
  buf: ArrayBuffer | Uint8Array,
  options: ImportOptions,
): ImportResult {
  const result: ImportResult = {
    records: [],
    byMember: {},
    dates: [],
    members: [],
    uncertain: [],
    diagnostics: [],
    selectedSheet: null,
    selectedStrategy: null,
    excludedOutOfRange: 0,
    warnings: [],
    errors: [],
  };

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "array", cellDates: false });
  } catch (e) {
    result.errors.push(`ファイルを読み込めませんでした: ${(e as Error).message}`);
    return result;
  }

  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    result.errors.push("ワークブックにシートがありません。");
    return result;
  }

  type Candidate = { extraction: Extraction; sheet: string; score: number };
  const candidates: Candidate[] = [];
  const sheetHints: { sheet: string; hint: number }[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    let rows: unknown[][];
    try {
      rows = sheetToMatrix(sheet);
    } catch (e) {
      result.warnings.push(
        `シート「${sheetName}」を読めませんでした: ${(e as Error).message}`,
      );
      continue;
    }
    if (rows.length < 2) {
      result.warnings.push(`シート「${sheetName}」は行が少ないためスキップしました。`);
      continue;
    }
    sheetHints.push({ sheet: sheetName, hint: sheetLikenessHint(rows) });

    const extractions: Extraction[] = [
      ...strategyA_explicitDates(rows, sheetName, options),
      ...strategyB_dayNumbers(rows, sheetName, options),
      ...strategyC_density(rows, sheetName, options),
      ...strategyD_transposed(rows, sheetName, options),
    ];
    for (const ex of extractions) {
      const score = scoreExtraction(ex);
      candidates.push({ extraction: ex, sheet: sheetName, score });
      result.diagnostics.push({
        sheet: sheetName,
        strategy: ex.strategy,
        score,
        members: ex.members.length,
        dates: ex.dates.length,
        parsed: ex.parsedCount,
        uncertain: ex.uncertainCount,
      });
    }
  }

  if (candidates.length === 0) {
    if (sheetHints.length > 0) {
      const best = sheetHints.reduce((a, b) => (a.hint >= b.hint ? a : b));
      result.errors.push(
        `日付ヘッダー行を検出できませんでした（最有力候補: シート「${best.sheet}」）。ヘッダー行に「2026-04-26」「4/26」「4月」などの日付を入れてください。`,
      );
    } else {
      result.errors.push("日付ヘッダー行を検出できませんでした。");
    }
    return result;
  }

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  result.selectedSheet = winner.sheet;
  result.selectedStrategy = winner.extraction.strategy;
  result.warnings.push(...winner.extraction.warnings);

  // Date-range filtering. We keep records whose date is within
  // [rangeStart, rangeEnd] (inclusive). Date strings are ISO so lexicographic
  // comparison is correct.
  const lo = options.rangeStart ?? "";
  const hi = options.rangeEnd ?? "";
  const inRange = (d: string) =>
    (!lo || d >= lo) && (!hi || d <= hi);

  let excluded = 0;
  const keptDates = new Set<string>();
  const keptRecords: PreferenceRecord[] = [];
  for (const rec of winner.extraction.records) {
    if (!inRange(rec.date)) {
      excluded++;
      continue;
    }
    keptRecords.push(rec);
    keptDates.add(rec.date);
  }
  result.excludedOutOfRange = excluded;
  if (excluded > 0 && (lo || hi)) {
    result.warnings.push(
      `指定期間（${lo || "*"} 〜 ${hi || "*"}）の範囲外のため ${excluded} 件のセルを除外しました。`,
    );
  }
  // If filtering removed every record, keep the warning but also annotate that
  // the sheet itself is fine — the user just picked an empty window.
  if (keptRecords.length === 0 && winner.extraction.records.length > 0) {
    result.warnings.push(
      "指定期間に該当するセルがありませんでした。期間設定をご確認ください。",
    );
  }

  result.records = keptRecords;
  result.dates = Array.from(keptDates).sort();
  const memberOrder: string[] = [];
  const seenMembers = new Set<string>();
  for (const rec of keptRecords) {
    if (!seenMembers.has(rec.memberName)) {
      seenMembers.add(rec.memberName);
      memberOrder.push(rec.memberName);
    }
  }
  result.members = memberOrder;

  for (const rec of keptRecords) {
    const m = (result.byMember[rec.memberName] ??= {});
    const pref: DayPreference = {
      status: (rec.wishValue as DayPreference["status"]) ?? "uncertain",
      note: rec.rawCell,
    };
    if (rec.shiftType) pref.shiftCode = rec.shiftType;
    if (rec.startTime && rec.endTime) {
      pref.customRange = { start: rec.startTime, end: rec.endTime };
    }
    m[rec.date] = pref;
    if (pref.status === "uncertain") {
      result.uncertain.push({
        member: rec.memberName,
        date: rec.date,
        raw: rec.rawCell,
        sourceCell: rec.sourceCell,
      });
    }
  }

  return result;
}
