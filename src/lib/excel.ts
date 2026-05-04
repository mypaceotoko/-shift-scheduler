"use client";

import * as XLSX from "xlsx";
import type { DayPreference, Member, Schedule, ShiftType } from "./types";
import { rangeISO, weekdayLabel } from "./dateUtils";
import { effectiveCountAs } from "./scheduler";
import { holidayName } from "./holidays";

// =============================================================================
// Cell text -> DayPreference parsing
// =============================================================================

const SHIFT_CODE_RE = /^[STBCDFA]$/;
const TIME_RANGE_RE = /^(\d{1,2})(?::(\d{2}))?\s*[-〜~]\s*(\d{1,2})(?::(\d{2}))?$/;
const TIME_FROM_RE = /^(\d{1,2})(?::(\d{2}))?\s*[-〜~]$/;
const TIME_UNTIL_RE = /^[-〜~]\s*(\d{1,2})(?::(\d{2}))?$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Normalize full-width digits/letters and common OCR look-alikes so that the
 *  downstream regexes (shift code, time range, ...) can match consistently. */
function normalizePreferenceCell(raw: unknown): string {
  const s = String(raw ?? "")
    // Full-width ASCII → half-width.
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    // Long dashes / minus signs / katakana prolonged sound mark used as a hyphen.
    .replace(/[‐‑‒–—―ー−ｰ]/g, "-")
    // Tildes used for time ranges.
    .replace(/[〜～]/g, "~")
    // Full-width colon.
    .replace(/[：﹕]/g, ":")
    // Various circle glyphs.
    .replace(/[◯〇⚪⭕◦●∘⊙◎○]/g, "○")
    // Slash variants.
    .replace(/[／⁄∕]/g, "/")
    .trim();
  return s.replace(/\s+/g, " ");
}

/** Parse a single cell value to a DayPreference.
 *  - "" => unavailable (no preference submitted - exclude from schedule)
 *  - "／" / "/" / "x" / "休" / "公休" => unavailable
 *  - "○" / "◯" / "〇" / OCR look-alikes => available
 *  - "T", "B", ... => fixed shift code
 *  - "13-18", "18-", "-16" => restricted custom range
 *  - anything else => uncertain (kept for review). */
export function parseCellPreference(raw: unknown): DayPreference {
  const original = String(raw ?? "").trim();
  if (!original) return { status: "unavailable", note: "" };

  const text = normalizePreferenceCell(original);
  if (!text) return { status: "unavailable", note: "" };

  const lower = text.toLowerCase();
  if (
    text === "/" ||
    lower === "x" ||
    text === "✕" ||
    text === "×" ||
    text === "休" ||
    text === "公休" ||
    text === "OFF" ||
    lower === "off"
  ) {
    return { status: "unavailable", note: original };
  }
  if (text === "○") {
    return { status: "available", note: original };
  }
  // OCR-only look-alikes for ○ when the cell is literally one character.
  if (/^[0OQoUu]$/.test(text) || /^\(\s*\)$/.test(text)) {
    return { status: "available", note: original };
  }
  // OCR-only look-alikes for ／ when the cell is literally one character.
  if (/^[\\|1lI7]$/.test(text)) {
    return { status: "unavailable", note: original };
  }

  if (SHIFT_CODE_RE.test(text)) {
    return { status: "fixed", shiftCode: text, note: original };
  }
  // Time range like "13-18"
  const m1 = text.match(TIME_RANGE_RE);
  if (m1) {
    const start = `${pad2(Number(m1[1]))}:${m1[2] ?? "00"}`;
    const end = `${pad2(Number(m1[3]))}:${m1[4] ?? "00"}`;
    return { status: "restricted", customRange: { start, end }, note: original };
  }
  const m2 = text.match(TIME_FROM_RE);
  if (m2) {
    const start = `${pad2(Number(m2[1]))}:${m2[2] ?? "00"}`;
    return { status: "restricted", customRange: { start, end: "23:00" }, note: original };
  }
  const m3 = text.match(TIME_UNTIL_RE);
  if (m3) {
    const end = `${pad2(Number(m3[1]))}:${m3[2] ?? "00"}`;
    return { status: "restricted", customRange: { start: "09:00", end }, note: original };
  }
  return { status: "uncertain", note: original };
}

// =============================================================================
// Excel import - sheet of preferences
// =============================================================================

export interface ImportedPreferences {
  /** Member name -> { dateISO -> preference } */
  byMember: Record<string, Record<string, DayPreference>>;
  /** Detected date range. */
  dates: string[];
  /** Cells that need review. */
  uncertain: { member: string; date: string; raw: string }[];
  warnings: string[];
}

