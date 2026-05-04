/**
 * Tests for generateSchedule — focuses on the constraint-honoring behaviors
 * that recently changed (two-pass relaxation, target ramp-up, fairness
 * warnings).
 *
 * Run with:  npx tsx --test tests/scheduler.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSchedule } from "../src/lib/scheduler";
import { DEFAULT_SHIFT_TYPES } from "../src/lib/shiftTypes";
import type {
  Member,
  SchedulerSettings,
} from "../src/lib/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function mk(name: string, overrides: Partial<Member> = {}): Member {
  return {
    id: `m_${name}`,
    name,
    priority: 1,
    constraints: {},
    preferences: {},
    active: true,
    ...overrides,
  };
}

function settings(overrides: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return {
    requiredByWeekday: [
      { weekday: 0, count: 3 },
      { weekday: 1, count: 3 },
      { weekday: 2, count: 3 },
      { weekday: 3, count: 3 },
      { weekday: 4, count: 3 },
      { weekday: 5, count: 3 },
      { weekday: 6, count: 3 },
    ],
    defaultMaxConsecutive: 5,
    defaultMaxPerWeek: 6,
    balanceWorkload: true,
    morningShiftCode: "B",
    ...overrides,
  };
}

/** Mark the whole period as ○ for a member. */
function allAvailable(m: Member, dates: string[]) {
  for (const d of dates) m.preferences[d] = { status: "available", note: "○" };
}

function rangeISO(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const cur = new Date(startISO);
  const end = new Date(endISO);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Required headcount is hit when enough members are available
// ---------------------------------------------------------------------------

test("required headcount filled when enough ○ are submitted", () => {
  const dates = rangeISO("2026-05-01", "2026-05-07");
  const members: Member[] = ["山田", "佐藤", "田中", "鈴木", "高橋"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings(),
  });
  for (const d of dates) {
    const onDay = r.schedule.assignments.filter((a) => a.date === d).length;
    assert.ok(onDay >= 3, `day ${d} should have ≥3 assignments, got ${onDay}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Strict pass refuses to exceed maxPerWeek
// ---------------------------------------------------------------------------

test("strict pass does not exceed maxPerWeek when capacity is sufficient", () => {
  // 6 members × cap 4 = 24 capacity ≥ 7 × 3 = 21 required; strict pass can fit.
  const dates = rangeISO("2026-05-04", "2026-05-10"); // Mon..Sun
  const members: Member[] = ["A", "B", "C", "D", "E", "F"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings({ defaultMaxPerWeek: 4 }),
  });
  for (const m of members) {
    const cnt = r.schedule.assignments.filter((a) => a.memberId === m.id).length;
    assert.ok(cnt <= 4, `${m.name} should be ≤4 in week, got ${cnt}`);
  }
  // And no relaxation warning should appear when capacity is sufficient.
  assert.ok(
    !r.warnings.some((w) => w.level === "info" && w.message.includes("緩和")),
    "no relaxation should be needed",
  );
});

// ---------------------------------------------------------------------------
// 3. Relaxation kicks in when too few members exist to honor strict caps
// ---------------------------------------------------------------------------

test("relaxation lets caps stretch when otherwise headcount cannot be filled", () => {
  const dates = rangeISO("2026-05-04", "2026-05-10"); // 7 days, requires 3/day = 21 slots
  // Only 3 members. defaultMaxPerWeek=4 → strict pass can fill only 12 slots.
  // With relaxation, headcount must be filled (3 × 7 = 21 / strict 12 = 9 short).
  const members: Member[] = ["A", "B", "C"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings({ defaultMaxPerWeek: 4 }),
  });
  // After relaxation the total assignments should approach the required 21.
  // We allow some shortage (e.g. consecutive cap = 5) but should be ≥ strict-only result.
  assert.ok(
    r.schedule.assignments.length > 12,
    `relaxed pass should produce >12 assignments, got ${r.schedule.assignments.length}`,
  );
  // And the relaxation should be visible in info-level warnings.
  assert.ok(
    r.warnings.some((w) => w.level === "info" && w.message.includes("緩和")),
    "should record info-level warnings about relaxation",
  );
});

// ---------------------------------------------------------------------------
// 4. Member-target convergence: under-target member is favored
// ---------------------------------------------------------------------------

test("members under their monthly target are favored as the period progresses", () => {
  const dates = rangeISO("2026-05-01", "2026-05-31");
  const members: Member[] = ["A", "B", "C", "D"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings({
      memberTargets: { A: 22, B: 5, C: 15, D: 15 },
    }),
  });
  const aCount = r.schedule.assignments.filter((a) => a.memberId === "m_A").length;
  const bCount = r.schedule.assignments.filter((a) => a.memberId === "m_B").length;
  assert.ok(aCount > bCount, `A (target 22) should get more shifts than B (target 5): A=${aCount}, B=${bCount}`);
});

// ---------------------------------------------------------------------------
// 5. Fairness warning when a member's actual is far from target
// ---------------------------------------------------------------------------

test("fairness warning surfaces when a member's actual diverges from target", () => {
  const dates = rangeISO("2026-05-01", "2026-05-07");
  // Only 3 members but A's target is 30 — completely impossible to hit in 7 days.
  const members: Member[] = ["A", "B", "C"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings({
      memberTargets: { A: 30 },
    }),
  });
  assert.ok(
    r.warnings.some((w) => w.message.includes("A") && w.message.includes("目標")),
    "should warn that A is under target",
  );
});

// ---------------------------------------------------------------------------
// 6. Closed days produce no assignments
// ---------------------------------------------------------------------------

test("closed days do not get any assignments", () => {
  const dates = rangeISO("2026-05-01", "2026-05-03");
  const members: Member[] = ["A", "B", "C"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings(),
    dayConfigs: [
      { date: dates[0], requiredCount: 0, events: [], closed: true },
      { date: dates[1], requiredCount: 3, events: [], closed: false },
      { date: dates[2], requiredCount: 3, events: [], closed: false },
    ],
  });
  assert.equal(
    r.schedule.assignments.filter((a) => a.date === dates[0]).length,
    0,
    "closed day should have no assignments",
  );
});

// ---------------------------------------------------------------------------
// 7. Fixed preferences are honored (member with "B" gets B that day)
// ---------------------------------------------------------------------------

test("fixed shift preference is honored", () => {
  const dates = rangeISO("2026-05-01", "2026-05-03");
  const members: Member[] = ["A", "B", "C"].map((n) => mk(n));
  for (const m of members) allAvailable(m, dates);
  members[0].preferences[dates[0]] = { status: "fixed", shiftCode: "B", note: "B" };
  const r = generateSchedule({
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    members,
    shiftTypes: DEFAULT_SHIFT_TYPES,
    settings: settings(),
  });
  const a = r.schedule.assignments.find(
    (x) => x.memberId === "m_A" && x.date === dates[0],
  );
  assert.ok(a, "A should be assigned on day 1");
  assert.equal(a!.shiftCode, "B");
});
