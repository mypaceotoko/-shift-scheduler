"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const NAV = [
  { href: "/", label: "ダッシュボード", icon: "■" },
  { href: "/members", label: "メンバー管理", icon: "👤" },
  { href: "/import", label: "希望表の読み取り", icon: "⇪" },
  { href: "/generate", label: "シフト生成", icon: "✦" },
  { href: "/schedule", label: "シフト確認・編集", icon: "▦" },
  { href: "/export", label: "エクスポート", icon: "⇩" },
  { href: "/settings", label: "設定", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-60 shrink-0 border-r border-slate-200 bg-white px-4 py-6">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-slate-400">Shift Scheduler</p>
        <h1 className="text-lg font-semibold text-slate-800">シフトスケジューラ</h1>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand-50 text-brand-700 font-medium"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              <span className="w-5 text-center">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
