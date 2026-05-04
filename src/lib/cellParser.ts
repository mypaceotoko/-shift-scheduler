import type { DayPreference } from "./types";

// Single-cell preference parser. Extracted from excel.ts so it can be reused
// by excelImport.ts without creating a circular dependency. Behavior must
// remain backwards-compatible with the original parser — image OCR and the
// legacy import path both rely on it.

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
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/[‐‑‒–—―ー−ｰ]/g, "-")
    .replace(/[〜～]/g, "~")
    .replace(/[：﹕]/g, ":")
    .replace(/[◯〇⚪⭕◦●∘⊙◎○]/g, "○")
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
  if (/^[0OQoUu]$/.test(text) || /^\(\s*\)$/.test(text)) {
    return { status: "available", note: original };
  }
  if (/^[\\|1lI7]$/.test(text)) {
    return { status: "unavailable", note: original };
  }

  if (SHIFT_CODE_RE.test(text)) {
    return { status: "fixed", shiftCode: text, note: original };
  }
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
