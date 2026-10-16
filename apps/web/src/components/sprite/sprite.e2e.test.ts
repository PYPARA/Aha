import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

// Opt-in, local isolated test server only. This test never calls a paid model.
const target = process.env.AHA_SPRITE_E2E_URL;
it.skipIf(!target)(
  "edits a sprite sheet, restores local state and downloads a valid atlas",
  async () => {
    if (!target || !["127.0.0.1", "localhost"].includes(new URL(target).hostname))
      throw new Error("Use an isolated local test server.");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${target}/sprite-animation`);
      for (let i = 0; i < 12; i++) {
        for (const name of [/^Skip setup$/, /^Not now$/, /^Skip tour$/]) {
          const skip = page.getByRole("button", { name });
          if (await skip.isVisible()) await skip.click();
        }
        await page.waitForTimeout(400);
      }
      await page.getByTestId("sprite-library").waitFor();
      await page
        .getByRole("button", { name: /New sprite project|新建精灵项目/, exact: true })
        .click();
      await page
        .getByRole("textbox", { name: /Project name|项目名称/, exact: true })
        .fill("Sprite E2E");
      await page.getByRole("button", { name: /Create|创建/, exact: true }).click();
      await page.getByTestId("sprite-workbench").waitFor();
      const png = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 16;
        const ctx = canvas.getContext("2d")!;
        for (let i = 0; i < 12; i++) {
          ctx.fillStyle = ["red", "blue", "orange", "purple"][i]!;
          ctx.fillRect(i * 16 + 4, 4 + i, 8, 8);
        }
        return canvas.toDataURL().split(",")[1]!;
      });
      await page
        .locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]')
        .setInputFiles({
          name: "four-frames.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        });
      await page
        .getByRole("button", { name: /Apply slicing|应用切割/ })
        .waitFor({ timeout: 8000 })
        .catch(async (error) => {
          console.log("WORKBENCH_FAILURE", await page.locator("body").innerText());
          await page.screenshot({ path: "/private/tmp/aha-sprite-e2e-failure.png" });
          throw error;
        });
      await page
        .getByRole("spinbutton", { name: /^columns$|^列数$/ })
        .first()
        .fill("4");
      await page.getByRole("button", { name: /Apply slicing.*4|应用切割.*4/ }).click();
      await page.getByRole("button", { name: /^idle 4$/ }).waitFor();
      await page.getByRole("textbox", { name: /Action name|动作名称/ }).fill("jump");
      await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("8");
      await page.getByRole("button", { name: /^Play$|^播放$/ }).click();
      await page.waitForTimeout(350);
      await page.getByRole("button", { name: /^Pause$|^暂停$/ }).click();
      await page.getByRole("textbox", { name: /Project name|项目名称/ }).fill("Sprite E2E");
      await page.getByText(/Saved locally|已保存到本机/, { exact: true }).waitFor();
      await page.reload();
      await page.getByTestId("sprite-workbench").waitFor();
      expect(await page.getByRole("textbox", { name: /Action name|动作名称/ }).inputValue()).toBe(
        "jump",
      );
      expect(await page.getByRole("spinbutton", { name: "FPS", exact: true }).inputValue()).toBe(
        "8",
      );
      const wait = page.waitForEvent("download");
      await page.getByRole("button", { name: /Download ZIP|下载 ZIP/ }).click();
      const download = await wait;
      const file = await download.path();
      expect(file).toBeTruthy();
      const files = unzipSync(await readFile(file!));
      const metadata = JSON.parse(strFromU8(files["animation.json"]!));
      expect(metadata.actions[0].frames).toHaveLength(4);
      expect(metadata.actions[0].fps).toBe(8);
      expect(metadata.width).toBe(16);
      const artifacts = path.resolve(".smoke/sprite");
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "workbench.png"), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
  60000,
);
