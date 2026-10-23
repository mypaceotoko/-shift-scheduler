import test from "node:test";
import ExcelJS from "exceljs";
import assert from "node:assert/strict";
import {
  audit,
  budget,
  generate,
  reductions,
  violations,
  work,
} from "../src/lib/v2/engine";
import {
  defaultDay,
  initialState,
  parseWish,
  days,
  stateSchema,
  type Assignment,
  type Person,
  type State,
} from "../src/lib/v2/model";
import { readLegacy } from "../src/lib/v2/storage";
import { workbook } from "../src/lib/v2/workbook";
const date = "2026-10-13";
const member = (
  id: string,
  wish = "○",
  contract: Person["contract"] = "general",
): Person => ({
  id,
  name: id,
  department: "porter",
  contract,
  active: true,
  allowed: [],
  excluded: [],
  notes: "",
  wishes: { [date]: parseWish(wish, true) },
});
const setup = (people: Person[]) => ({ ...initialState(), people });
const custom = (id: string, start = "10:00", end = "14:00"): Assignment => ({
  personId: id,
  date,
  code: "CUSTOM",
  start,
  end,
  rest: 0,
  manual: false,
});
const make = (s: State, options: Partial<ReturnType<typeof defaultDay>> = {}) =>
  generate(s, date, date, [{ ...defaultDay(date), ...options }]);
