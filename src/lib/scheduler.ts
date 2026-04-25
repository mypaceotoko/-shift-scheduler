import type {
  Assignment,
  DayConfig,
  Member,
  Schedule,
  SchedulerSettings,
  ShiftType,
} from "./types";
import { addDays, isoWeekKey, rangeISO } from "./dateUtils";

export interface GenerateInput {
  startDate: string;
  endDate: string;
  members: Member[];
  shiftTypes: ShiftType[];
  settings: SchedulerSettings;
  /** Existing day configs (events, closed). If missing, auto-derived from settings. */
  dayConfigs?: DayConfig[];
  /** Existing schedule to preserve manually-edited assignments. */
  existing?: Schedule | null;
}

export interface GenerateResult {
  schedule: Schedule;
  warnings: GenerateWarning[];
}

export interface GenerateWarning {
  date: string;
  level: "info" | "warning" | "error";
  message: string;
}

interface CandidateInfo {
  member: Member;
  shiftCode: string;
  weight: number;
  reason: string;
  forced?: boolean;
}

/** Build a fresh schedule covering the period using greedy assignment + balancing.
 *  - Honors fixed/restricted/unavailable preferences.
 *  - Respects allowedShifts / excludedShifts on the member.
 *  - Balances total assignments across active members when settings.balanceWorkload.
 *  - Enforces maxPerWeek and maxConsecutive heuristically.
 *  - Manually-edited entries from `existing` are preserved verbatim. */
export function generateSchedule(input: GenerateInput): GenerateResult {
  const { startDate, endDate, members, shiftTypes, settings } = input;
  const dates = rangeISO(startDate, endDate);
  const warnings: GenerateWarning[] = [];

  // settings.requiredByWeekday is the single source of truth for required count.
  // Existing day configs are preserved for events/closed only - their stale
  // requiredCount is overwritten so settings changes always take effect on regen.
  const dayConfigs: DayConfig[] = dates.map((date) => {
    const fromInput = input.dayConfigs?.find((d) => d.date === date);
    const weekday = new Date(date).getDay();
    const required =
      settings.requiredByWeekday.find((r) => r.weekday === weekday)?.count ?? 4;
    if (fromInput) {
      return { ...fromInput, requiredCount: required };
    }
    return { date, requiredCount: required, events: [], closed: false };
  });

  // Index helpers
  const memberById = new Map(members.map((m) => [m.id, m]));
  const activeMembers = members.filter((m) => m.active);

  // Carry over manual edits
  const preservedAssignments: Assignment[] = (input.existing?.assignments ?? []).filter(
    (a) => a.manuallyEdited && memberById.has(a.memberId) && a.date >= startDate && a.date <= endDate,
  );

  const totalsByMember = new Map<string, number>();
  const weeklyByMember = new Map<string, Map<string, number>>();
  const lastDateByMember = new Map<string, string>();
  const consecutiveByMember = new Map<string, number>();

  for (const a of preservedAssignments) {
    const w = isoWeekKey(a.date);
    totalsByMember.set(a.memberId, (totalsByMember.get(a.memberId) ?? 0) + 1);
    const wm = weeklyByMember.get(a.memberId) ?? new Map();
    wm.set(w, (wm.get(w) ?? 0) + 1);
    weeklyByMember.set(a.memberId, wm);
  }

  const assignments: Assignment[] = [...preservedAssignments];

  for (const day of dayConfigs) {
    if (day.closed) continue;

    // Already-assigned members for this day (from manual edits)
    const assignedMemberIds = new Set(
      assignments.filter((a) => a.date === day.date).map((a) => a.memberId),
    );
    let weight = assignments
      .filter((a) => a.date === day.date)
      .reduce((sum, a) => sum + (shiftTypes.find((s) => s.code === a.shiftCode)?.countAs ?? 1), 0);

    // 1. Forced/fixed preferences for the day - always slot them in.
    for (const m of activeMembers) {
      if (assignedMemberIds.has(m.id)) continue;
      const pref = m.preferences[day.date];
      if (!pref) continue;
      if (pref.status === "fixed" && pref.shiftCode) {
        const shift = shiftTypes.find((s) => s.code === pref.shiftCode);
        if (!shift) continue;
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: pref.shiftCode,
          customRange: undefined,
          manuallyEdited: false,
          warnings: [],
        });
        assignedMemberIds.add(m.id);
        weight += shift.countAs;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      } else if (pref.status === "restricted" && pref.customRange) {
        const code = chooseShiftForRange(shiftTypes, pref.customRange) ?? "CUSTOM";
        const matchedShift = shiftTypes.find((s) => s.code === code);
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: code,
          customRange: pref.customRange,
          manuallyEdited: false,
          warnings: code === "CUSTOM" ? ["カスタム時間帯"] : [],
        });
        assignedMemberIds.add(m.id);
        weight += matchedShift?.countAs ?? 0.5;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      }
    }

    // 2. Greedy fill until requiredCount reached using prioritized candidates.
    const target = day.requiredCount;
    let safety = 0;
    while (weight + 1e-9 < target && safety++ < 50) {
      const candidates = collectCandidates({
        day,
        members: activeMembers,
        assignedMemberIds,
        shiftTypes,
        settings,
        totalsByMember,
        weeklyByMember,
        consecutiveByMember,
        lastDateByMember,
      });
      if (candidates.length === 0) break;
      candidates.sort((a, b) => b.weight - a.weight);
      const pick = candidates[0];
      const shift = shiftTypes.find((s) => s.code === pick.shiftCode);
      if (!shift) break;
      assignments.push({
        date: day.date,
        memberId: pick.member.id,
        shiftCode: pick.shiftCode,
        manuallyEdited: false,
        warnings: pick.forced ? ["条件超過"] : [],
      });
      assignedMemberIds.add(pick.member.id);
      weight += shift.countAs;
      bumpCounters(pick.member.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
    }

    if (weight + 1e-9 < target) {
      warnings.push({
        date: day.date,
        level: "warning",
        message: `必要人数 ${target} に対して ${weight} 名のみ割り当て`,
      });
    }
  }

  const schedule: Schedule = {
    id: input.existing?.id ?? `sch_${Date.now()}`,
    name: input.existing?.name ?? `${startDate} - ${endDate}`,
    startDate,
    endDate,
    assignments,
    dayConfigs,
    generatedAt: new Date().toISOString(),
  };

  return { schedule, warnings };
}