/** Read an XLSX/CSV file (already parsed to ArrayBuffer) and extract preferences.
 *  Expected format: first column = member name, header row = ISO dates or
 *  month/day labels. Falls back to best-effort. */
export function importPreferencesFromBuffer(
  buf: ArrayBuffer,
  defaultYear: number,
  startMonth = 1,
): ImportedPreferences {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  }) as (string | number)[][];

  const result: ImportedPreferences = {
    byMember: {},
    dates: [],
    uncertain: [],
    warnings: [],
  };

  if (rows.length < 2) {
    result.warnings.push("シートに十分な行がありません。");
    return result;
  }

  // Find header row: need at least 3 date-like values to avoid mistaking
  // shift-definition rows (which may have a few standalone numbers) for the date row.
  const headerRowIdx = rows.findIndex((r) => r.slice(1).filter(looksLikeDate).length >= 3);
  if (headerRowIdx < 0) {
    result.warnings.push("日付ヘッダー行を検出できませんでした。");
    return result;
  }

  // Look for a "X月" month-context row in the preceding rows (within 10 rows).
  // Common Japanese format: month header row above the day-number row.
  const monthByCol = new Map<number, number>();
  for (let r = Math.max(0, headerRowIdx - 10); r < headerRowIdx; r++) {
    const monthRow = rows[r];
    const hasMonthMarker = monthRow.some((cell) => parseMonthLabel(cell) !== null);
    if (!hasMonthMarker) continue;
    // Propagate each month rightward until the next marker.
    let currentMonth = -1;
    for (let c = 0; c < monthRow.length; c++) {
      const month = parseMonthLabel(monthRow[c]);
      if (month !== null) currentMonth = month;
      if (currentMonth > 0) monthByCol.set(c, currentMonth);
    }
    break;
  }

  const header = rows[headerRowIdx];
  const dateColumns: { col: number; date: string }[] = [];
  let prevMonth = -1;
  let yearOffset = 0;
  // Fallback month used when no "X月" context row was found.
  let fallbackMonth = startMonth;
  let prevDayNum: number | null = null;

  for (let c = 1; c < header.length; c++) {
    const cell = header[c];
    let iso = toISOFromHeader(cell, defaultYear);

    // If no full date resolved, try combining a day number with month context.
    if (!iso) {
      const dayNum = extractDayNumber(cell);
      if (dayNum !== null) {
        let month: number;
        if (monthByCol.size > 0) {
          // Use the detected "X月" context.
          month = monthByCol.get(c) ?? -1;
        } else {
          // No context row found — use startMonth and auto-increment when the
          // day number wraps around (e.g., 30 → 1 means the next month started).
          if (prevDayNum !== null && dayNum < prevDayNum) {
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

    if (iso) dateColumns.push({ col: c, date: iso });
  }

  if (dateColumns.length === 0) {
    result.warnings.push(
      "日付列を検出できませんでした。ヘッダー行の日付形式（例: 4/26 または 2026-04-26）または月見出し行（例: 4月）を確認してください。",
    );
    return result;
  }
  result.dates = dateColumns.map((d) => d.date);

  // Known header-only row labels that appear between the date row and member rows.
  const NON_MEMBER_LABELS = new Set(["曜日", "日", "日付", "週", "week", "day"]);

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[0] ?? "").trim();
    if (!name) continue;
    if (NON_MEMBER_LABELS.has(name)) continue;
    if (name.includes("出勤人数") || name.includes("合計")) break;
    const prefs: Record<string, DayPreference> = {};
    for (const { col, date } of dateColumns) {
      const raw = row[col];
      const pref = parseCellPreference(raw);
      prefs[date] = pref;
      if (pref.status === "uncertain") {
        result.uncertain.push({ member: name, date, raw: String(raw) });
      }
    }
    result.byMember[name] = prefs;
  }

  return result;
}

function looksLikeDate(v: unknown): boolean {
  // Excel serial dates for modern years (2000+) are > 36000
  if (typeof v === "number" && Number.isFinite(v) && v > 1000) return true;
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) return true;
  if (/^\d{1,2}$/.test(s)) return true;
  return false;
}

function toISOFromHeader(v: unknown, defaultYear: number): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // Only treat large numbers as Excel serial dates (modern dates are > 36000).
    // Small numbers (1-31) are day numbers handled by extractDayNumber + month context.
    if (v > 1000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + v * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) return `${defaultYear}-${pad2(Number(md[1]))}-${pad2(Number(md[2]))}`;
  return null;
}

function extractDayNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 31) {
    return Math.round(v);
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 31 ? n : null;
  }
  return null;
}

