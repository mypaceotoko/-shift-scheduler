"use client";

import { useState } from "react";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import type { Member, MemberConstraints } from "@/lib/types";

function newMember(name: string): Member {
  return {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    priority: 1,
    constraints: {},
    preferences: {},
    active: true,
  };
}

export default function MembersPage() {
  const { members, shiftTypes, addMember, updateMember, removeMember } = useAppStore();
  const [draftName, setDraftName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = members.find((m) => m.id === editingId) ?? null;

  return (
    <div>
      <PageHeader
        title="メンバー管理"
        description="名前と勤務条件、優先度、許可するシフト種別を編集します。"
        action={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!draftName.trim()) return;
              addMember(newMember(draftName.trim()));
              setDraftName("");
            }}
            className="flex gap-2"
          >
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="新規メンバー名"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <button className="rounded bg-brand-500 px-3 py-1.5 text-sm text-white hover:bg-brand-600">
              追加
            </button>
          </form>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-md border border-slate-200 bg-white">
          {members.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">メンバーが未登録です。</p>
          ) : (
            <ul>
              {members.map((m) => (
                <li
                  key={m.id}
                  className={`border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 ${
                    editingId === m.id ? "bg-brand-50" : ""
                  }`}
                >
                  <button
                    className="flex w-full items-center justify-between"
                    onClick={() => setEditingId(m.id)}
                  >
                    <span>
                      <span className="font-medium">{m.name}</span>
                      {!m.active && <span className="ml-2 text-xs text-slate-400">(無効)</span>}
                    </span>
                    <span className="text-xs text-slate-400">P{m.priority}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section>
          {editing ? (
            <MemberEditor
              key={editing.id}
              member={editing}
              shiftCodes={shiftTypes.map((s) => s.code)}
              onChange={(patch) => updateMember(editing.id, patch)}
              onRemove={() => {
                if (confirm(`${editing.name} を削除しますか?`)) {
                  removeMember(editing.id);
                  setEditingId(null);
                }
              }}
            />
          ) : (
            <p className="text-sm text-slate-500">左側のリストから編集対象を選択してください。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function MemberEditor({
  member,
  shiftCodes,
  onChange,
  onRemove,
}: {
  member: Member;
  shiftCodes: string[];
  onChange: (patch: Partial<Member>) => void;
  onRemove: () => void;
}) {
  function setConstraints(patch: Partial<MemberConstraints>) {
    onChange({ constraints: { ...member.constraints, ...patch } });
  }
  function toggleShift(list: "allowedShifts" | "excludedShifts", code: string) {
    const current = new Set(member.constraints[list] ?? []);
    if (current.has(code)) current.delete(code);
    else current.add(code);
    setConstraints({ [list]: [...current] } as Partial<MemberConstraints>);
  }
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="名前">
          <input
            value={member.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="優先度（高いほど優先）">
          <input
            type="number"
            value={member.priority}
            onChange={(e) => onChange({ priority: Number(e.target.value) })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="出勤可能シフト">
          <div className="flex flex-wrap gap-1">
            {shiftCodes.map((c) => {
              const allowed = member.constraints.allowedShifts ?? [];
              const active = allowed.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => toggleShift("allowedShifts", c)}
                  className={`rounded border px-2 py-0.5 text-xs ${
                    active
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-slate-300 text-slate-600"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-slate-500">未選択は全シフト可。</p>
        </Field>
        <Field label="禁止シフト">
          <div className="flex flex-wrap gap-1">
            {shiftCodes.map((c) => {
              const excluded = member.constraints.excludedShifts ?? [];
              const active = excluded.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => toggleShift("excludedShifts", c)}
                  className={`rounded border px-2 py-0.5 text-xs ${
                    active
                      ? "border-rose-500 bg-rose-50 text-rose-700"
                      : "border-slate-300 text-slate-600"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="週あたりの最大出勤数">
          <input
            type="number"
            value={member.constraints.maxPerWeek ?? ""}
            onChange={(e) =>
              setConstraints({
                maxPerWeek: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="最大連勤数">
          <input
            type="number"
            value={member.constraints.maxConsecutive ?? ""}
            onChange={(e) =>
              setConstraints({
                maxConsecutive: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="メモ">
          <textarea
            value={member.notes ?? ""}
            onChange={(e) => onChange({ notes: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            rows={2}
          />
        </Field>
        <Field label="状態">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={member.active}
              onChange={(e) => onChange({ active: e.target.checked })}
            />
            有効（シフト割り当て対象）
          </label>
        </Field>
      </div>

      <div className="mt-4 flex justify-end">
        <button onClick={onRemove} className="text-xs text-rose-600 hover:underline">
          削除
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
