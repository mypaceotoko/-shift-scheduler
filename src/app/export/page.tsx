"use client";

import { useRef } from "react";
import PageHeader from "@/components/PageHeader";
import { useAppStore } from "@/lib/store";
import { downloadBlob, exportScheduleToXLSX } from "@/lib/excel";

export default function ExportPage() {
  const { schedule, members, shiftTypes, settings, importState } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);

  function exportXlsx() {
    if (!schedule) return;
    const blob = exportScheduleToXLSX(schedule, members, shiftTypes);
    downloadBlob(blob, `shift_${schedule.startDate}_${schedule.endDate}.xlsx`);
  }

  function exportJson() {
    const data = JSON.stringify({ members, shiftTypes, schedule, settings }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    downloadBlob(blob, `shift-state-${new Date().toISOString().slice(0, 10)}.json`);
  }

  function exportPrintHtml() {
    if (!schedule) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(buildPrintHtml(schedule, members, shiftTypes));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 200);
  }

  async function onImportJson(file: File) {
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!data.members || !data.shiftTypes) throw new Error("不正な形式");
      importState({
        members: data.members,
        shiftTypes: data.shiftTypes,
        schedule: data.schedule ?? null,
        settings: data.settings ?? settings,
      });
      alert("JSONを取り込みました。");
    } catch (e) {
      alert(`読み込みに失敗しました: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <PageHeader
        title="エクスポート / インポート"
        description="シフトをExcelで出力したり、状態をJSONで保存・復元できます。印刷向けHTMLも生成できます。"
      />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Excelで出力 (.xlsx)" desc="メンバー × 日付の表形式で書き出します。">
          <button
            onClick={exportXlsx}
            disabled={!schedule}
            className="rounded bg-brand-500 px-3 py-1.5 text-sm text-white hover:bg-brand-600 disabled:bg-slate-300"
          >
            ダウンロード
          </button>
        </Card>
        <Card title="印刷用HTML" desc="紙のシフト表に近いレイアウトで開きます（PDF保存可）。">
          <button
            onClick={exportPrintHtml}
            disabled={!schedule}
            className="rounded bg-brand-500 px-3 py-1.5 text-sm text-white hover:bg-brand-600 disabled:bg-slate-300"
          >
            開く
          </button>
        </Card>
        <Card title="状態をJSON保存" desc="メンバー・シフト・設定を一括で保存します。">
          <button
            onClick={exportJson}
            className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
          >
            JSON書き出し
          </button>
        </Card>
        <Card title="JSONを取り込み" desc="保存済みのJSONを復元します。現在の状態は上書きされます。">
          <input
            type="file"
            accept=".json"
            ref={fileRef}
            onChange={(e) => e.target.files?.[0] && onImportJson(e.target.files[0])}
            className="text-sm"
          />
        </Card>
      </section>
    </div>
  );
}

function Card({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      <p className="mt-1 mb-3 text-xs text-slate-500">{desc}</p>
      {children}
    </div>
  );
}

function buildPrintHtml(
  schedule: import("@/lib/types").Schedule,
  members: import("@/lib/types").Member[],
  shiftTypes: import("@/lib/types").ShiftType[],
): string {
  const dates = (() => {
    const out: string[] = [];
    let cur = schedule.startDate;
    while (cur <= schedule.endDate) {
      out.push(cur);
      const d = new Date(cur);
      d.setDate(d.getDate() + 1);
      cur = d.toISOString().slice(0, 10);
    }
    return out;
  })();
  const headerCells = dates
    .map((d) => `<th>${d.slice(5)}</th>`)
    .join("");
  const rows = members
    .filter((m) => m.active)
    .map((m) => {
      let total = 0;
      const cells = dates
        .map((d) => {
          const a = schedule.assignments.find((x) => x.date === d && x.memberId === m.id);
          if (!a) return "<td></td>";
          const t = shiftTypes.find((s) => s.code === a.shiftCode);
          total += t?.countAs ?? 1;
          return `<td>${a.customRange ? `${a.customRange.start}-${a.customRange.end}` : a.shiftCode}</td>`;
        })
        .join("");
      return `<tr><th>${m.name}</th>${cells}<td><b>${total}</b></td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>シフト表</title>
<style>
body { font-family: sans-serif; padding: 16px; }
table { border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #999; padding: 4px 6px; text-align: center; min-width: 28px; }
th:first-child, td:first-child { text-align: left; min-width: 120px; }
@media print { body { padding: 0 } }
</style></head><body>
<h1>シフト表 ${schedule.startDate} 〜 ${schedule.endDate}</h1>
<table><thead><tr><th>メンバー</th>${headerCells}<th>合計</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}