/** Parse a cell value as a month label like "4月", "４月", "4 月", "2026年4月",
 *  or an Excel serial date where the month is inferred from the date.
 *  Returns the month number (1-12) or null if not recognized. */
function parseMonthLabel(raw: unknown): number | null {
  // Excel serial date stored as a number — extract its month.
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 1000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + raw * 86400000);
    return d.getUTCMonth() + 1;
  }
  // Normalize full-width digits (０-９) to ASCII digits.
  const s = String(raw ?? "").trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = s.match(/(\d{1,2})\s*月/);
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? month : null;
}

// =============================================================================
// Apply imported preferences to existing members (matching by name)
// =============================================================================

export function applyImportedPreferences(
  members: Member[],
  imported: ImportedPreferences,
  options: { addMissing: boolean },
): Member[] {
  const next = members.map((m) => ({ ...m, preferences: { ...m.preferences } }));
  for (const [name, prefs] of Object.entries(imported.byMember)) {
    let m = next.find((mm) => mm.name === name || mm.name.replace(/\s+/g, "") === name.replace(/\s+/g, ""));
    if (!m) {
      if (!options.addMissing) continue;
      m = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        priority: 1,
        constraints: {},
        preferences: {},
        active: true,
      };
      next.push(m);
    }
    for (const [date, pref] of Object.entries(prefs)) {
      m.preferences[date] = pref;
    }
  }
  return next;
}

// =============================================================================
// Export schedule to XLSX (matches the reference template layout:
//   row 1   : 日   | 11 | 12 | 13 | ... | 10
//   row 2   : 曜日 | 月 | 火 | 水 | ... | 水
//   row 3   : イベント | 祝(昭和の日) | 短縮 | ... |
//   row 4+ : 鈴木 絢也 | T |    | B  | ... |
//   last    : 出勤人数 | 3.5 | 3 | 3 | ... |
// =============================================================================

export function exportScheduleToXLSX(
  schedule: Schedule,
  members: Member[],
  shiftTypes: ShiftType[],
): Blob {
  const dates = rangeISO(schedule.startDate, schedule.endDate);

  // Three header rows.
  const dayRow: (string | number)[] = ["日"];
  const weekdayRow: (string | number)[] = ["曜日"];
  const eventRow: (string | number)[] = ["イベント"];

  for (const date of dates) {
    dayRow.push(Number(date.slice(8))); // day-of-month as a number
    weekdayRow.push(weekdayLabel(date)); // 月/火/水/...
    const cfg = schedule.dayConfigs.find((c) => c.date === date);
    const tags: string[] = [];
    const hol = holidayName(date);
    if (hol) tags.push(`祝(${hol})`);
    if (cfg?.closed) tags.push("休館");
    if (cfg?.events && cfg.events.length > 0) tags.push(...cfg.events);
    eventRow.push(tags.join(" / "));
  }

  const rows: (string | number)[][] = [dayRow, weekdayRow, eventRow];

  // Member rows. The trailing "合計" column is kept (operations want it for
  // payroll), but the template's pure structure can be obtained by deleting
  // the column in Excel after opening.
  const memberHeaderTotal = "合計";
  rows[0].push(memberHeaderTotal);
  rows[1].push("");
  rows[2].push("");

  for (const m of members) {
    if (!m.active) continue;
    const row: (string | number)[] = [m.name];
    let total = 0;
    for (const date of dates) {
      const a = schedule.assignments.find((x) => x.date === date && x.memberId === m.id);
      if (!a) {
        row.push("");
        continue;
      }
      const w = effectiveCountAs(a, shiftTypes);
      total += w;
      const cell = a.customRange
        ? `${a.customRange.start.slice(0, 5)}-${a.customRange.end.slice(0, 5)}`
        : a.shiftCode;
      row.push(cell);
    }
    row.push(total);
    rows.push(row);
  }

  // Daily headcount footer
  const footer: (string | number)[] = ["出勤人数"];
  for (const date of dates) {
    const sum = schedule.assignments
      .filter((a) => a.date === date)
      .reduce((s, a) => s + effectiveCountAs(a, shiftTypes), 0);
    footer.push(sum);
  }
  footer.push("");
  rows.push(footer);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Column widths: name column wider, day columns narrow.
  ws["!cols"] = [
    { wch: 14 },
    ...dates.map(() => ({ wch: 4 })),
    { wch: 6 },
  ];
  // Freeze the leftmost column and the three header rows so scrolling stays
  // anchored on long periods. xlsx types omit the !freeze pane helper, so we
  // assign through an unknown cast.
  (ws as unknown as { "!freeze": unknown })["!freeze"] = { xSplit: 1, ySplit: 3 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "シフト");
  const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
