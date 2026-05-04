"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Assignment,
  DayConfig,
  LearnedPatterns,
  Member,
  Schedule,
  SchedulerSettings,
  ShiftType,
} from "./types";
import { DEFAULT_SHIFT_TYPES } from "./shiftTypes";
import {
  SAMPLE_MEMBERS,
  SAMPLE_SCHEDULE,
  SAMPLE_SETTINGS,
} from "./sampleData";

interface AppStore {
  members: Member[];
  shiftTypes: ShiftType[];
  schedule: Schedule | null;
  settings: SchedulerSettings;
  learnedPatterns: LearnedPatterns;

  // Member ops
  addMember: (m: Member) => void;
  updateMember: (id: string, patch: Partial<Member>) => void;
  removeMember: (id: string) => void;

  // Schedule ops
  setSchedule: (s: Schedule | null) => void;
  updateAssignment: (a: Assignment) => void;
  removeAssignment: (date: string, memberId: string) => void;
  updateDayConfig: (date: string, patch: Partial<DayConfig>) => void;

  // Shift type ops
  setShiftTypes: (types: ShiftType[]) => void;

  // Settings ops
  setSettings: (s: SchedulerSettings) => void;

  // Learning ops
  clearLearnedPatterns: () => void;

  // Bulk ops
  loadSampleData: () => void;
  resetAll: () => void;
  importState: (state: {
    members: Member[];
    shiftTypes: ShiftType[];
    schedule: Schedule | null;
    settings: SchedulerSettings;
  }) => void;
}

const EMPTY_LEARNED: LearnedPatterns = {
  memberDayCode: {},
  memberDayOff: {},
  totalEvents: 0,
};

/** Returns a deep-ish clone of the patterns with one event applied. */
function recordCodeEvent(
  prev: LearnedPatterns,
  memberId: string,
  date: string,
  code: string,
): LearnedPatterns {
  const weekday = String(new Date(date).getDay());
  const next = {
    memberDayCode: { ...prev.memberDayCode },
    memberDayOff: { ...prev.memberDayOff },
    totalEvents: prev.totalEvents + 1,
    updatedAt: new Date().toISOString(),
  };
  const byMember = { ...(next.memberDayCode[memberId] ?? {}) };
  const byDay = { ...(byMember[weekday] ?? {}) };
  byDay[code] = (byDay[code] ?? 0) + 1;
  byMember[weekday] = byDay;
  next.memberDayCode[memberId] = byMember;
  return next;
}

function recordOffEvent(
  prev: LearnedPatterns,
  memberId: string,
  date: string,
): LearnedPatterns {
  const weekday = String(new Date(date).getDay());
  const next = {
    memberDayCode: { ...prev.memberDayCode },
    memberDayOff: { ...prev.memberDayOff },
    totalEvents: prev.totalEvents + 1,
    updatedAt: new Date().toISOString(),
  };
  const byMember = { ...(next.memberDayOff[memberId] ?? {}) };
  byMember[weekday] = (byMember[weekday] ?? 0) + 1;
  next.memberDayOff[memberId] = byMember;
  return next;
}

/** House rules captured from operations on 2026-05-04. The textarea on the
 *  generate page lets the user edit this freely so future tweaks persist. */
const DEFAULT_HOUSE_RULES = `朝はB番スタート（Aなし）
火水木金 → 最大3人
月土日 → 最大3.5人（＝6h枠あり）
19時以降1人OK
休憩回しでも常に2人残す

【メンバー優先順位】
最優先(地雷枠): 浜野 → 最初に満足させる(外すと全部壊れる)
最優先(生活ライン): 鈴木 → 月22日近く必要 / 川上 → 派遣なのである程度入れる
次に優先: 宇津木 → 少ないので積極投入
調整枠: 小林 → 別部署あり(少なめOK) / 田本 → 少なくてOK`;

