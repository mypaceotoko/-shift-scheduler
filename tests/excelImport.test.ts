/**
 * Tests for the multi-strategy Excel preference importer.
 *
 * Run with:  npx tsx --test tests/excelImport.test.ts
 *
 * Each test builds a workbook in-memory via SheetJS, writes it to an
 * ArrayBuffer, then runs `parseWorkbook` and asserts on the structured
 * result. We deliberately avoid going through the React UI so the parser
 * is exercised in isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseWorkbook } from "../src/lib/excelImport";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Cell = string | number | null;
type Matrix = Cell[][];

/** Build a single-sheet workbook from a 2D array and return it as ArrayBuffer. */
function makeWorkbook(
  matrix: Matrix,
  sheetName = "Sheet1",
  extras: { name: string; matrix: Matrix; merges?: XLSX.Range[] }[] = [],
  merges: XLSX.Range[] = [],
): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  if (merges.length) ws["!merges"] = merges;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  for (const ex of extras) {
    const ws2 = XLSX.utils.aoa_to_sheet(ex.matrix);
    if (ex.merges?.length) ws2["!merges"] = ex.merges;
    XLSX.utils.book_append_sheet(wb, ws2, ex.name);
  }
  // SheetJS returns a Node Buffer when type:"buffer" — that's the most
  // portable option in a Node test environment.
  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  // Copy into a fresh ArrayBuffer so the parser doesn't see a Buffer pool view.
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}

// ---------------------------------------------------------------------------
// 1. Basic flow with explicit ISO dates
// ---------------------------------------------------------------------------

