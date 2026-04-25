"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Assignment,
  DayConfig,
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

const DEFAULT_SETTINGS: SchedulerSettings = {
  requiredByWeekday: [0, 1, 2, 3, 4, 5, 6].map((w) => ({
    weekday: w,
    count: w === 0 || w === 6 ? 4 : 4,
  })),
  defaultMaxConsecutive: 5,
  defaultMaxPerWeek: 6,
  balanceWorkload: true,
};

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      members: [],
      shiftTypes: DEFAULT_SHIFT_TYPES,
      schedule: null,
      settings: DEFAULT_SETTINGS,

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
        set({ schedule: { ...sch, assignments: next } });
      },
      removeAssignment: (date, memberId) => {
        const sch = get().schedule;
        if (!sch) return;
        set({
          schedule: {
            ...sch,
            assignments: sch.assignments.filter(
              (a) => !(a.date === date && a.memberId === memberId),
            ),
          },
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
