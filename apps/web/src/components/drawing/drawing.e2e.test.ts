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
      viewport: { width: 1440, height: 900 },
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
    await page.getByRole("button", { name: /^Image model$|^生图模型$/ }).click();
    const assertMenuWidth = async () => {
      for (const popup of await page
        .locator('[data-slot="menu-popup"], [data-slot="menu-sub-content"]')
        .all()) {
        expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        for (const body of await popup.locator('[data-slot="menu-popup-body"]').all()) {
          expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
      }
    };
    await page.getByPlaceholder(/Search models or providers|搜索模型或供应商/).waitFor();
    await assertMenuWidth();
    const providerRow = page
      .locator('[data-slot="menu-sub-trigger"]')
      .filter({ hasText: providerName });
    await providerRow.waitFor();
    const nameBounds = await providerRow
      .locator("span[title]")
      .evaluate((el) => ({ width: el.getBoundingClientRect().width, text: el.textContent }));
    expect(nameBounds.width).toBeGreaterThan(80);
    expect(nameBounds.text).toBe(providerName);
    await providerRow.hover();
    await page.getByRole("menuitemradio", { name: "gpt-image-second", exact: true }).waitFor();
    await assertMenuWidth();
    const artifacts = path.resolve(".smoke/drawing");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "drawing-provider-picker-fixed.png") });
    await page.getByRole("menuitemradio", { name: "gpt-image-second", exact: true }).click();
    await page
      .getByRole("button", { name: /^Image model$|^生图模型$/ })
      .filter({ hasText: "gpt-image-second" })
      .waitFor();
    await page
      .getByPlaceholder(/Search models or providers|搜索模型或供应商/)
      .waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^Image model$|^生图模型$/ }).click();
    await page.getByPlaceholder(/Search models or providers|搜索模型或供应商/).fill(providerName);
    await page.getByRole("menuitem").filter({ hasText: "gpt-image-mock" }).first().click();
    // Selecting the already active model must close the controlled menu too.
    await page.getByRole("button", { name: /^Image model$|^生图模型$/ }).click();
    await providerRow.hover();
    await page.getByRole("menuitemradio", { name: "gpt-image-mock", exact: true }).click();
    await page
      .getByPlaceholder(/Search models or providers|搜索模型或供应商/)
      .waitFor({ state: "detached" });
    const setCount = async (n: number) => {
      await page.getByRole("button", { name: /^Image count:|^张数:/ }).click();
      await page.getByRole("menuitemradio", { name: String(n), exact: true }).click();
    };
    const referenceAction = async (name: RegExp) => {
      await page.getByRole("button", { name: /^Reference actions 1$|^参考图操作 1$/ }).click();
      await page.getByRole("menuitem", { name }).click();
    };
    const pickParameter = async (label: RegExp, option: RegExp) => {
      await page.getByRole("button", { name: label }).click();
      await page.getByRole("menuitemradio", { name: option }).click();
    };
    await pickParameter(/^Format:|^格式:/, /^JPEG$/);
    await pickParameter(/^Background:|^背景:/, /^Transparent$|^透明$/);
    await page
      .getByRole("status")
      .filter({ hasText: /Output format changed to PNG|透明背景已切换为 PNG/ })
      .waitFor();
    expect(await page.getByRole("button", { name: /^Format:|^格式:/ }).innerText()).toContain(
      "PNG",
    );
    await pickParameter(/^Format:|^格式:/, /^JPEG$/);
    await page
      .getByRole("status")
      .filter({ hasText: /JPEG does not support|JPEG 不支持/ })
      .waitFor();
    await pickParameter(/^Format:|^格式:/, /^PNG$/);
    await pickParameter(/^Background:|^背景:/, /^Auto$|^自动$/);
    await page.getByRole("button", { name: /^Quality:|^质量:/ }).click();
    await page
      .getByRole("menuitemradio", { name: /Requires model support|需模型支持/ })
      .first()
      .waitFor();
    expect(
      await page.getByRole("menuitemradio", { name: /Requires model support|需模型支持/ }).count(),
    ).toBe(2);
    expect(await page.getByText(/Provider default|供应商默认/, { exact: true }).count()).toBe(0);
    await page.screenshot({ path: path.join(artifacts, "drawing-quality-simplified.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Size$|^尺寸$/ }).click();
    let sizeDialog = page.getByRole("dialog", { name: /Set image dimensions|设置图像尺寸/ });
    await sizeDialog.getByRole("button", { name: /Custom width and height|自定义宽高/ }).click();
    const widthInput = sizeDialog.getByRole("textbox", { name: /^Width$|^宽度$/ });
    await widthInput.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("1234");
    await sizeDialog.getByRole("textbox", { name: /^Height$|^高度$/ }).fill("567");
    await sizeDialog.getByText(/Will adjust to|将调整为/).waitFor();
    await page.screenshot({ path: path.join(artifacts, "drawing-size-custom.png") });
    await sizeDialog.getByRole("button", { name: /^Confirm$|^确定$/ }).click();
    await page.getByRole("button", { name: /^Size$|^尺寸$/ }).click();
    sizeDialog = page.getByRole("dialog", { name: /Set image dimensions|设置图像尺寸/ });
    await sizeDialog.getByRole("button", { name: /By aspect ratio|按比例/ }).click();
    await sizeDialog.getByRole("button", { name: "4K", exact: true }).click();
    await sizeDialog.getByRole("button", { name: "16:9", exact: true }).click();
    await sizeDialog.getByText("3840×2160", { exact: true }).waitFor();
    expect(
      await sizeDialog
        .getByRole("button", { name: "4K", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      await sizeDialog
        .getByRole("button", { name: "16:9", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(artifacts, "drawing-size-ratio.png") });
    await sizeDialog.getByRole("button", { name: /^Cancel$|^取消$/ }).click();
    // Cancellation retains the custom dimensions; automatic is sent explicitly.
    await page.getByRole("button", { name: /^Size$|^尺寸$/ }).click();
    sizeDialog = page.getByRole("dialog", { name: /Set image dimensions|设置图像尺寸/ });
    await sizeDialog.getByRole("button", { name: /^Automatic$|^自动$/ }).click();
    await sizeDialog.getByRole("button", { name: /^Confirm$|^确定$/ }).click();
    await setCount(2);
    const composerHeight = await page
      .getByTestId("drawing-composer")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(composerHeight).toBeLessThanOrEqual(175);
    expect(
      await page.locator("header.app-top-bar").evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(44);
    await page.getByRole("button", { name: /^Generate ·|^生成 ·/ }).click();
    const card = page.locator("article").filter({ hasText: originalPrompt }).first();
    await card.locator("img").first().waitFor();
    await card
      .getByLabel(/Image count|张数/)
      .filter({ hasText: "2" })
      .waitFor();
    await card.locator("img").first().click();
    const taskDialog = page.getByRole("dialog", { name: /Image task details|绘图任务详情/ });
    await taskDialog.getByRole("button", { name: /^Image 2$|^图片 2$/ }).click();
    await page.screenshot({ path: path.join(artifacts, "drawing-detail-redesign.png") });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /^Download$|^下载$/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
    await page.getByRole("button", { name: /Use as reference|作为参考图/ }).click();
    await referenceAction(/^Annotate$|^画板标注$/);
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
    await page.getByRole("button", { name: /^Shape$|^图形$/ }).click();
    await page.getByRole("menuitem", { name: /^rectangle$|^矩形$/ }).click();
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.5, {
      steps: 6,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: /^Select object$|^选择对象$/ }).click();
    await page.mouse.move(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4, {
      steps: 4,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: /^text$|^文字$/ }).click();
    bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Missing updated canvas");
    await page.mouse.click(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.7);
    await page
      .getByRole("textbox", { name: /Annotation text|标注文字/ })
      .fill("中文标注\nSecond line");
    await page.keyboard.press("Control+Enter");
    await page.getByRole("button", { name: /^Image comment$|^图片评论$/ }).click();
    await page.mouse.click(bounds.x + bounds.width * 0.52, bounds.y + bounds.height * 0.41);
    await page
      .getByRole("textbox", { name: /Comment text|评论内容/ })
      .fill("Change this area to red");
    await page.getByRole("button", { name: /^Apply$|^应用$/ }).click();
    await page.screenshot({ path: path.join(artifacts, "drawing-objects-comments.png") });
    await page.getByRole("button", { name: /Use as reference|作为参考图/ }).click();
    await page.getByRole("button", { name: /Image 1 · 1 comments|图片 1 · 1 条评论/ }).waitFor();
    expect(await page.getByTestId("drawing-references").locator("img").count()).toBe(1);
    await page.reload();
    await prompt.waitFor();
    await page.getByRole("button", { name: /Image 1 · 1 comments|图片 1 · 1 条评论/ }).click();
    await page.getByRole("button", { name: /^Image comment 1$|^图片评论 1$/ }).waitFor();
    await page.getByRole("button", { name: /^Select object$|^选择对象$/ }).click();
    // Saving without modifications preserves the editable objects in a new version.
    await page.getByRole("button", { name: /Use as reference|作为参考图/ }).click();
    await referenceAction(/^Inpaint$|^局部重绘$/);
    canvas = page.locator("canvas");
    await canvas.waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLCanvasElement>("canvas")?.dataset.ready === "true",
    );
    expect(await page.getByRole("button", { name: /Use mask|使用遮罩/ }).isDisabled()).toBe(true);
    bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Missing mask canvas");
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();
    await page.screenshot({ path: path.join(artifacts, "mask-e2e.png") });
    await page.getByRole("button", { name: /Use mask|使用遮罩/ }).click();
    await prompt.fill(editedPrompt);
    await setCount(1);
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
    await page.getByRole("button", { name: /^Reference actions 1$|^参考图操作 1$/ }).click();
    await page.getByRole("menuitem", { name: /Edit mask|编辑遮罩/ }).waitFor();
    await page.keyboard.press("Escape");
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
      parameters: Record<string, string>;
    }>;
    for (const text of [originalPrompt, editedPrompt]) {
      expect(requests.find((r) => r.prompt.startsWith(text))?.parameters).toEqual({
        size: "auto",
        quality: "auto",
        output_format: "png",
        background: "auto",
      });
    }
    expect(requests.filter((r) => r.prompt.startsWith(failedPrompt))).toHaveLength(1);
    expect(
      requests
        .find((r) => r.prompt.startsWith(editedPrompt))
        ?.prompt.match(/Change this area to red/g),
    ).toHaveLength(1);
    expect(
      requests.some(
        (r) =>
          r.prompt.startsWith(editedPrompt) &&
          r.path === "/v1/images/edits" &&
          r.hasMask &&
          r.referenceCount === 1,
      ),
    ).toBe(true);
    const search = page.getByRole("textbox", { name: /Search image history|搜索绘图历史/ });
    await search.fill(failedPrompt);
    await page.waitForFunction(() => document.querySelectorAll("article").length === 1);
    await page.getByRole("button", { name: /History status|历史状态/ }).click();
    await page.getByRole("menuitemradio", { name: /^Completed$|^已完成$/ }).click();
    await page
      .getByRole("heading", { name: /No matching image tasks|没有匹配的绘图任务/ })
      .waitFor();
    await page.getByRole("button", { name: /History status|历史状态/ }).click();
    await page.getByRole("menuitemradio", { name: /^Issues$|^异常$/ }).click();
    const failed = page.locator("article").filter({ hasText: failedPrompt });
    await failed.getByRole("button", { name: /Task actions|任务操作/ }).click();
    await page.getByRole("menuitem", { name: /^Delete$|^删除$/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
    await page.locator("article").filter({ hasText: failedPrompt }).waitFor({ state: "detached" });
    await search.fill("");
    await page.getByRole("button", { name: /History status|历史状态/ }).click();
    await page.getByRole("menuitemradio", { name: /^All$|^全部$/ }).click();
    await page.locator("article").filter({ hasText: originalPrompt }).waitFor();
    // Seed through the real RPC so pagination and live updates are exercised
    // beyond the first page. Only the unique local mock provider is accepted.
    // Raw browser source keeps Vitest's SSR import transform out of this page.
    await page.evaluate(`(async () => {
        const { drawingApi } = await import("/src/components/drawing/useDrawing.ts");
        const api = drawingApi();
        const provider = (await api.listProviders()).find(p => p.name === ${JSON.stringify(providerName)});
        if (!provider) throw new Error("Missing isolated mock provider");
        for (let i = 0; i < 34; i++) {
          await api.createJob({
            clientRequestId: crypto.randomUUID(),
            providerId: provider.id,
            model: "gpt-image-mock",
            prompt: "E2E gallery history " + i,
            parameters: { n: 1 },
            inputAssetIds: [],
            maskAssetId: null,
            sourceJobId: null,
          });
        }
    })()`);
    const gallery = page.getByTestId("drawing-gallery");
    await page.waitForFunction(() => document.querySelectorAll("article").length >= 30);
    await gallery.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForFunction(() => document.querySelectorAll("article").length > 30);
    await gallery.evaluate((el) => {
      el.scrollTop = 500;
    });
    await page.waitForTimeout(500);
    const visibleAnchor = () =>
      gallery.evaluate((root) => {
        const top = root.getBoundingClientRect().top;
        const first = [...root.querySelectorAll<HTMLElement>("[data-job-id]")].find(
          (el) => el.getBoundingClientRect().bottom > top,
        );
        return first
          ? { id: first.dataset.jobId!, offset: first.getBoundingClientRect().top - top }
          : null;
      });
    const anchorBefore = await visibleAnchor();
    expect(anchorBefore).not.toBeNull();
    await prompt.fill(`E2E live insertion ${Date.now()}`);
    await page.getByRole("button", { name: /^Generate ·|^生成 ·/ }).click();
    await page.waitForTimeout(1200);
    const selectedCard = gallery.locator(`[data-job-id="${anchorBefore!.id}"]`);
    const anchorAfterOffset = await selectedCard.evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        el.closest('[data-testid="drawing-gallery"]')!.getBoundingClientRect().top,
    );
    expect(Math.abs(anchorAfterOffset - anchorBefore!.offset)).toBeLessThan(2);
    // Click a fully visible card so Playwright does not scroll a clipped button
    // into view before opening the dialog.
    const fullyVisibleId = await gallery.evaluate((root) => {
      const top = root.getBoundingClientRect().top;
      return [...root.querySelectorAll<HTMLElement>("[data-job-id]")].find(
        (el) => el.getBoundingClientRect().top >= top,
      )!.dataset.jobId!;
    });
    const scrollBeforeDialog = await gallery.evaluate((el) => el.scrollTop);
    await gallery.locator(`[data-job-id="${fullyVisibleId}"] button`).first().click();
    await page.getByRole("dialog", { name: /Image task details|绘图任务详情/ }).waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: /Image task details|绘图任务详情/ })
      .waitFor({ state: "detached" });
    expect(
      Math.abs((await gallery.evaluate((el) => el.scrollTop)) - scrollBeforeDialog),
    ).toBeLessThan(2);
    await gallery.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.getByRole("button", { name: /History status|历史状态/ }).click();
    await page.getByRole("menuitemradio", { name: /^Completed$|^已完成$/ }).click();
    await page.locator("article img").first().waitFor();
    await page.waitForTimeout(300);
    await prompt.fill("A quiet mountain lake at sunrise");
    await page.screenshot({ path: path.join(artifacts, "drawing-e2e.png"), fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(artifacts, "drawing-medium-e2e.png") });
    await page.setViewportSize({ width: 480, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(artifacts, "drawing-narrow-e2e.png") });
    await page.getByRole("button", { name: /^Image model$|^生图模型$/ }).click();
    await page.getByPlaceholder(/Search models or providers|搜索模型或供应商/).waitFor();
    await assertMenuWidth();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(new URL("/settings?section=appearance", target).toString());
    // Language selection is owned by the native Aha appearance bridge and is
    // unavailable in the plain web test target. Verify its supported theme UI.
    await page.getByRole("radio", { name: /^Dark$|^深色$/ }).click();
    await page.goto(target);
    await page.getByRole("heading", { name: /^Drawing$|^绘图$/ }).waitFor();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.screenshot({ path: path.join(artifacts, "drawing-dark-e2e.png") });
    await page.getByRole("button", { name: /^Image model$|^生图模型$/ }).click();
    await page.getByPlaceholder(/Search models or providers|搜索模型或供应商/).waitFor();
    await assertMenuWidth();
    await providerRow.hover();
    await page.getByRole("menuitemradio", { name: "gpt-image-second", exact: true }).waitFor();
    await assertMenuWidth();
    await page.screenshot({ path: path.join(artifacts, "drawing-provider-picker-dark-fixed.png") });
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    await context.close();
  }, 90000);
});
