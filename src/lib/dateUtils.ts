/** ISO date helpers - all functions operate on "YYYY-MM-DD" strings. */

const WEEKDAY_LABELS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function rangeISO(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let cur = startISO;
  while (cur <= endISO) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Returns 0=Sun ... 6=Sat */
export function weekdayOf(iso: string): number {
  return parseISO(iso).getDay();
}

export function weekdayLabel(iso: string): string {
  return WEEKDAY_LABELS_JA[weekdayOf(iso)];
}

export function isWeekend(iso: string): boolean {
  const w = weekdayOf(iso);
  return w === 0 || w === 6;
}

/** ISO week number (Mon-start) used as a coarse grouping key. */
export function isoWeekKey(iso: string): string {
  const date = parseISO(iso);
  // Move to Thursday of the same week to compute ISO week.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function formatJP(iso: string): string {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${weekdayLabel(iso)})`;
}
