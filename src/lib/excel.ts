"use client";

import * as XLSX from "xlsx";
import type { DayPreference, Member, Schedule, ShiftType } from "./types";
import { rangeISO, weekdayLabel } from "./dateUtils";
import { effectiveCountAs } from "./scheduler";
import { holidayName } from "./holidays";
import { parseWorkbook, type ImportResult, type PreferenceRecord } from "./excelImport";

// Re-export parseCellPreference from its own module so existing callers keep
// working. Image-OCR and the import UI both reach for this symbol from
// "@/lib/excel".
export { parseCellPreference } from "./cellParser";

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

  // ---- New optional fields. Kept optional so other code paths that build
  // ImportedPreferences by hand (e.g. image OCR) don't have to populate them.

  /** Flat normalized records, one per (member, date) cell that survived range
   *  filtering. Includes confidence, source sheet, and source-cell A1 ref. */
  records?: PreferenceRecord[];
  /** Number of cells dropped because they fell outside the date range. */
  excludedOutOfRange?: number;
  /** Hard errors from the parser (e.g. couldn't open file, no header row). */
  errors?: string[];
  /** Sheet name actually used. */
  selectedSheet?: string | null;
  /** Strategy that won the scoring (see excelImport.ts). */
  selectedStrategy?: string | null;
  /** Per-sheet/per-strategy diagnostic info — useful for surfacing why a
   *  particular sheet was chosen and what the runner-ups looked like. */
  diagnostics?: ImportResult["diagnostics"];
}

export interface ImportPreferencesOptions {
  /** Inclusive start of the wanted period, ISO date "YYYY-MM-DD". When set,
   *  cells outside [rangeStart, rangeEnd] are filtered out before being
   *  returned. */
  rangeStart?: string;
  rangeEnd?: string;
}

/** Read an XLSX/CSV file (already parsed to ArrayBuffer) and extract preferences.
 *  Delegates to the multi-strategy parser in excelImport.ts. */
export function importPreferencesFromBuffer(
  buf: ArrayBuffer,
  defaultYear: number,
  startMonth = 1,
  options: ImportPreferencesOptions = {},
): ImportedPreferences {
  const result = parseWorkbook(buf, {
    defaultYear,
    startMonth,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
  });

  return {
    byMember: result.byMember,
    dates: result.dates,
    uncertain: result.uncertain.map((u) => ({
      member: u.member,
      date: u.date,
      raw: u.raw,
    })),
    warnings: [...result.warnings, ...result.errors],
    records: result.records,
    excludedOutOfRange: result.excludedOutOfRange,
    errors: result.errors,
    selectedSheet: result.selectedSheet,
    selectedStrategy: result.selectedStrategy,
    diagnostics: result.diagnostics,
  };
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
