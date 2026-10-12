import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Opt-in only: the target MUST be an isolated Aha data directory and a local
// mock Images API. Normal test runs never connect to a configured provider.
const target = process.env.AHA_DRAWING_E2E_URL;
const mock = process.env.AHA_DRAWING_E2E_MOCK_URL;
let browser: Browser | undefined;
let lastPage: Page | undefined;
async function dismissStartupSheets(page: Page) {
  for (let i = 0; i < 12; i++) {
    for (const name of [/^Skip setup$/, /^Not now$/, /^Skip tour$/]) {
      const button = page.getByRole("button", { name });
      if (await button.isVisible()) await button.click({ timeout: 1000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
}

afterAll(async () => {
  if (lastPage && !lastPage.isClosed()) {
    console.log("FINAL_URL", lastPage.url(), await lastPage.locator("body").innerText());
    await lastPage.screenshot({ path: "/private/tmp/aha-drawing-last.png" });
  }
  await browser?.close();
});
describe.skipIf(!target || !mock)("drawing workspace through the real UI and RPC", () => {
  it("discovers, generates, annotates, inpaints, restores and reports errors", async () => {
    if (
      !target ||
      !mock ||
      ![target, mock].every((url) => new URL(url).hostname.match(/^(127\.0\.0\.1|localhost)$/u))
    )
      throw new Error("E2E requires a local mock provider.");
    const providerName = `E2E Mock ${Date.now()}`;
    const originalPrompt = `E2E mountain landscape ${Date.now()}`;
    const editedPrompt = `E2E edited landscape ${Date.now()}`;
    const failedPrompt = `MOCK_FAIL E2E no retry ${Date.now()}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.AHA_DRAWING_E2E_CHROME ? { channel: "chrome" } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    lastPage = page;
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) =>
      console.log("FAILED_REQUEST", request.url(), request.failure()),
    );
    page.on("console", (message) => {
      if (message.type() === "error") console.log("BROWSER_ERROR", message.text());
    });
    await page.goto(target);
    await dismissStartupSheets(page);
    await page.goto(target);
    await dismissStartupSheets(page);
    await page
      .getByRole("button", { name: /Image provider settings|生图供应商设置/ })
      .first()
      .click();
    await dismissStartupSheets(page);
    await page
      .getByRole("button", { name: /Add image provider|添加生图供应商/ })
      .first()
      .click();
    const form = page.locator("#image-provider-form");
    await form.getByLabel(/Name|名称/, { exact: true }).fill(providerName);
    await form.getByLabel("Base URL").fill(`${mock}/v1`);
    await page.getByRole("button", { name: /^Discover models$|^探测模型$/ }).click();
    await form.getByRole("checkbox", { name: "gpt-image-mock", exact: false }).check();
    await form.getByRole("checkbox", { name: "gpt-image-second", exact: false }).check();
    await form.getByLabel(/Default model|默认模型/).selectOption("gpt-image-mock");
    await page.getByRole("button", { name: /^Save$|^保存$/ }).click();
    await page.goto(target);
    const prompt = page.getByRole("textbox", { name: /Image prompt|图片提示词/ });
    await prompt.fill(originalPrompt);
    // Always select the mock we just created. A persisted provider preference
    // must never cause this opt-in test to call an unrelated paid provider.
    await page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: providerName }) })
      .selectOption({ label: providerName });
    await page
      .locator("summary")
      .filter({ hasText: /Image parameters|图片参数/ })
      .click();
    await page.getByLabel(/Image count|张数/).fill("2");
    await page.getByRole("button", { name: /^Generate ·|^生成 ·/ }).click();
    const card = page.locator("article").filter({ hasText: originalPrompt }).first();
    await card.locator("img").first().waitFor();
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll("article")]
          .find((a) => a.textContent?.includes(text))
          ?.querySelectorAll("img").length === 2,
      originalPrompt,
    );
    expect(await card.locator("img").count()).toBe(2);
    await card.locator("img").first().click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /^Download$|^下载$/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
    await page.getByRole("button", { name: /Use as reference|作为参考图/ }).click();
    await page.getByRole("button", { name: /^Annotate$|^画板标注$/ }).click();
    let canvas = page.locator("canvas");
    await canvas.waitFor();
    await page
      .getByRole("button", { name: /Use as reference|作为参考图/ })
      .waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((b) =>
        /作为参考图|Use as reference/.test(b.textContent ?? ""),
      );
      return b && !b.disabled;
    });
    let bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Missing canvas");
    await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6, {
      steps: 10,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: /Use as reference|作为参考图/ }).click();
    await page.getByRole("button", { name: /^Inpaint$|^局部重绘$/ }).click();
    canvas = page.locator("canvas");
    await canvas.waitFor();
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((b) =>
        /使用遮罩|Use mask/.test(b.textContent ?? ""),
      );
      return b && !b.disabled;
    });
    bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Missing mask canvas");
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();
    const artifacts = path.resolve(".smoke/drawing");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "mask-e2e.png") });
    await page.getByRole("button", { name: /Use mask|使用遮罩/ }).click();
    await prompt.fill(editedPrompt);
    await page.getByLabel(/Image count|张数/).fill("1");
    await page.getByRole("button", { name: /^Generate ·|^生成 ·/ }).click();
    await page
      .locator("article")
      .filter({ hasText: editedPrompt })
      .first()
      .locator("img")
      .waitFor();
    await page.reload();
    await prompt.waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false,
    );
    expect(await prompt.inputValue()).toBe(editedPrompt);
    expect(await page.getByRole("button", { name: /Edit mask|编辑遮罩/ }).count()).toBe(1);
    await prompt.fill(failedPrompt);
    await page.getByRole("button", { name: /^Generate ·|^生成 ·/ }).click();
    await page
      .locator("article")
      .filter({ hasText: failedPrompt })
      .first()
      .getByRole("alert")
      .waitFor();
    const response = await fetch(`${mock}/status`);
    const requests = (await response.json()) as Array<{
      prompt: string;
      path: string;
      hasMask: boolean;
      referenceCount: number;
    }>;
    expect(requests.filter((r) => r.prompt === failedPrompt)).toHaveLength(1);
    expect(
      requests.some(
        (r) =>
          r.prompt === editedPrompt &&
          r.path === "/v1/images/edits" &&
          r.hasMask &&
          r.referenceCount === 2,
      ),
    ).toBe(true);
    await page
      .locator("article")
      .filter({ hasText: failedPrompt })
      .first()
      .getByRole("button", { name: /^Delete$|^删除$/ })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
    await page.locator("article").filter({ hasText: failedPrompt }).waitFor({ state: "detached" });
    await page.screenshot({ path: path.join(artifacts, "drawing-e2e.png"), fullPage: true });
    await page.setViewportSize({ width: 480, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(artifacts, "drawing-narrow-e2e.png") });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(new URL("/settings?section=appearance", target).toString());
    // Language selection is owned by the native Aha appearance bridge and is
    // unavailable in the plain web test target. Verify its supported theme UI.
    await page.getByRole("radio", { name: /^Dark$|^深色$/ }).click();
    await page.goto(target);
    await page.getByRole("heading", { name: /^Drawing$|^绘图$/ }).waitFor();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.screenshot({ path: path.join(artifacts, "drawing-dark-e2e.png") });
    expect(errors).toEqual([]);
    await context.close();
  }, 90000);
});
