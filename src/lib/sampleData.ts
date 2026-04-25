import type { Member, Schedule, SchedulerSettings, ShiftType } from "./types";
import { DEFAULT_SHIFT_TYPES } from "./shiftTypes";
import { rangeISO } from "./dateUtils";

/** CS PORTER reference period: 2026-04-26 ~ 2026-05-10 (2 weeks). */
export const SAMPLE_START = "2026-04-26";
export const SAMPLE_END = "2026-05-10";

const dates = rangeISO(SAMPLE_START, SAMPLE_END);

function blankPrefs(): Record<string, { status: "available" }> {
  return Object.fromEntries(dates.map((d) => [d, { status: "available" as const }]));
}

export const SAMPLE_MEMBERS: Member[] = [
  {
    id: "m_suzuki",
    name: "鈴木 絢也",
    priority: 4,
    constraints: { allowedShifts: ["T", "B", "S", "F"], maxPerWeek: 6 },
    preferences: {
      ...blankPrefs(),
      "2026-04-29": { status: "unavailable", note: "休館日" },
      "2026-04-30": { status: "unavailable", note: "休館日" },
      "2026-05-09": { status: "fixed", shiftCode: "T", note: "-15" },
    },
    active: true,
  },
  {
    id: "m_kawakami",
    name: "川上 祐也",
    priority: 4,
    constraints: { allowedShifts: ["F", "B", "D", "T"], maxPerWeek: 6 },
    preferences: {
      ...blankPrefs(),
      "2026-04-26": { status: "unavailable" },
      "2026-04-27": { status: "fixed", shiftCode: "D" },
      "2026-04-28": { status: "fixed", shiftCode: "B" },
      "2026-04-29": { status: "unavailable", note: "休館日" },
      "2026-04-30": { status: "unavailable", note: "休館日" },
    },
    active: true,
  },
  {
    id: "m_kobayashi",
    name: "小林 聖哉",
    priority: 5,
    constraints: { allowedShifts: ["S", "B", "D", "A"], maxPerWeek: 6 },
    preferences: {
      ...blankPrefs(),
      "2026-04-29": { status: "unavailable", note: "休館日" },
      "2026-04-30": { status: "unavailable", note: "休館日" },
      "2026-05-06": { status: "restricted", customRange: { start: "14:00", end: "19:00" } },
      "2026-05-09": { status: "fixed", shiftCode: "A", note: "-15" },
    },
    active: true,
  },
  {
    id: "m_tamoto",
    name: "田本 周",
    priority: 4,
    constraints: { allowedShifts: ["B", "D", "S", "T"], maxPerWeek: 6 },
    preferences: {
      ...blankPrefs(),
      "2026-04-29": { status: "unavailable", note: "休館日" },
      "2026-04-30": { status: "unavailable", note: "休館日" },
    },
    active: true,
  },
  {
    id: "m_hamano",
    name: "浜野 滋",
    priority: 2,
    constraints: { allowedShifts: ["F"], maxPerWeek: 4 },
    preferences: {
      ...blankPrefs(),
      "2026-04-26": { status: "restricted", customRange: { start: "13:00", end: "18:00" }, note: "13-18" },
      "2026-05-10": { status: "restricted", customRange: { start: "13:00", end: "18:00" }, note: "13-18" },
    },
    active: true,
  },
  {
    id: "m_utsugi",
    name: "宇津木 悟",
    priority: 1,
    constraints: { allowedShifts: ["F"], maxPerWeek: 2 },
    preferences: blankPrefs(),
    active: true,
  },
  {
    id: "m_inose",
    name: "猪瀬",
    priority: 1,
    constraints: { allowedShifts: ["F"], maxPerWeek: 3 },
    preferences: blankPrefs(),
    active: true,
  },
  {
    id: "m_ozaki",
    name: "尾崎",
    priority: 1,
    constraints: { allowedShifts: ["F"], maxPerWeek: 3 },
    preferences: blankPrefs(),
    active: true,
  },
];

export const SAMPLE_SETTINGS: SchedulerSettings = {
  // Sun=0..Sat=6. Reference sheet shows 4-5 weekdays, 4-5 weekends.
  requiredByWeekday: [
    { weekday: 0, count: 4 }, // 日
    { weekday: 1, count: 4 }, // 月
    { weekday: 2, count: 4 }, // 火
    { weekday: 3, count: 4 }, // 水
    { weekday: 4, count: 4 }, // 木
    { weekday: 5, count: 4 }, // 金
    { weekday: 6, count: 5 }, // 土
  ],
  defaultMaxConsecutive: 5,
  defaultMaxPerWeek: 6,
  balanceWorkload: true,
};

export const SAMPLE_SHIFT_TYPES: ShiftType[] = DEFAULT_SHIFT_TYPES;

/** A blank schedule covering the sample period with closed days marked. */
export const SAMPLE_SCHEDULE: Schedule = {
  id: "sample",
  name: "CS PORTER 2026/04/26-05/10",
  startDate: SAMPLE_START,
  endDate: SAMPLE_END,
  assignments: [],
  dayConfigs: dates.map((d) => ({
    date: d,
    requiredCount: SAMPLE_SETTINGS.requiredByWeekday.find((r) => r.weekday === new Date(d).getDay())?.count ?? 4,
    events:
      d === "2026-04-29" || d === "2026-04-30"
        ? ["休館日"]
        : d === "2026-04-26" || d === "2026-05-03" || d === "2026-05-04" || d === "2026-05-05" || d === "2026-05-10"
        ? ["短縮"]
        : d === "2026-05-06"
        ? ["短縮", "CSMTG"]
        : d === "2026-05-07"
        ? ["MGRMTG"]
        : [],
    closed: d === "2026-04-29" || d === "2026-04-30",
  })),
};
