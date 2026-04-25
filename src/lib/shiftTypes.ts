import type { ShiftType } from "./types";

/** Default shift catalog matching the CS PORTER reference sheet. */
export const DEFAULT_SHIFT_TYPES: ShiftType[] = [
  { code: "S", label: "S 9:30-18:30", start: "09:30", end: "18:30", countAs: 1, color: "shift-S" },
  { code: "T", label: "T 9:45-18:45", start: "09:45", end: "18:45", countAs: 1, color: "shift-T" },
  { code: "B", label: "B 10:00-19:00", start: "10:00", end: "19:00", countAs: 1, color: "shift-B" },
  { code: "C", label: "C 11:00-20:00", start: "11:00", end: "20:00", countAs: 1, color: "shift-C" },
  { code: "D", label: "D 12:00-21:00", start: "12:00", end: "21:00", countAs: 1, color: "shift-D" },
  { code: "F", label: "F 14:00-23:00", start: "14:00", end: "23:00", countAs: 1, color: "shift-F" },
  { code: "A", label: "A 14:00-", start: "14:00", end: "19:00", countAs: 0.5, color: "shift-A" },
  { code: "OFF", label: "公休", start: "", end: "", countAs: 0, color: "shift-OFF", isOff: true },
];

export function findShiftType(types: ShiftType[], code: string): ShiftType | undefined {
  return types.find((s) => s.code === code);
}

export function isHalfShift(type: ShiftType | undefined): boolean {
  return !!type && type.countAs > 0 && type.countAs < 1;
}

/** Returns list of shift codes that overlap a given allowed time window. */
export function shiftsWithinRange(
  types: ShiftType[],
  range: { start: string; end: string },
): string[] {
  return types
    .filter((s) => !s.isOff && s.start >= range.start && s.end <= range.end)
    .map((s) => s.code);
}