test("explicit ISO header on row 1 — basic happy path", () => {
  const buf = makeWorkbook([
    ["名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["山田", "○", "/", "13-18"],
    ["佐藤", "B", "○", ""],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.errors.length, 0);
  assert.equal(r.dates.length, 3);
  assert.deepEqual(r.dates, ["2026-05-01", "2026-05-02", "2026-05-03"]);
  assert.equal(r.members.length, 2);
  assert.equal(r.byMember["山田"]["2026-05-01"].status, "available");
  assert.equal(r.byMember["山田"]["2026-05-02"].status, "unavailable");
  assert.equal(r.byMember["山田"]["2026-05-03"].status, "restricted");
  assert.equal(r.byMember["佐藤"]["2026-05-01"].status, "fixed");
});

// ---------------------------------------------------------------------------
// 2. Column order varies — name column not at index 0
// ---------------------------------------------------------------------------

test("name column at non-zero index is detected", () => {
  const buf = makeWorkbook([
    ["#", "備考", "名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["1", "メモ", "山田", "○", "○", "○"],
    ["2", "", "佐藤", "/", "○", "○"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.members, ["山田", "佐藤"]);
});

// ---------------------------------------------------------------------------
// 3. Header not on row 1 (decorative rows above)
// ---------------------------------------------------------------------------

test("header row deeper than row 1 is detected", () => {
  const buf = makeWorkbook([
    ["シフト希望表", "", "", ""],
    ["", "", "", ""],
    ["店舗: 渋谷", "", "", ""],
    ["名前", "2026-05-10", "2026-05-11", "2026-05-12"],
    ["山田", "○", "B", "/"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.errors.length, 0);
  assert.equal(r.members.length, 1);
});

// ---------------------------------------------------------------------------
// 4. Merged cells — "X月" merged across the day-number block
// ---------------------------------------------------------------------------

test("merged month-context cell propagates to all day-number columns", () => {
  // Row 0: A1 says "2026年5月" merged to D1 (cols 0..3).
  // Row 1: day numbers 1..5 below; only days 1..3 fall under the merge
  // (cols 0..3 — but col 0 is the name-column header).
  const matrix: Matrix = [
    ["2026年5月", "", "", "", ""],
    ["名前", 1, 2, 3, 4],
    ["山田", "○", "○", "/", "○"],
  ];
  const buf = makeWorkbook(matrix, "Sheet1", [], [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026, startMonth: 5 });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.dates.slice(0, 4), [
    "2026-05-01",
    "2026-05-02",
    "2026-05-03",
    "2026-05-04",
  ]);
});

// ---------------------------------------------------------------------------
// 5. Lots of blank rows / blank cols
// ---------------------------------------------------------------------------

test("blank rows and columns are tolerated", () => {
  const buf = makeWorkbook([
    ["", "", "", "", ""],
    ["", "", "", "", ""],
    ["", "名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["", "", "", "", ""],
    ["", "山田", "○", "/", "○"],
    ["", "", "", "", ""],
    ["", "佐藤", "○", "○", "/"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.members.length, 2);
  assert.equal(r.dates.length, 3);
});

// ---------------------------------------------------------------------------
// 6. Mixed availability symbols (○ ◯ × 休 不可 可)
// ---------------------------------------------------------------------------

test("availability symbol synonyms normalize to canonical statuses", () => {
  const buf = makeWorkbook([
    ["名前", "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"],
    ["山田", "◯", "×", "休", "不可", "可"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  const p = r.byMember["山田"];
  assert.equal(p["2026-05-01"].status, "available");
  assert.equal(p["2026-05-02"].status, "unavailable");
  assert.equal(p["2026-05-03"].status, "unavailable");
  assert.equal(p["2026-05-04"].status, "unavailable");
  assert.equal(p["2026-05-05"].status, "available");
});

// ---------------------------------------------------------------------------
// 7. Multiple sheets — picker selects the real preference table
// ---------------------------------------------------------------------------

test("workbook with multiple sheets — picks the real shift table", () => {
  const buf = makeWorkbook(
    // Sheet 1: a cover/legend sheet with no real table
    [
      ["凡例"],
      ["○ = 出勤可"],
      ["× = 出勤不可"],
    ],
    "凡例",
    [
      {
        name: "希望表",
        matrix: [
          ["名前", "2026-05-01", "2026-05-02", "2026-05-03"],
          ["山田", "○", "/", "○"],
          ["佐藤", "○", "○", "/"],
        ],
      },
    ],
  );
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.selectedSheet, "希望表", "should pick the data sheet, not the legend");
  assert.equal(r.members.length, 2);
});

// ---------------------------------------------------------------------------
// 8. Date range filter — out-of-range cells are excluded and counted
// ---------------------------------------------------------------------------

test("date range filter drops out-of-range dates", () => {
  const buf = makeWorkbook([
    ["名前", "2026-04-29", "2026-04-30", "2026-05-01", "2026-05-02", "2026-06-01"],
    ["山田", "○", "○", "○", "○", "○"],
  ]);
  const r = parseWorkbook(buf, {
    defaultYear: 2026,
    rangeStart: "2026-05-01",
    rangeEnd: "2026-05-31",
  });
  assert.deepEqual(r.dates, ["2026-05-01", "2026-05-02"]);
  assert.equal(r.excludedOutOfRange, 3);
  // The legacy byMember view also reflects only in-range data.
  assert.equal(Object.keys(r.byMember["山田"]).length, 2);
});

// ---------------------------------------------------------------------------
// 9. Name whitespace variations — leading/trailing/full-width spaces
// ---------------------------------------------------------------------------

test("name with surrounding whitespace is preserved as a member row", () => {
  const buf = makeWorkbook([
    ["名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["  山田 太郎 ", "○", "○", "/"],
    ["佐藤　花子", "○", "/", "○"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.equal(r.members.length, 2);
  assert.ok(r.members[0].includes("山田"));
  assert.ok(r.members[1].includes("佐藤"));
});

// ---------------------------------------------------------------------------
// 10. Multi-info cells — "○ 13-18" should pick the most specific marker
// ---------------------------------------------------------------------------

test("cell with multiple tokens picks the most informative one", () => {
  const buf = makeWorkbook([
    ["名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["山田", "○ 13-18", "B", "○"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  const a = r.byMember["山田"]["2026-05-01"];
  assert.equal(a.status, "restricted", "time range should win over plain ○");
  assert.deepEqual(a.customRange, { start: "13:00", end: "18:00" });
  assert.equal(r.byMember["山田"]["2026-05-02"].status, "fixed");
});

// ---------------------------------------------------------------------------
// 11. Day-number-only header with separate "X月" row (Japanese template)
// ---------------------------------------------------------------------------

test("X月 month-context row + bare day numbers", () => {
  const buf = makeWorkbook([
    ["", "5月", "", "", ""],
    ["名前", 1, 2, 3, 4],
    ["山田", "○", "/", "○", "○"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026, startMonth: 5 });
  assert.deepEqual(r.dates, ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"]);
});

// ---------------------------------------------------------------------------
// 12. Trailing summary rows ("出勤人数", "合計") should not become members
// ---------------------------------------------------------------------------

test("出勤人数 / 合計 footers do not get treated as members", () => {
  const buf = makeWorkbook([
    ["名前", "2026-05-01", "2026-05-02", "2026-05-03"],
    ["山田", "○", "○", "/"],
    ["佐藤", "○", "/", "○"],
    ["出勤人数", 2, 1, 1],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.deepEqual(r.members, ["山田", "佐藤"]);
});

// ---------------------------------------------------------------------------
// 13. Failure path — file with no detectable header still returns a structured
//     result rather than throwing.
// ---------------------------------------------------------------------------

test("unrecognizable sheet returns an error string, not an exception", () => {
  const buf = makeWorkbook([
    ["これはメモだけのシートです"],
    ["特に表ではありません"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.ok(r.errors.length > 0);
  assert.equal(r.members.length, 0);
});

// ---------------------------------------------------------------------------
// 14. M/D format with weekday parens — "5/1(金)"
// ---------------------------------------------------------------------------

test("M/D(曜) header format is recognized", () => {
  const buf = makeWorkbook([
    ["名前", "5/1(金)", "5/2(土)", "5/3(日)"],
    ["山田", "○", "○", "/"],
  ]);
  const r = parseWorkbook(buf, { defaultYear: 2026 });
  assert.deepEqual(r.dates, ["2026-05-01", "2026-05-02", "2026-05-03"]);
});
