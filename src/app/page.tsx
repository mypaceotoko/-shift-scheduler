"use client";

import Link from "next/link";
import { useAppStore } from "@/lib/store";
import PageHeader from "@/components/PageHeader";
import { computeStats } from "@/lib/scheduler";

export default function DashboardPage() {
  const { members, schedule, shiftTypes, loadSampleData } = useAppStore();
  const stats = schedule ? computeStats(schedule, shiftTypes) : [];
  const uncertainCount = members.reduce(
    (n, m) =>
      n +
      Object.values(m.preferences).filter((p) => p.status === "uncertain").length,
    0,
  );

  return (
    <div>
      <PageHeader
        title="ダッシュボード"
        description="メンバー数、希望表の状態、最新シフトの概要を確認できます。"
        action={
          <button
            onClick={loadSampleData}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-sm text-white hover:bg-brand-600"
          >
            サンプルデータを読み込む
          </button>
        }
      />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="登録メンバー" value={String(members.length)} />
        <Card title="シフト種別" value={String(shiftTypes.length)} />
        <Card title="未確認セル" value={String(uncertainCount)} highlight={uncertainCount > 0} />
        <Card
          title="生成済みシフト"
          value={schedule ? `${schedule.assignments.length} 件` : "未生成"}
        />
      </section>

      {schedule ? (
        <section className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            メンバー別出勤回数（重み付き）
          </h3>
          <div className="rounded-md border border-slate-200 bg-white p-4 text-sm">
            <table className="w-full text-left">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1">メンバー</th>
                  <th className="py-1 text-right">回数</th>
                  <th className="py-1 text-right">重み合計</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const s = stats.find((x) => x.memberId === m.id);
                  return (
                    <tr key={m.id} className="border-t border-slate-100">
                      <td className="py-1">{m.name}</td>
                      <td className="py-1 text-right">{s?.totalCount ?? 0}</td>
                      <td className="py-1 text-right">{s?.weightedTotal ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickLink href="/members" title="メンバー管理" desc="名前と勤務条件を登録" />
        <QuickLink href="/import" title="希望表の読み取り" desc="Excel/画像から取り込み" />
        <QuickLink href="/generate" title="シフト生成" desc="2週間分を自動作成" />
      </section>
    </div>
  );
}

function Card({ title, value, highlight }: { title: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-md border p-4 ${
        highlight ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"
      }`}
    >
      <p className="text-xs text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-800">{value}</p>
    </div>
  );
}

function QuickLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-200 bg-white p-4 transition hover:border-brand-500 hover:shadow-sm"
    >
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{desc}</p>
    </Link>
  );
}
