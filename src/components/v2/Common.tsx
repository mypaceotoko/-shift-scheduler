import Link from "next/link";
import type { ReactNode } from "react";
export function Heading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="heading">
      <div>
        <p className="eyebrow">LIBERTY WORKSPACE</p>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}
export function Workflow({ step }: { step: number }) {
  return (
    <nav className="steps" aria-label="作成手順">
      {[
        ["/import", "希望表を取り込む"],
        ["/import", "読取内容を確認"],
        ["/generate", "シフト自動生成"],
        ["/schedule", "監査・Excel出力"],
      ].map(([url, label], i) => (
        <Link key={i} className={step === i ? "current" : ""} href={url}>
          <b>{String(i + 1).padStart(2, "0")}</b>
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function Metric({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <div className={`metric ${warn ? "warn" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