const DEFAULT_SETTINGS: SchedulerSettings = {
  // Sun=0, Mon=1, ... Sat=6.
  requiredByWeekday: [
    { weekday: 0, count: 3.5 }, // 日
    { weekday: 1, count: 3.5 }, // 月
    { weekday: 2, count: 3 },   // 火
    { weekday: 3, count: 3 },   // 水
    { weekday: 4, count: 3 },   // 木
    { weekday: 5, count: 3 },   // 金
    { weekday: 6, count: 3.5 }, // 土
  ],
  defaultMaxConsecutive: 5,
  defaultMaxPerWeek: 6,
  balanceWorkload: true,
  houseRules: DEFAULT_HOUSE_RULES,
  morningShiftCode: "B",
  memberTargets: {
    浜野: 22,
    鈴木: 22,
    川上: 18,
    宇津木: 15,
    小林: 8,
    田本: 8,
  },
};

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      members: [],
      shiftTypes: DEFAULT_SHIFT_TYPES,
      schedule: null,
      settings: DEFAULT_SETTINGS,
      learnedPatterns: EMPTY_LEARNED,

      addMember: (m) => set({ members: [...get().members, m] }),
      updateMember: (id, patch) =>
        set({
          members: get().members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        }),
      removeMember: (id) =>
        set({ members: get().members.filter((m) => m.id !== id) }),

      setSchedule: (schedule) => set({ schedule }),
      updateAssignment: (a) => {
        const sch = get().schedule;
        if (!sch) return;
        const idx = sch.assignments.findIndex(
          (x) => x.date === a.date && x.memberId === a.memberId,
        );
        const next = [...sch.assignments];
        if (idx >= 0) next[idx] = a;
        else next.push(a);

        // Record the user's manual choice as a learned pattern. Auto-generated
        // assignments call setSchedule (not updateAssignment) so they don't
        // get recorded here — only true manual edits via the schedule grid.
        let learned = get().learnedPatterns ?? EMPTY_LEARNED;
        if (a.manuallyEdited && a.shiftCode && a.shiftCode !== "CUSTOM") {
          learned = recordCodeEvent(learned, a.memberId, a.date, a.shiftCode);
        }
        set({ schedule: { ...sch, assignments: next }, learnedPatterns: learned });
      },
      removeAssignment: (date, memberId) => {
        const sch = get().schedule;
        if (!sch) return;
        const learned = recordOffEvent(
          get().learnedPatterns ?? EMPTY_LEARNED,
          memberId,
          date,
        );
        set({
          schedule: {
            ...sch,
            assignments: sch.assignments.filter(
              (a) => !(a.date === date && a.memberId === memberId),
            ),
          },
          learnedPatterns: learned,
        });
      },
      updateDayConfig: (date, patch) => {
        const sch = get().schedule;
        if (!sch) return;
        set({
          schedule: {
            ...sch,
            dayConfigs: sch.dayConfigs.map((d) =>
              d.date === date ? { ...d, ...patch } : d,
            ),
          },
        });
      },

      setShiftTypes: (shiftTypes) => set({ shiftTypes }),
      setSettings: (settings) => set({ settings }),

      clearLearnedPatterns: () => set({ learnedPatterns: EMPTY_LEARNED }),

      loadSampleData: () =>
        set({
          members: SAMPLE_MEMBERS,
          shiftTypes: DEFAULT_SHIFT_TYPES,
          schedule: SAMPLE_SCHEDULE,
          settings: SAMPLE_SETTINGS,
        }),
      resetAll: () =>
        set({
          members: [],
          shiftTypes: DEFAULT_SHIFT_TYPES,
          schedule: null,
          settings: DEFAULT_SETTINGS,
          learnedPatterns: EMPTY_LEARNED,
        }),
      importState: (state) =>
        set({
          members: state.members,
          shiftTypes: state.shiftTypes,
          schedule: state.schedule,
          settings: state.settings,
        }),
    }),
    {
      name: "shift-scheduler-state-v1",
    },
  ),
);