test("strict parser never converts OCR look-alikes or blank into availability", () => {
  for (const raw of ["", "O", "U", "0", "?", "○ ／", "25-28", "10:99-16", "早"])
    assert.equal(parseWish(raw).kind, "unknown", raw);
  assert.equal(parseWish("有").kind, "leave");
  assert.equal(parseWish("１８.５－").start, "18:30");
  assert.equal(parseWish("-14").end, "14:00");
});
test("work minutes ignore legacy headcount weights", () => {
  assert.equal(work(custom("a", "10:00", "16:00")), 360);
  assert.equal(work({ ...custom("a", "10:00", "19:00"), rest: 60 }), 480);
  assert.equal(work(custom("a", "18:30", "23:00")), 270);
});
test("off, leave, unknown, unreviewed and unknown contract cannot be allocated", () => {
  const s = setup([
    member("off", "／"),
    member("leave", "有給"),
    member("unknown", "?"),
    { ...member("unreviewed"), wishes: { [date]: parseWish("○", false) } },
    member("contract", "○", "unknown"),
  ]);
  assert.equal(make(s).assignments.length, 0);
});
test("weekday stays <=24 actual hours, with zero hard violations", () => {
  const s = setup(Array.from({ length: 5 }, (_, i) => member("p" + i)));
  s.plan = make(s);
  assert.ok(s.plan.assignments.length >= 3);
  assert.ok(s.plan.assignments.reduce((n, a) => n + work(a), 0) <= 1440);
  assert.equal(audit(s).filter((i) => i.level === "error").length, 0);
});
test("KB rule follows staff identity after rename; generated durations are 4h/8h", () => {
  const s = setup(
    Array.from({ length: 5 }, (_, i) => ({
      ...member("id" + i, "○", "kb"),
      name: "改名 " + i,
    })),
  );
  const p = make(s);
  for (const a of p.assignments) assert.ok([240, 480].includes(work(a)));
});
test("18:30 window: KB starts at 19:00 for 4h, no time violation", () => {
  const s = setup([member("kb", "18.5-", "kb"), member("general", "18.5-")]),
    p = make(s);
  assert.ok(p.assignments.length);
  for (const a of p.assignments)
    assert.ok(a.start >= "18:30" && a.end <= "23:00");
  assert.equal(work(p.assignments.find((a) => a.personId === "kb")!), 240);
});
test("fixed preferences respect excluded codes", () => {
  const p = member("x", "F");
  p.excluded = ["F"];
  assert.equal(make(setup([p])).assignments.length, 0);
});
test("front A is 08:45-17:45; porter A is invalid", () => {
  const p = { ...member("f", "A"), department: "front" as const };
  assert.equal(make(setup([p])).assignments[0].start, "08:45");
  assert.equal(make(setup([member("p", "A")])).assignments.length, 0);
});
test("department closures remain separate", () => {
  const s = setup([member("p"), { ...member("f", "A"), department: "front" }]);
  const plan = make(s, { porterClosed: true });
  assert.deepEqual(
    plan.assignments.map((a) => a.personId),
    ["f"],
  );
});
test("invalid manual cell blocks regeneration, not silently dropped", () => {
  const s = setup([member("x", "／")]);
  s.plan = {
    start: date,
    end: date,
    days: [defaultDay(date)],
    assignments: [{ ...custom("x"), manual: true }],
    lockedOff: [],
  };
  assert.throws(() => generate(s, date, date, s.plan!.days), /保護セル/);
});
test("manual off and valid manual shift survive regeneration", () => {
  const s = setup([member("a"), member("b")]),
    lock = { ...custom("a"), manual: true };
  s.plan = {
    start: date,
    end: date,
    days: [defaultDay(date)],
    assignments: [lock],
    lockedOff: [date + "|b"],
  };
  assert.deepEqual(generate(s, date, date, s.plan.days).assignments, [lock]);
});
test("independent audit catches duplicate, six-hour KB, window violations and breaks", () => {
  const s = setup([member("x", "18-", "kb")]),
    a = custom("x", "10:00", "16:00");
  s.plan = {
    start: date,
    end: date,
    days: [defaultDay(date)],
    assignments: [a, a],
    lockedOff: [],
  };
  assert.ok(audit(s).some((i) => i.code === "duplicate"));
  assert.ok(audit(s).some((i) => i.message.includes("KB双葉")));
  assert.ok(audit(s).some((i) => i.message.includes("範囲外")));
  assert.ok(
    violations(
      { ...custom("x", "10:00", "19:00"), rest: 0 },
      member("x"),
      defaultDay(date),
      s,
    ).some((e) => e.includes("休憩")),
  );
});
test("explicit zero-day and weekly caps are not relaxed", () => {
  const p = member("x");
  p.maxTotal = 0;
  assert.equal(make(setup([p])).assignments.length, 0);
  p.maxTotal = undefined;
  p.maxWeek = 0;
  assert.equal(make(setup([p])).assignments.length, 0);
});
test("paid leave and unknown wishes do not inflate reduction baseline", () => {
  const s = setup([
    member("leave", "有"),
    member("blank", ""),
    member("kb", "○", "kb"),
  ]);
  s.plan = {
    start: date,
    end: date,
    days: [defaultDay(date)],
    assignments: [custom("kb")],
    lockedOff: [],
  };
  const r = reductions(s);
  assert.equal(r[0].wish, 0);
  assert.equal(r[1].wish, 0);
  assert.equal(r[2].reduced, 240);
  assert.equal(r[2].reduced / 480, 0.5);
});
test("holiday budget includes 2026-09-22; invalid JSON and duplicate IDs rejected", () => {
  assert.equal(budget(defaultDay("2026-09-22")).target, 1680);
  assert.equal(
    stateSchema.safeParse({ schemaVersion: 2, people: [] }).success,
    false,
  );
  const s = setup([member("x"), member("x")]);
  assert.equal(stateSchema.safeParse(s).success, false);
});
test("legacy migration retains wishes unconfirmed and requires contract confirmation", () => {
  const s = readLegacy(
    JSON.stringify({
      state: {
        members: [
          {
            id: "x",
            name: "スタッフ",
            active: true,
            preferences: { [date]: { note: "○" } },
          },
        ],
        schedule: null,
      },
    }),
  );
  assert.equal(s.people[0].contract, "unknown");
  assert.equal(s.people[0].wishes[date].reviewed, false);
  assert.equal(make(s).assignments.length, 0);
});
test("six-sheet Excel has exact snapshots, formulas, freeze panes and text-only names", async () => {
  const s = setup([member("=1+1", "○", "kb")]);
  s.plan = {
    start: date,
    end: date,
    days: [defaultDay(date)],
    assignments: [custom("=1+1")],
    lockedOff: [],
    generatedAt: new Date().toISOString(),
  };
  const wb = await workbook(s);
  assert.deepEqual(
    wb.worksheets.map((s) => s.name),
    ["シフト案", "希望読取", "チェック", "コード設定", "計算", "削減集計"],
  );
  assert.equal(wb.getWorksheet("計算")!.getCell("F2").result, 4);
  assert.equal(wb.getWorksheet("削減集計")!.getCell("F2").result, 4);
  assert.equal(wb.getWorksheet("希望読取")!.getCell("A6").type, 3);
  assert.equal(wb.getWorksheet("シフト案")!.views[0].state, "frozen");
  assert.ok((await wb.xlsx.writeBuffer()).byteLength > 1000);
  const roundTrip = new ExcelJS.Workbook();
  await roundTrip.xlsx.load(await wb.xlsx.writeBuffer());
  assert.equal(roundTrip.getWorksheet("計算")!.getCell("F2").result, 4);
  assert.equal(roundTrip.getWorksheet("希望読取")!.getCell("A6").type, 3);
  assert.equal(roundTrip.getWorksheet("シフト案")!.views[0].state, "frozen");
});
test("31-day mixed contracts: no hard violations and bounded compute", () => {
  const ds = days("2026-10-11", "2026-11-10"),
    s = setup(
      Array.from({ length: 6 }, (_, i) => ({
        ...member("m" + i, "○", i < 3 ? "kb" : "general"),
        wishes: Object.fromEntries(
          ds.map((d, n) => [
            d,
            parseWish(
              (n + i) % 7 === 0 ? "／" : (n + i) % 11 === 0 ? "18.5-" : "○",
              true,
            ),
          ]),
        ),
      })),
    );
  const start = Date.now();
  s.plan = generate(s, ds[0], ds.at(-1)!, ds.map(defaultDay));
  assert.equal(audit(s).filter((i) => i.level === "error").length, 0);
  assert.ok(Date.now() - start < 60000);
});
