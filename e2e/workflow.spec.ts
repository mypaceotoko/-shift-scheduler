import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
test("verified CSV → staff contracts → worker generation → edit/undo → Excel and persistence", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "シフト管理", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((e) => e.clientWidth),
  );
  await page
    .getByRole("link", { name: "希望表を取り込む →", exact: true })
    .click();
  await page.getByLabel("希望表ファイル", { exact: true }).setInputFiles({
    name: "wishes.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "名前,2026-10-13,2026-10-14\nテスト甲,○,／\nテスト乙,18.5-,有給\nテスト丙,○,○\nテスト丁,○,○\n",
    ),
  });
  await expect(
    page.getByLabel("テスト甲 2026-10-13 希望", { exact: true }),
  ).toBeVisible();
  // File selection must not mutate confirmed people.
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("liberty-shift-state-v2")!).people
          .length,
    ),
  ).toBe(0);
  await page
    .getByRole("checkbox", {
      name: "原本の氏名・年月日と、表の行列対応を確認しました",
    })
    .check();
  await page
    .getByRole("button", { name: "判読できたセルを原本と照合済みにする" })
    .click();
  await page
    .getByRole("button", { name: "勤務希望として反映 → スタッフ確認" })
    .click();
  await expect(
    page.getByLabel("テスト甲 契約区分", { exact: true }),
  ).toBeVisible();
  for (const name of ["テスト甲", "テスト乙", "テスト丙", "テスト丁"])
    await page
      .getByLabel(name + " 契約区分", { exact: true })
      .selectOption(name === "テスト乙" ? "kb" : "general");
  await page.getByRole("link", { name: "生成へ →", exact: true }).click();
  await page.getByLabel("開始日", { exact: true }).fill("2026-10-13");
  await page.getByLabel("終了日", { exact: true }).fill("2026-10-14");
  await page.getByRole("button", { name: "✦ シフト案を自動生成" }).click();
  await expect(
    page.getByRole("button", { name: "✦ シフト案を自動生成" }),
  ).toBeEnabled({ timeout: 60000 });
  await expect(
    page.getByRole("link", { name: "監査・調整へ →", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "監査・調整へ →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "シフトの監査・調整", exact: true }),
  ).toBeVisible();
  const plans = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("liberty-shift-state-v2")!),
  );
  expect(plans.plan.assignments.length).toBeGreaterThan(0);
  const kb = plans.people.find((p: { name: string }) => p.name === "テスト乙");
  for (const a of plans.plan.assignments.filter(
    (a: { personId: string }) => a.personId === kb.id,
  )) {
    expect(a.start >= "18:30").toBe(true);
    expect(a.end <= "23:00").toBe(true);
  }
  const first = page.getByRole("button", {
    name: /テスト甲 2026-10-13 .*を編集/,
  });
  await first.click();
  await page.getByRole("button", { name: "公休にする", exact: true }).click();
  await expect(first).toContainText("休（手動）");
  await page.getByRole("button", { name: "↶ 元に戻す", exact: true }).click();
  await expect(first).not.toContainText("休（手動）");
  await page.getByRole("button", { name: "↷ やり直す", exact: true }).click();
  await expect(first).toContainText("休（手動）");
  await page.reload();
  await expect(
    page.getByRole("button", { name: /テスト甲 2026-10-13 .*を編集/ }),
  ).toContainText("休（手動）");
  await page
    .getByRole("button", { name: "日付別（スマホ向け）", exact: true })
    .click();
  await expect(page.locator(".day-card")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("schedule.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Excel出力 →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Excel出力とバックアップ", exact: true }),
  ).toBeVisible();
  const ack = page.getByRole("checkbox", {
    name: /不足時間帯・人件費超過などを確認/,
  });
  await expect(ack).toBeVisible();
  await expect(
    page.getByRole("button", { name: "6シートのExcelを作成", exact: true }),
  ).toBeDisabled();
  await ack.check();
  await page
    .getByRole("button", { name: "6シートのExcelを作成", exact: true })
    .click();
  const ready = page.getByRole("link", {
    name: "↓ 作成済みのExcelをダウンロード",
    exact: true,
  });
  await expect(ready).toBeVisible();
  const download = page.waitForEvent("download", { timeout: 15000 });
  await ready.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
  const path = await file.path();
  expect(path).toBeTruthy();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path!);
  expect(wb.worksheets.map((s) => s.name)).toEqual([
    "シフト案",
    "希望読取",
    "チェック",
    "コード設定",
    "計算",
    "削減集計",
  ]);
  expect(wb.getWorksheet("シフト案")!.getCell("A6").text).toContain("テスト甲");
  expect(errors).toEqual([]);
});
test("invalid HEIC produces an explanation and manual fallback remains usable", async ({
  page,
}) => {
  await page.goto("import/");
  await page.getByLabel("希望表ファイル", { exact: true }).setInputFiles({
    name: "invalid.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("invalid"),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "HEIC" }),
  ).toContainText("HEIC");
  await page
    .getByText("手入力の表を用意する / 読取に失敗した場合", { exact: true })
    .click();
  await page
    .getByLabel("スタッフ名（1行1名）", { exact: true })
    .fill("手入力スタッフ");
  await page.getByRole("button", { name: "指定期間の入力表を用意" }).click();
  await expect(
    page.getByLabel("氏名 手入力スタッフ", { exact: true }),
  ).toBeVisible();
});

test("multi-page PDF renders and a blank OCR result stays unconfirmed", async ({
  page,
}) => {
  test.setTimeout(120000);
  // Synthetic blank PDF: no private source documents or staff data in fixtures.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await page.goto("import/");
  await page.getByLabel("希望表ファイル", { exact: true }).setInputFiles({
    name: "two-pages.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(pdf),
  });
  const pages = page.getByLabel("原本ページ", { exact: true });
  await expect(pages.locator("option")).toHaveCount(2);
  await pages.selectOption("1");
  const preview = page.getByRole("img", {
    name: "two-pages.pdf · 2ページ",
    exact: true,
  });
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "このページを読み取る", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "日付列と氏名行を検出できません" }),
  ).toBeVisible({ timeout: 90000 });
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("liberty-shift-state-v2")!).people
          .length,
    ),
  ).toBe(0);
  await page.reload();
  await expect(
    page.getByLabel("原本ページ", { exact: true }).locator("option"),
  ).toHaveCount(2);
});
