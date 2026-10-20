import { expect, it } from "vitest";
import { chromium, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import type { SpriteState } from "@synara/contracts";
function pngChunk(type: string, data: Buffer) {
  const tag = Buffer.from(type),
    bytes = Buffer.concat([tag, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function fixturePng(width: number, height: number, regions: number[][]) {
  const stride = width * 4 + 1,
    pixels = Buffer.alloc(stride * height);
  for (const [i, region] of regions.entries()) {
    const [x = 0, y = 0, w = width, h = height] = region;
    const color = i % 2 ? [104, 123, 193] : [182, 124, 102];
    for (let py = Math.floor(y + h * 0.25); py < Math.floor(y + h * 0.87); py++)
      for (
        let px = Math.floor(x + w * 0.35 + (i % 2) * 2);
        px < Math.floor(x + w * 0.6 + (i % 2) * 2);
        px++
      ) {
        const p = py * stride + 1 + px * 4;
        pixels[p] = color[0]!;
        pixels[p + 1] = color[1]!;
        pixels[p + 2] = color[2]!;
        pixels[p + 3] = 255;
      }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const enabled = process.env.AHA_SPRITE_E2E === "1";
const root = path.resolve(import.meta.dirname, "../../../../..");
const artifacts = path.join(root, ".tmp/validation/sprite-workflow");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}
async function healthy(url: string) {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`Local server did not start: ${url}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    wait(6000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function state(page: Page, projectId: string): Promise<SpriteState> {
  return page.evaluate(async (id) => {
    const module = await new Function("return import('/src/nativeApi.ts')")();
    return module
      .ensureNativeApi()
      .imageGeneration.spriteCommand({ operation: "get", projectId: id });
  }, projectId);
}

// Deliberately opt-in. Owns temporary state, two local app processes and a controlled image provider.
it.skipIf(!enabled)(
  "v5: generates controlled candidates, repairs across rows, survives a cold restart and exports adopted pixels",
  async () => {
    await mkdir(artifacts, { recursive: true });
    const home = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-v5-e2e-"));
    const serverPort = await port(),
      webPort = await port(),
      imagePort = await port();
    const requests: { size: string; prompt: string; endpoint: string }[] = [];
    let fixture: Server | undefined,
      server: ChildProcess | undefined,
      web: ChildProcess | undefined;
    const browser = await chromium.launch({ headless: true });
    const log = createWriteStream(path.join(artifacts, "e2e-process.log"), { flags: "w" });
    const startServer = () => {
      const child = spawn(
        "bun",
        [
          "run",
          "src/index.ts",
          "--home-dir",
          home,
          "--port",
          String(serverPort),
          "--host",
          "127.0.0.1",
          "--dev-url",
          `http://127.0.0.1:${webPort}`,
          "--no-browser",
        ],
        {
          cwd: path.join(root, "apps/server"),
          env: {
            ...process.env,
            PATH: `/Library/Developer/CommandLineTools/usr/bin:${process.env.PATH}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      return child;
    };
    try {
      fixture = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          const request = new Request(`http://127.0.0.1:${imagePort}${req.url}`, {
            method: req.method ?? "GET",
            headers: req.headers as Record<string, string>,
            ...(req.method === "GET" ? {} : { body: Uint8Array.from(body) }),
          });
          const raw = req.headers["content-type"]?.startsWith("multipart/")
            ? Object.fromEntries(await request.formData())
            : body.length
              ? JSON.parse(body.toString())
              : {};
          if (req.url?.endsWith("/models")) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ data: [{ id: "fixture-image" }] }));
            return;
          }
          const size = String(raw.size ?? "1024x1024"),
            prompt = String(raw.prompt ?? "");
          requests.push({ size, prompt, endpoint: req.url ?? "" });
          const [w, h] = size.split("x").map(Number);
          const animation = prompt.includes("global frames");
          const regions = animation
            ? [...prompt.matchAll(/region \((\d+),(\d+),(\d+),(\d+)\)/g)].map((m) =>
                m.slice(1).map(Number),
              )
            : [[0, 0, w!, h!]];
          const png = fixturePng(w!, h!, regions);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
      await new Promise<void>((resolve) => fixture!.listen(imagePort, "127.0.0.1", resolve));
      server = startServer();
      await healthy(`http://127.0.0.1:${serverPort}/health`);
      web = spawn("bunx", ["vite", "--host", "127.0.0.1"], {
        cwd: path.join(root, "apps/web"),
        env: { ...process.env, PORT: String(webPort), VITE_WS_URL: `ws://127.0.0.1:${serverPort}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      web.stdout!.pipe(log, { end: false });
      web.stderr!.pipe(log, { end: false });
      await healthy(`http://127.0.0.1:${webPort}/`);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
        page = await context.newPage(),
        errors: string[] = [];
      await page.addInitScript(() => {
        localStorage.setItem("synara:tasks-onboarding:v1", "seen");
        localStorage.setItem("synara:activity-onboarding:v1", "seen");
      });
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => {
        if (r.url().includes("/ws/negotiate")) log.write(`NEGOTIATE ${r.status()} ${r.url()}\n`);
      });
      page.on("websocket", (ws) => {
        log.write(`WS ${ws.url()}\n`);
        ws.on("framesent", (frame) => {
          const raw = JSON.parse(String(frame.payload));
          log.write(`SENT ${raw._tag ?? "batch"} ${raw.tag ?? raw.payload?._tag ?? ""}\n`);
        });
        ws.on("framereceived", (frame) => {
          try {
            const raw = JSON.parse(String(frame.payload));
            log.write(`RECEIVED ${raw._tag ?? "batch"}\n`);
          } catch {}
        });
        ws.on("socketerror", (e) => log.write(`SOCKET ${String(e)}\n`));
      });
      await page.goto(`http://127.0.0.1:${webPort}/sprite-animation`);
      for (let i = 0; i < 12; i++) {
        for (const name of [/^Skip setup$/, /^Not now$/, /^Skip tour$/]) {
          const button = page.getByRole("button", { name });
          if (await button.isVisible()) await button.click();
        }
        if (i > 8 && (await page.getByTestId("sprite-library").isVisible())) break;
        await wait(400);
      }
      await page.getByTestId("sprite-library").waitFor({ timeout: 25000 });
      await page
        .getByRole("button", { name: /^Skip setup$/ })
        .waitFor({ timeout: 10000 })
        .then(() => page.getByRole("button", { name: /^Skip setup$/ }).click())
        .catch(() => {});
      await page.getByRole("button", { name: /^New sprite project$|^新建精灵项目$/ }).click();
      await page.getByRole("textbox", { name: /^Project name$|^项目名称$/ }).fill("Sprite v5 E2E");
      expect(
        await page
          .getByRole("spinbutton", { name: /^Action frame width$|^动作帧宽度$/ })
          .inputValue(),
      ).toBe("256");
      await page.mouse.move(750, 30);
      await page.screenshot({ path: path.join(artifacts, "01-create-actual.png") });
      await page
        .getByRole("button", {
          name: /^Create sprite project$|^Create project$|^创建工程$|^创建项目$/,
        })
        .click();
      await page.getByTestId("sprite-workbench").waitFor();
      const projectId = new URL(page.url()).searchParams.get("projectId")!;
      await page.evaluate(
        async ({ imagePort }) => {
          const module = await new Function("return import('/src/nativeApi.ts')")();
          await Promise.race([
            module.ensureNativeApi().imageGeneration.upsertProvider({
              name: "Local controlled image fixture",
              baseUrl: `http://127.0.0.1:${imagePort}/v1`,
              apiKey: "fixture-local-only",
              enabled: true,
              models: [
                { id: "fixture-image", source: "manual", lastTestAt: null, lastTestStatus: null },
              ],
              defaultModel: "fixture-image",
              concurrency: 1,
              timeoutSeconds: 30,
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Local provider RPC did not respond in 15 seconds")),
                15000,
              ),
            ),
          ]);
        },
        { imagePort },
      );
      const generateCharacter = page.getByRole("button", {
        name: /^Generate character$|^生成角色$/,
      });
      await generateCharacter.first().click();
      await page
        .getByRole("textbox", { name: /^Creation description$|^创作描述$/ })
        .fill("A clean illustrated test character");
      await page.getByRole("button", { name: /^Prepare generation plan$|^准备生成方案$/ }).click();
      await page
        .getByRole("button", { name: /^Start generation|^开始生成/ })
        .waitFor({ timeout: 20000 });
      await page.getByRole("button", { name: /^Start generation|^开始生成/ }).click();
      await expect
        .poll(
          async () =>
            (await state(page, projectId)).runs.some(
              (r) => r.input.kind === "character" && r.source,
            ),
          { timeout: 20000 },
        )
        .toBe(true);
      await page.getByRole("button", { name: /^Generation tasks|^生成任务/ }).click();
      await page
        .getByRole("button", { name: /^Use as character reference$|^用作角色参考$|^选为角色参考$/ })
        .click();
      await page
        .getByRole("button", { name: /^Preview reference$|^预览参考图$|^查看参考图$/ })
        .click();
      await page
        .getByRole("button", { name: /^Confirm character reference$|^确认角色基准$/ })
        .click();
      await expect
        .poll(async () => !!(await state(page, projectId)).canonical, { timeout: 10000 })
        .toBe(true);
      await page
        .getByRole("navigation", { name: /Sprite workflow|精灵制作流程/ })
        .getByRole("button", { name: /^Actions$|^动作$/ })
        .click();
      await page
        .getByRole("button", { name: /^Generate action$|^生成动作$/ })
        .first()
        .click();
      await page
        .getByRole("textbox", { name: /^Creation description$|^创作描述$/ })
        .fill("Breathe gently, keep feet stable");
      await page.getByRole("button", { name: /^Prepare generation plan$|^准备生成方案$/ }).click();
      await page.getByRole("button", { name: /^Start generation|^开始生成/ }).waitFor();
      const planned = (await state(page, projectId)).plans!.find(
        (p) => p.status === "draft" && p.configuration.kind === "animation",
      )!;
      expect(planned.configuration.sizing?.mode).toBe("linked");
      await page.mouse.move(750, 30);
      await page.screenshot({ path: path.join(artifacts, "02-plan-actual.png") });
      await page.getByRole("button", { name: /^Start generation|^开始生成/ }).click();
      await expect
        .poll(
          async () =>
            (await state(page, projectId)).runs.some(
              (r) => r.input.kind === "animation" && r.frames.length === 8,
            ),
          { timeout: 20000 },
        )
        .toBe(true);
      const generated = (await state(page, projectId)).runs.find(
        (r) => r.input.kind === "animation",
      )!;
      expect(requests.map((r) => r.size)).toEqual(["1024x1024", "1024x512"]);
      expect(generated.configuration!.layout).toMatchObject({
        columns: 4,
        rows: 2,
        width: 1024,
        height: 512,
      });
      await page.getByRole("button", { name: /^Generation tasks|^生成任务/ }).click();
      await page
        .getByRole("button", { name: /^Adjust slicing and alignment$|^调整切帧与对齐$/ })
        .click();
      await page.getByTestId("sprite-repair-editor").waitFor();
      await page.getByRole("tab", { name: /^Alignment$|^对齐$/ }).click();
      await page
        .getByRole("spinbutton", { name: /^Offset X$|^X偏移$|^偏移X$|^水平偏移$/ })
        .fill("3");
      await page.keyboard.press("Enter");
      await page
        .getByRole("spinbutton", { name: /^Frame duration \(ms\)$|^帧时长（毫秒）$/ })
        .fill("175");
      await page.keyboard.press("Enter");
      await page.mouse.move(750, 30);
      await page.screenshot({ path: path.join(artifacts, "03-align-actual.png") });
      for (const [label, skin] of [
        ["dark", false],
        ["skin", true],
      ] as const) {
        await page.evaluate(async (custom) => {
          const hooks = await new Function("return import('/src/hooks/useTheme.ts')")(),
            logic = await new Function("return import('/src/theme/theme.logic.ts')")();
          const theme = structuredClone(logic.DEFAULT_THEME_STATE);
          theme.mode = "dark";
          if (custom)
            Object.assign(theme.chromeThemes.dark, {
              surface: "#0B172A",
              ink: "#EAF2FC",
              accent: "#68B9F0",
            });
          hooks.previewAhaThemeState(logic.serializeThemeState(theme));
        }, skin);
        await page.mouse.move(750, 30);
        await page.keyboard.press("Escape");
        await page.screenshot({ path: path.join(artifacts, `repair-${label}-actual.png`) });
      }
      await page.evaluate(async () => {
        const hooks = await new Function("return import('/src/hooks/useTheme.ts')")(),
          logic = await new Function("return import('/src/theme/theme.logic.ts')")();
        hooks.previewAhaThemeState(
          logic.serializeThemeState({ ...logic.DEFAULT_THEME_STATE, mode: "light" }),
        );
      });
      for (const [label, w, h] of [
        ["1280", 1280, 800],
        ["1920", 1920, 1080],
        ["125pct", 1024, 640],
        ["150pct", 853, 533],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        const save = page.getByRole("button", {
          name: /^Save corrections and return to review$|^保存修正并返回检查$/,
        });
        await save.waitFor();
        const bounds = await save.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(h);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(w);
        await save.click({ trial: true });
        await page.mouse.move(w - 5, 5);
        await page.screenshot({ path: path.join(artifacts, `repair-${label}-actual.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.getByTestId("sprite-repair-editor").waitFor();
      expect(
        await page
          .getByRole("spinbutton", { name: /^Offset X$|^X偏移$|^偏移X$|^水平偏移$/ })
          .inputValue(),
      ).toBe("3");
      await page
        .getByRole("button", {
          name: /^Save corrections and return to review$|^保存修正并返回检查$/,
        })
        .click();
      await page
        .getByRole("button", { name: /^Confirm review and adopt$|^确认检查并采用$/ })
        .waitFor();
      expect(requests).toHaveLength(2);
      const before = await state(page, projectId);
      expect(
        before.runs.find((r) => r.id === generated.id)!.candidates![0]!.processingVersions,
      ).toHaveLength(2);
      // Exercise the historical invalid source: ID through a real service cold start.
      const imported = await page.evaluate(
        async ({ projectId, context, source }) => {
          const module = await new Function("return import('/src/nativeApi.ts')")();
          return module.ensureNativeApi().imageGeneration.spriteCommand({
            operation: "inspect-source",
            projectId,
            context,
            references: [
              {
                referenceId: `project:${source.id}`,
                asset: source,
                role: "reference",
                actionId: null,
              },
            ],
          });
        },
        { projectId, context: generated.context, source: generated.source! },
      );
      expect(imported.runs).toHaveLength(3);
      await stop(server);
      let generationFile = "";
      for (const area of ["userdata", "dev"]) {
        const file = path.join(home, area, "sprites", `${projectId}.json`);
        try {
          await readFile(file);
          generationFile = file;
          break;
        } catch {}
      }
      expect(generationFile).toBeTruthy();
      const legacy = JSON.parse(await readFile(generationFile, "utf8"));
      const localImport = legacy.runs.find(
        (r: { imageStatus?: string }) => r.imageStatus === "imported",
      );
      localImport.input.requestId = `source:${localImport.source.id}`;
      delete localImport.importOrigin;
      await writeFile(generationFile, JSON.stringify(legacy));
      server = startServer();
      await healthy(`http://127.0.0.1:${serverPort}/health`);
      await page.reload();
      await page.getByTestId("sprite-workbench").waitFor();
      await expect
        .poll(async () => (await state(page, projectId)).runs.length, { timeout: 10000 })
        .toBe(3);
      const recovered = await state(page, projectId);
      expect(
        recovered.runs.find((r) => r.imageStatus === "imported")!.importOrigin?.legacyRequestId,
      ).toMatch(/^source:/);
      expect(recovered.runs.find((r) => r.id === generated.id)!.configuration!.layout).toEqual(
        generated.configuration!.layout,
      );
      expect(requests).toHaveLength(2);
      await page
        .getByRole("button", { name: /^Confirm review and adopt$|^确认检查并采用$/ })
        .click();
      await page.getByText(/^Saved locally$|^已保存到本机$/).waitFor();
      await page.mouse.move(750, 30);
      await page.screenshot({ path: path.join(artifacts, "04-adopted-actual.png") });
      await page
        .getByRole("navigation", { name: /Sprite workflow|精灵制作流程/ })
        .getByRole("button", { name: /^Export$|^导出$/ })
        .click();
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", { name: /^Export animation resources$|^导出动画资源$/ })
        .click();
      const file = await (await downloadPromise).path();
      const files = unzipSync(await readFile(file!)),
        metadata = JSON.parse(strFromU8(files["animation.json"]!));
      expect(metadata.actions[0].frames).toHaveLength(8);
      expect(metadata.actions[0].frames[0].durationMs).toBe(175);
      expect(metadata.width).toBe(256);
      await page.mouse.move(750, 30);
      await page.screenshot({ path: path.join(artifacts, "05-export-actual.png") });
      expect(errors).toEqual([]);
      await writeFile(
        path.join(artifacts, "e2e-result.json"),
        JSON.stringify(
          {
            requests: requests.map(({ size, endpoint }) => ({ size, endpoint })),
            runsAfterRestart: recovered.runs.length,
            legacyImportRecovered: true,
            frames: 8,
            outputSize: 256,
            durationMs: 175,
            errors,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        await page.mouse.move(750, 30);
        await page.screenshot({ path: path.join(artifacts, "e2e-failure.png") }).catch(() => {});
        await writeFile(
          path.join(artifacts, "e2e-failure.txt"),
          await page.locator("body").innerText(),
        ).catch(() => {});
      }
      throw error;
    } finally {
      await browser.close();
      if (web) await stop(web);
      if (server) await stop(server);
      if (fixture) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
      log.end();
    }
  },
  180000,
);
