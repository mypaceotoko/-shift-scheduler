// =============================================================================
// Domain types for the shift scheduler
// =============================================================================

/** Shift code identifier (e.g. "S", "T", "B", "OFF"). Free-form string so users
 *  can introduce new shift definitions in settings. */
export type ShiftCode = string;

export interface ShiftType {
  code: ShiftCode;
  label: string;
  /** "HH:mm" 24h. */
  start: string;
  /** "HH:mm" 24h. */
  end: string;
  /** Headcount weight - 1 for full shift, 0.5 for half day. */
  countAs: number;
  /** Display color tag (matches CSS class shift-XXX). */
  color?: string;
  /** When true the shift represents non-working state (e.g. OFF). */
  isOff?: boolean;
}

/** Per-day, per-member preference indicating what is allowed/required. */
export type DayPreferenceStatus =
  | "available"  // ○ - any shift in member's allowed set
  | "unavailable" // ／ - cannot work
  | "fixed"      // explicit shift code requested (e.g. "T")
  | "restricted" // custom time range only (e.g. "13-18")
  | "uncertain"; // OCR / Excel could not interpret - needs review

export interface DayPreference {
  status: DayPreferenceStatus;
  /** Used when status = "fixed" or member supplied explicit code. */
  shiftCode?: ShiftCode;
  /** Used when status = "restricted" - explicit time range. */
  customRange?: { start: string; end: string };
  /** Optional free-form note from source (raw cell text). */
  note?: string;
}

export interface MemberConstraints {
  /** Shift codes the member is willing to work. Empty = any. */
  allowedShifts?: ShiftCode[];
  /** Shift codes explicitly forbidden. */
  excludedShifts?: ShiftCode[];
  /** Maximum shifts per ISO week (Mon start). */
  maxPerWeek?: number;
  /** Minimum shifts per ISO week. */
  minPerWeek?: number;
  /** Maximum total shifts in the period. */
  maxTotal?: number;
  /** Maximum consecutive working days. */
  maxConsecutive?: number;
}

export interface Member {
  id: string;
  name: string;
  /** Higher is preferred when filling slots. */
  priority: number;
  constraints: MemberConstraints;
  /** dateISO -> preference. */
  preferences: Record<string, DayPreference>;
  notes?: string;
  active: boolean;
}

/** Per-day store-level configuration. */
export interface DayConfig {
  /** ISO date "YYYY-MM-DD". */
  date: string;
  /** Required headcount (supports half shifts). */
  requiredCount: number;
  /** Free-form labels for the day (短縮, CSMTG, 健康診断 ...). */
  events: string[];
  /** When true the store is closed - no assignments. */
  closed: boolean;
}

export interface Assignment {
  date: string;
  memberId: string;
  shiftCode: ShiftCode;
  /** Custom time override (e.g. "13-18"). */
  customRange?: { start: string; end: string };
  manuallyEdited: boolean;
  warnings: string[];
}

export interface Schedule {
  id: string;
  /** ISO start (inclusive). */
  startDate: string;
  /** ISO end (inclusive). */
  endDate: string;
  assignments: Assignment[];
  dayConfigs: DayConfig[];
  generatedAt?: string;
  /** Free-form name for display. */
  name?: string;
}

// =============================================================================
// Default rule set (configurable in settings page)
// =============================================================================

export interface RequiredCountRule {
  /** 0 = Sun, 1 = Mon, ... 6 = Sat. */
  weekday: number;
  count: number;
}

export interface SchedulerSettings {
  /** Default required headcount per weekday. */
  requiredByWeekday: RequiredCountRule[];
  /** Default max consecutive days. */
  defaultMaxConsecutive: number;
  /** Default max shifts per week per member. */
  defaultMaxPerWeek: number;
  /** When true, prefer balancing total assignments across members. */
  balanceWorkload: boolean;
  /** Free-form rules text the user wrote (店舗のハウスルール).
   *  Stored verbatim, displayed back on the generate page; only the structured
   *  fields below influence the scheduler. */
  houseRules?: string;
  /** Shift code preferred for the morning opening slot (default "B").
   *  When set, this code is moved to the front of each member's allowed list
   *  so the greedy fill picks it first. */
  morningShiftCode?: string;
  /** Per-member monthly target headcount, keyed by member name (full name or
   *  last name only). Members below their target receive a weighting bonus
   *  in greedy fill so they catch up to the target by the end of the period. */
  memberTargets?: Record<string, number>;
}

// =============================================================================
// Persisted root state
// =============================================================================

export interface AppState {
  members: Member[];
  shiftTypes: ShiftType[];
  schedule: Schedule | null;
  settings: SchedulerSettings;
}
