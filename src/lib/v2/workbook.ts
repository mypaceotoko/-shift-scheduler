import ExcelJS from "exceljs";
import { audit, budget, desired, reductions, total, work } from "./engine";
import { days, RULES, minutes, type State, type Assignment } from "./model";
import { weekdayLabel } from "../dateUtils";
import { holidayName } from "../holidays";
const label = (a: Assignment) =>
  a.code === "CUSTOM"
    ? `${a.start}-${a.end}${a.rest ? `\n休憩${a.rest}分` : ""}`
    : a.code;
export async function workbook(s: State) {
  if (!s.plan) throw new Error("シフトが未生成です");
  const plan = s.plan,
    issues = audit(s);
  if (issues.some((i) => i.level === "error"))
    throw new Error("ハード制約違反を解消してから出力してください");
  const wb = new ExcelJS.Workbook();
  wb.creator = "LIBERTY SHIFT SCHEDULER";
  wb.calcProperties.fullCalcOnLoad = true;
  const [schedule, wishes, check, codes, calc, reduced] = [
    "シフト案",
    "希望読取",
    "チェック",
    "コード設定",
    "計算",
    "削減集計",
  ].map((name) =>
    wb.addWorksheet(name, {
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.25,
          right: 0.25,
          top: 0.4,
          bottom: 0.4,
          header: 0.15,
          footer: 0.15,
        },
      },
    }),
  );
  const dates = days(plan.start, plan.end),
    people = s.people.filter((p) => p.active),
    stats = reductions(s);
  for (const sheet of [schedule, wishes]) {
    sheet.addRow([`CS課・PORTER ${sheet.name} | ${plan.start} ～ ${plan.end}`]);
    sheet.mergeCells(1, 1, 1, dates.length + 1);
    sheet.addRow([
      `ルール ${RULES.version} / 拘束・休憩・実働を分離 / P=PORTER・F=フロント`,
    ]);
    sheet.mergeCells(2, 1, 2, dates.length + 1);
    sheet.addRow(["スタッフ / 日付", ...dates]);
    sheet.addRow(["曜日", ...dates.map(weekdayLabel)]);
    sheet.addRow([
      "イベント",
      ...dates.map((date) => {
        const d = plan.days.find((d) => d.date === date)!;
        return [
          holidayName(date),
          d.porterClosed ? "P休館" : "",
          d.frontClosed ? "F休館" : "",
          d.event,
        ]
          .filter(Boolean)
          .join(" / ");
      }),
    ]);
    sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 5 }];
    sheet.pageSetup.printTitlesRow = "1:5";
    sheet.getColumn(1).width = 24;
    for (let c = 2; c <= dates.length + 1; c++) sheet.getColumn(c).width = 13;
  }
  codes.addRow([
    "検索キー",
    "部署",
    "コード",
    "開始",
    "終了",
    "実働(h)",
    "休憩(分)",
    "備考",
  ]);
  const catalog = new Map<string, (string | number)[]>();
  for (const t of s.shifts)
    catalog.set(t.department + "|" + t.code, [
      t.department + "|" + t.code,
      t.department,
      t.code,
      t.start,
      t.end,
      (minutes(t.end) - minutes(t.start) - t.rest) / 60,
      t.rest,
      "標準・登録コード",
    ]);
  for (const a of plan.assignments) {
    const p = s.people.find((p) => p.id === a.personId)!;
    const key = p.department + "|" + label(a);
    catalog.set(key, [
      key,
      p.department,
      label(a),
      a.start,
      a.end,
      work(a) / 60,
      a.rest,
      "出力時の勤務定義",
    ]);
  }
  for (const row of catalog.values()) codes.addRow(row);
  const codeLast = codes.rowCount;
  calc.addRow([
    "スタッフID",
    "氏名",
    "部署キー",
    "日付",
    "希望時間(h)",
    "実働時間(h)",
    "削減時間(h)",
    "拘束時間(h)",
    "休憩時間(h)",
    "休憩開始",
    "確認状態",
    "原本位置",
  ]);
  const calcRows: Record<string, number> = {};
  people.forEach((p, index) => {
    const row = 6 + index;
    schedule.addRow([
      `${p.name} (${p.department === "porter" ? "P" : "F"})`,
      ...dates.map((d) => {
        const a = plan.assignments.find(
          (a) => a.date === d && a.personId === p.id,
        );
        return a
          ? label(a)
          : p.wishes[d]?.kind === "leave"
            ? "有給"
            : p.wishes[d]?.kind === "off"
              ? "／"
              : "";
      }),
    ]);
    wishes.addRow([p.name, ...dates.map((d) => p.wishes[d]?.raw ?? "")]);
    for (let j = 0; j < dates.length; j++) {
      const date = dates[j],
        a = plan.assignments.find(
          (a) => a.date === date && a.personId === p.id,
        ),
        w = p.wishes[date],
        wish = desired(p, date, s) / 60,
        actual = a ? work(a) / 60 : 0,
        n = calc.rowCount + 1,
        cell = schedule.getCell(row, j + 2).address;
      calcRows[p.id + "|" + date] = n;
      calc.addRow([
        p.id,
        p.name,
        p.department,
        date,
        wish,
        {
          formula: `IFERROR(VLOOKUP(C${n}&"|"&'シフト案'!${cell},'コード設定'!$A$2:$H$${codeLast},6,FALSE),0)`,
          result: actual,
        },
        { formula: `MAX(0,E${n}-F${n})`, result: Math.max(0, wish - actual) },
        a ? (minutes(a.end) - minutes(a.start)) / 60 : 0,
        a ? a.rest / 60 : 0,
        a?.breakStart ?? "",
        !w || !w.reviewed || w.kind === "unknown" ? "要確認" : "確認済",
        w?.source ? `${w.source.file} ${w.source.cell ?? ""}` : "手入力",
      ]);
      if (!w || !w.reviewed || w.kind === "unknown")
        wishes.getCell(row, j + 2).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF2D9" },
        };
    }
  });
  const last = Math.max(2, calc.rowCount);
  schedule.addRow([
    "PORTER出勤人数",
    ...dates.map(
      (d) =>
        new Set(
          plan.assignments
            .filter(
              (a) =>
                a.date === d &&
                s.people.find((p) => p.id === a.personId)?.department ===
                  "porter",
            )
            .map((a) => a.personId),
        ).size,
    ),
  ]);
  schedule.addRow([
    "PORTER総実働(h)",
    ...dates.map((date) => ({
      formula: `SUMIFS('計算'!$F$2:$F$${last},'計算'!$D$2:$D$${last},"${date}",'計算'!$C$2:$C$${last},"porter")`,
      result: total(s, date) / 60,
    })),
  ]);
  schedule.addRow([
    "人件費目安(h)",
    ...dates.map(
      (date) => budget(plan.days.find((d) => d.date === date)!).target / 60,
    ),
  ]);
  schedule.addRow([
    "差(h)",
    ...dates.map(
      (date) =>
        (total(s, date) -
          budget(plan.days.find((d) => d.date === date)!).target) /
        60,
    ),
  ]);
  schedule.addRow([
    "判定",
    ...dates.map((d) =>
      issues.some((i) => i.date === d && i.level !== "info")
        ? "調整必要"
        : plan.days.find((x) => x.date === d)?.porterClosed
          ? "休館"
          : "OK",
    ),
  ]);
  schedule.addRow([
    "希望違反",
    ...dates.map(
      (d) => issues.filter((i) => i.date === d && i.level === "error").length,
    ),
  ]);
  check.addRow([
    "日付",
    "曜日",
    "実働(h)",
    "目安(h)",
    "上限(h)",
    "差(h)",
    "判定",
    "監査内容",
  ]);
  for (const d of plan.days) {
    const b = budget(d),
      n = total(s, d.date);
    check.addRow([
      d.date,
      weekdayLabel(d.date),
      n / 60,
      b.target / 60,
      b.limit / 60,
      (n - b.target) / 60,
      issues.some((i) => i.date === d.date && i.level !== "info")
        ? "調整必要"
        : "OK",
      issues
        .filter((i) => i.date === d.date)
        .map((i) => i.message)
        .join("\n"),
    ]);
  }
  check.addRow([]);
  check.addRow(["重大度", "日付", "スタッフID", "分類", "内容"]);
  for (const i of issues)
    check.addRow([i.level, i.date, i.personId ?? "", i.code, i.message]);
  reduced.addRow([
    "スタッフ",
    "希望勤務日数",
    "希望時間(h)",
    "実出勤日数",
    "実勤務(h)",
    "削減時間(h)",
    "8h換算削減日数",
    "削減発生日数",
    "全休削減日数",
    "短縮削減日数",
    ...dates,
  ]);
  for (const r of stats) {
    const n = reduced.rowCount + 1;
    reduced.addRow([
      r.name,
      r.wishDays,
      r.wish / 60,
      r.days,
      {
        formula: `SUMIF('計算'!$B$2:$B$${last},A${n},'計算'!$F$2:$F$${last})`,
        result: r.actual / 60,
      },
      {
        formula: `SUMIF('計算'!$B$2:$B$${last},A${n},'計算'!$G$2:$G$${last})`,
        result: r.reduced / 60,
      },
      { formula: `F${n}/8`, result: r.reduced / 480 },
      r.reducedDays,
      r.offDays,
      r.shortDays,
      ...dates.map((date) => ({
        formula: `'計算'!G${calcRows[r.id + "|" + date]}`,
        result: (r.entries.find((x) => x.date === date)?.reduction ?? 0) / 60,
      })),
    ]);
  }
  for (const sheet of wb.worksheets) {
    if (sheet !== schedule && sheet !== wishes) {
      sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
      sheet.pageSetup.printTitlesRow = "1:1";
      sheet.columns.forEach((c, i) => (c.width = i === 0 ? 25 : 17));
    }
    sheet.eachRow((row, n) => {
      row.height = 28;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = {
          name: "Yu Gothic",
          size: 10,
          color: { argb: "FF24445E" },
        };
        cell.alignment = {
          horizontal: Number(cell.col) === 1 ? "left" : "center",
          vertical: "middle",
          wrapText: true,
        };
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFDFE8F0" } },
        };
        if (n === 1 || ((sheet === schedule || sheet === wishes) && n === 3)) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF173F60" },
          };
          cell.font = {
            name: "Yu Gothic",
            size: n === 1 && (sheet === schedule || sheet === wishes) ? 14 : 10,
            bold: true,
            color: { argb: "FFFFFFFF" },
          };
        }
        if (
          typeof cell.value === "number" ||
          (cell.value &&
            typeof cell.value === "object" &&
            "formula" in cell.value)
        )
          cell.numFmt = "0.##";
      });
    });
    sheet.headerFooter.oddFooter = "LIBERTY SHIFT SCHEDULER | &P / &N";
  }
  check.getColumn(8).width = 76;
  check.eachRow((r, n) => {
    if (n > 1)
      r.height = Math.max(
        28,
        Math.min(200, String(r.getCell(8).value ?? "").split("\n").length * 15),
      );
  });
  codes.getColumn(1).width = 35;
  calc.getColumn(12).width = 48;
  return wb;
}
export async function exportExcel(s: State) {
  const wb = await workbook(s),
    buffer = await wb.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as ArrayBuffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
