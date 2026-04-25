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

    // 1. Honor fixed/restricted preferences, but never exceed requiredCount.
    //    Sort by member priority so higher-priority members win the limited slots.
    //    For time-range (restricted) preferences, attempt to trim to half-shift
    //    when full duration would exceed the cap.
    const target = day.requiredCount;
    const preferred = activeMembers
      .filter((m) => !assignedMemberIds.has(m.id))
      .map((m) => ({ m, pref: m.preferences[day.date] }))
      .filter(
        (x) =>
          (x.pref?.status === "fixed" && x.pref.shiftCode) ||
          (x.pref?.status === "restricted" && x.pref.customRange),
      )
      .sort((a, b) => b.m.priority - a.m.priority);

    for (const { m, pref } of preferred) {
      const remaining = target - weight;
      if (remaining <= 1e-9) {
        warnings.push({
          date: day.date,
          level: "warning",
          message: `${m.name} の希望 (${pref!.note ?? pref!.shiftCode ?? "時間帯指定"}) は人数上限により未割当`,
        });
        continue;
      }

      if (pref!.status === "fixed" && pref!.shiftCode) {
        const shift = shiftTypes.find((s) => s.code === pref!.shiftCode);
        if (!shift) continue;
        if (shift.countAs > remaining + 1e-9) {
          warnings.push({
            date: day.date,
            level: "warning",
            message: `${m.name} の固定希望 ${pref!.shiftCode} (重み ${shift.countAs}) は残り ${remaining} に収まらず未割当`,
          });
          continue;
        }
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: pref!.shiftCode,
          customRange: undefined,
          manuallyEdited: false,
          warnings: [],
        });
        assignedMemberIds.add(m.id);
        weight += shift.countAs;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      } else if (pref!.status === "restricted" && pref!.customRange) {
        const range = pref!.customRange;
        const fullWeight = weightForRange(range);
        let chosenRange = range;
        let chosenWeight = fullWeight;
        let trimmed = false;
        if (fullWeight > remaining + 1e-9) {
          if (remaining + 1e-9 >= 0.5) {
            chosenRange = trimRangeToHalf(range);
            chosenWeight = 0.5;
            trimmed = true;
          } else {
            warnings.push({
              date: day.date,
              level: "warning",
              message: `${m.name} の時間帯希望 ${range.start}-${range.end} は人数上限により未割当`,
            });
            continue;
          }
        }
        const code = chooseShiftForRange(shiftTypes, chosenRange) ?? "CUSTOM";
        const cellWarnings: string[] = [];
        if (trimmed)
          cellWarnings.push(`人数上限のため ${range.start}-${range.end} → ${chosenRange.start}-${chosenRange.end} に短縮`);
        if (code === "CUSTOM") cellWarnings.push("カスタム時間帯");
        assignments.push({
          date: day.date,
          memberId: m.id,
          shiftCode: code,
          customRange: chosenRange,
          manuallyEdited: false,
          warnings: cellWarnings,
        });
        assignedMemberIds.add(m.id);
        weight += chosenWeight;
        bumpCounters(m.id, day.date, totalsByMember, weeklyByMember, lastDateByMember, consecutiveByMember);
      }
    }

    // 2. Greedy fill until requiredCount reached using prioritized candidates.
    //    When the remaining capacity is fractional and only full shifts are
    //    available, the top candidate's shift is auto-trimmed to a half slot
    //    so that the day can be closed off at exactly the required count
    //    (e.g. 3.5 with five full-shift requests → 3 full + 1 trimmed half).
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
      const remainingCap = target - weight;

      // Try fitting any candidate's preferred shift within remaining cap.
      let pick = candidates.find((c) => {
        const s = shiftTypes.find((t) => t.code === c.shiftCode);
        return s && s.countAs <= remainingCap + 1e-9;
      });
      let chosenCode: string | undefined;
      let chosenWeight = 0;
      let customRange: { start: string; end: string } | undefined;
      let trimmedWarning: string | undefined;

      if (pick) {
        const pickedCode = pick.shiftCode;
        chosenCode = pickedCode;
        chosenWeight = shiftTypes.find((s) => s.code === pickedCode)!.countAs;
      } else if (remainingCap + 1e-9 >= 0.5) {
        // No shift fits whole - pick a candidate and trim their preferred
        // full shift down to a ~4 hour half slot.
        pick = candidates[0];
        const pickedCode = pick.shiftCode;
        const s = shiftTypes.find((t) => t.code === pickedCode);
        if (!s) break;
        const trimmed = trimRangeToHalf({ start: s.start, end: s.end });
        const matchedHalf = chooseShiftForRange(shiftTypes, trimmed);
        if (matchedHalf) {
          chosenCode = matchedHalf;
          chosenWeight = shiftTypes.find((t) => t.code === matchedHalf)!.countAs;
        } else {
          chosenCode = "CUSTOM";
          chosenWeight = 0.5;
          customRange = trimmed;
        }
        trimmedWarning = `人数上限のため ${s.start}-${s.end} → ${trimmed.start}-${trimmed.end} に短縮`;
      } else {
        break;
      }

      if (!chosenCode || !pick) break;
      const cellWarnings: string[] = [];
      if (pick.forced) cellWarnings.push("条件超過");
      if (trimmedWarning) cellWarnings.push(trimmedWarning);
      assignments.push({
        date: day.date,
        memberId: pick.member.id,
        shiftCode: chosenCode,
        customRange,
        manuallyEdited: false,
        warnings: cellWarnings,
      });
      assignedMemberIds.add(pick.member.id);
      weight += chosenWeight;
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
    // Strict: only members who explicitly marked "available" (○) are eligible
    // for greedy fill. Empty cells / unavailable / uncertain are excluded.
    // Fixed and restricted preferences are handled in step 1, not here.
    if (!pref || pref.status !== "available") continue;

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

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Headcount weight for a custom time window. ≥6h counts as 1.0, otherwise 0.5. */
function weightForRange(range: { start: string; end: string }): number {
  const hours = (timeToMin(range.end) - timeToMin(range.start)) / 60;
  return hours >= 6 ? 1 : 0.5;
}

/** Shorten a range to ~4 hours by pushing the start later. Keeps the original
 *  end time on the assumption that closing-time coverage is more critical. */
function trimRangeToHalf(range: { start: string; end: string }): { start: string; end: string } {
  const endMin = timeToMin(range.end);
  const startMin = Math.max(timeToMin(range.start), endMin - 240);
  return { start: minToTime(startMin), end: range.end };
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