function bumpCounters(
  memberId: string,
  date: string,
  totals: Map<string, number>,
  weekly: Map<string, Map<string, number>>,
  last: Map<string, string>,
  consecutive: Map<string, number>,
) {
  totals.set(memberId, (totals.get(memberId) ?? 0) + 1);
  const wk = isoWeekKey(date);
  const wm = weekly.get(memberId) ?? new Map();
  wm.set(wk, (wm.get(wk) ?? 0) + 1);
  weekly.set(memberId, wm);
  const prev = last.get(memberId);
  if (prev && addDays(prev, 1) === date) {
    consecutive.set(memberId, (consecutive.get(memberId) ?? 1) + 1);
  } else {
    consecutive.set(memberId, 1);
  }
  last.set(memberId, date);
}

function collectCandidates(args: {
  day: DayConfig;
  members: Member[];
  assignedMemberIds: Set<string>;
  shiftTypes: ShiftType[];
  settings: SchedulerSettings;
  totalsByMember: Map<string, number>;
  weeklyByMember: Map<string, Map<string, number>>;
  consecutiveByMember: Map<string, number>;
  lastDateByMember: Map<string, string>;
}): CandidateInfo[] {
  const out: CandidateInfo[] = [];
  for (const m of args.members) {
    if (args.assignedMemberIds.has(m.id)) continue;
    const pref = m.preferences[args.day.date];
    if (pref?.status === "unavailable") continue;
    if (pref?.status === "uncertain") continue; // require manual review

    // Determine candidate shift codes for this member.
    const allowed = candidateShiftCodes(m, args.shiftTypes);
    if (allowed.length === 0) continue;

    // Capacity checks
    const week = isoWeekKey(args.day.date);
    const weeklyCount = args.weeklyByMember.get(m.id)?.get(week) ?? 0;
    const maxWeek = m.constraints.maxPerWeek ?? args.settings.defaultMaxPerWeek;
    if (weeklyCount >= maxWeek) continue;

    const consecutive = args.consecutiveByMember.get(m.id) ?? 0;
    const last = args.lastDateByMember.get(m.id);
    const isConsecutive = last && addDays(last, 1) === args.day.date;
    const maxConsecutive = m.constraints.maxConsecutive ?? args.settings.defaultMaxConsecutive;
    if (isConsecutive && consecutive >= maxConsecutive) continue;

    // Score: prioritize unused members; tie-break on member.priority.
    const total = args.totalsByMember.get(m.id) ?? 0;
    const balanceTerm = args.settings.balanceWorkload ? -total * 2 : 0;
    const priorityTerm = m.priority;
    const prefBonus = pref?.status === "available" ? 1 : 0;
    const weight = balanceTerm + priorityTerm + prefBonus;

    // Pick best shift for this member - simply the first allowed (could be smarter).
    out.push({
      member: m,
      shiftCode: allowed[0],
      weight,
      reason: pref?.note ?? "auto",
    });
  }
  return out;
}

function candidateShiftCodes(member: Member, shiftTypes: ShiftType[]): string[] {
  const allowed = member.constraints.allowedShifts;
  const excluded = new Set(member.constraints.excludedShifts ?? []);
  const codes = (allowed && allowed.length > 0
    ? allowed
    : shiftTypes.filter((s) => !s.isOff).map((s) => s.code)
  ).filter((c) => !excluded.has(c));
  return codes;
}

function chooseShiftForRange(
  shiftTypes: ShiftType[],
  range: { start: string; end: string },
): string | undefined {
  // Pick the working shift whose [start,end] is closest contained.
  const matches = shiftTypes.filter(
    (s) => !s.isOff && s.start <= range.start && s.end >= range.end,
  );
  if (matches.length > 0) return matches[0].code;
  return undefined;
}

// =============================================================================
// Helpers used by UI for stats
// =============================================================================

export interface MemberStats {
  memberId: string;
  totalCount: number;
  weightedTotal: number;
}

export function computeStats(schedule: Schedule, shiftTypes: ShiftType[]): MemberStats[] {
  const map = new Map<string, MemberStats>();
  for (const a of schedule.assignments) {
    const stat = map.get(a.memberId) ?? {
      memberId: a.memberId,
      totalCount: 0,
      weightedTotal: 0,
    };
    const shift = shiftTypes.find((s) => s.code === a.shiftCode);
    stat.totalCount += 1;
    stat.weightedTotal += shift?.countAs ?? 1;
    map.set(a.memberId, stat);
  }
  return [...map.values()];
}

export function dailyHeadcount(schedule: Schedule, shiftTypes: ShiftType[], date: string): number {
  return schedule.assignments
    .filter((a) => a.date === date)
    .reduce((sum, a) => sum + (shiftTypes.find((s) => s.code === a.shiftCode)?.countAs ?? 1), 0);
}
