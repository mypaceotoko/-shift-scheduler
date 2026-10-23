import { test, expect } from "@playwright/test";
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
  await page
    .getByLabel("希望表ファイル", { exact: true })
    .setInputFiles({
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
  const ack = page.getByRole("checkbox", {
    name: /不足時間帯・人件費超過などを確認/,
  });
  if (await ack.count()) await ack.check();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "↓ 6シートのExcelを保存", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  expect(errors).toEqual([]);
});
test("invalid HEIC produces an explanation and manual fallback remains usable", async ({
  page,
}) => {
  await page.goto("import/");
  await page
    .getByLabel("希望表ファイル", { exact: true })
    .setInputFiles({
      name: "invalid.heic",
      mimeType: "image/heic",
      buffer: Buffer.from("invalid"),
    });
  await expect(page.getByRole("alert")).toContainText("HEIC");
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
