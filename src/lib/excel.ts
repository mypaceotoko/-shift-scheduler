"use client";

import * as XLSX from "xlsx";
import type { DayPreference, Member, Schedule, ShiftType } from "./types";
import { rangeISO, weekdayLabel } from "./dateUtils";

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

/** Parse a single cell value to a DayPreference.
 *  - "" => unavailable (no preference submitted - exclude from schedule)
 *  - "／" / "/" / "x" / "休" / "公休" => unavailable
 *  - "○" / "◯" / "〇" => available (eligible for assignment)
 *  - "T", "B", ... => fixed shift code
 *  - "13-18", "18-", "-16" => restricted custom range
 *  - anything else => uncertain (kept for review). */
export function parseCellPreference(raw: unknown): DayPreference {
  const text = String(raw ?? "").trim();
  if (!text) return { status: "unavailable", note: "" };
  const lower = text.toLowerCase();
  if (text === "／" || text === "/" || lower === "x" || text === "✕" || text === "休" || text === "公休") {
    return { status: "unavailable", note: text };
  }
  if (text === "○" || text === "◯" || text === "〇") {
    return { status: "available", note: text };
  }
  if (SHIFT_CODE_RE.test(text)) {
    return { status: "fixed", shiftCode: text, note: text };
  }
  // Time range like "13-18"
  const m1 = text.match(TIME_RANGE_RE);
  if (m1) {
    const start = `${pad2(Number(m1[1]))}:${m1[2] ?? "00"}`;
    const end = `${pad2(Number(m1[3]))}:${m1[4] ?? "00"}`;
    return { status: "restricted", customRange: { start, end }, note: text };
  }
  const m2 = text.match(TIME_FROM_RE);
  if (m2) {
    const start = `${pad2(Number(m2[1]))}:${m2[2] ?? "00"}`;
    return { status: "restricted", customRange: { start, end: "23:00" }, note: text };
  }
  const m3 = text.match(TIME_UNTIL_RE);
  if (m3) {
    const end = `${pad2(Number(m3[1]))}:${m3[2] ?? "00"}`;
    return { status: "restricted", customRange: { start: "09:00", end }, note: text };
  }
  return { status: "uncertain", note: text };
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
export function importPreferencesFromBuffer(buf: ArrayBuffer, defaultYear: number): ImportedPreferences {
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

  // Find header row (row whose values look like dates).
  const headerRowIdx = rows.findIndex((r) => r.slice(1).some(looksLikeDate));
  if (headerRowIdx < 0) {
    result.warnings.push("日付ヘッダー行を検出できませんでした。");
    return result;
  }
  const header = rows[headerRowIdx];
  const dateColumns: { col: number; date: string }[] = [];
  for (let c = 1; c < header.length; c++) {
    const cell = header[c];
    const iso = toISOFromHeader(cell, defaultYear);
    if (iso) dateColumns.push({ col: c, date: iso });
  }
  result.dates = dateColumns.map((d) => d.date);

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[0] ?? "").trim();
    if (!name) continue;
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
    // Excel serial date
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) return `${defaultYear}-${pad2(Number(md[1]))}-${pad2(Number(md[2]))}`;
  const d = s.match(/^(\d{1,2})$/);
  if (d) {
    // Day-only - assume current month from sibling cells; handled by caller via defaultYear hack.
    return null;
  }
  return null;
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
// Export schedule to XLSX (matches reference layout: members x dates)
// =============================================================================

export function exportScheduleToXLSX(
  schedule: Schedule,
  members: Member[],
  shiftTypes: ShiftType[],
): Blob {
  const dates = rangeISO(schedule.startDate, schedule.endDate);
  const header: (string | number)[] = ["メンバー / 日付", ...dates.map((d) => `${d.slice(5)}(${weekdayLabel(d)})`), "合計"];
  const rows: (string | number)[][] = [header];

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
      const w = shiftTypes.find((s) => s.code === a.shiftCode)?.countAs ?? 1;
      total += w;
      const cell = a.customRange ? `${a.customRange.start.slice(0, 5)}-${a.customRange.end.slice(0, 5)}` : a.shiftCode;
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
      .reduce((s, a) => s + (shiftTypes.find((t) => t.code === a.shiftCode)?.countAs ?? 1), 0);
    footer.push(sum);
  }
  footer.push("");
  rows.push(footer);

  const ws = XLSX.utils.aoa_to_sheet(rows);
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
