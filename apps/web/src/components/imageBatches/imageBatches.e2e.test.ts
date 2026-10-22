import { it, expect } from "vitest";
import { chromium, type Page } from "playwright";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Effect, Layer, ManagedRuntime, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ImageBatchState, ImageBatchTask } from "@synara/contracts";
import type {
  ResourceCommand,
  ResourceCollectionOperation,
  ResourceCollectionItem,
  ResourceSnapshot,
  ResourcePage,
  ResourceLocateResult,
  ResourceReadResult,
  ResourceEntry,
  ResourceQuery,
} from "@synara/contracts/resourceLibrary";
// Runtime imports keep the browser TypeScript project separate from server/desktop source.
interface ResourceHarness {
  serial<T>(run: () => Promise<T>): Promise<T>;
  open(path: string): Promise<unknown>;
  close(): void;
  snapshot(): ResourceSnapshot;
  listCollections(): Promise<ResourceCollectionOperation[]>;
  prepareCollection(
    input: Extract<ResourceCommand, { op: "prepareCollection" }>,
  ): Promise<ResourceCollectionOperation>;
  commitCollection(id: string, result: string, bytes: Uint8Array): Promise<ResourceCollectionItem>;
  linkCollection(id: string, result: string): Promise<void>;
  failCollection(id: string, result: string, error: string): Promise<void>;
  retryCollection(id: string): Promise<unknown>;
  finishCollection(id: string): Promise<void>;
  list(query: ResourceQuery): ResourcePage;
  locate(id: string, sort: ResourceQuery["sort"]): Promise<ResourceLocateResult>;
  resourceState(libraryId: string, id: string): Promise<unknown>;
  scan(): Promise<unknown>;
  createDirectory(parent: string, name: string): Promise<ResourceEntry>;
  read(id: string, thumbnail?: boolean): Promise<ResourceReadResult>;
}

const enabled = process.env.AHA_IMAGE_BATCH_E2E === "1";
class ImageRepositoryContext extends ServiceMap.Service<ImageRepositoryContext, unknown>()(
  "synara/persistence/ImageGenerationRepository",
) {}
const root = path.resolve(import.meta.dirname, "../../../../.."),
  artifacts = path.join(root, ".tmp/validation/image-batches/e2e");
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
  throw new Error("Local server failed: " + url);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(4000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function api<T>(page: Page, method: string, input: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, input }) => {
      const m = await new Function("return import('/src/nativeApi.ts')")();
      const [group, name] = method.split(".");
      return m.ensureNativeApi()[group!][name!](input);
    },
    { method, input },
  );
}
const current = (page: Page, id: string) => api<ImageBatchState>(page, "imageBatches.get", { id });

// Explicitly enabled only. All providers, conversations, assets and resource folders are controlled fixtures.
it.skipIf(!enabled)(
  "batch workflow: controlled proposal → review → generation → manual copy → restart recovery",
  async () => {
    await mkdir(artifacts, { recursive: true });
    const serverModule = (name: string) => import(path.join(root, "apps/server/src", name));
    const [
      { layer },
      { ImageGenerationRepositoryLive },
      { ImageGenerationRepository },
      { ImageGenerationEngine },
      { ImageBatchEngine },
      { ImageBatchRepository },
      { makeImageBatchTools },
      { ResourceLibrary },
    ] = await Promise.all([
      serverModule("persistence/NodeSqliteClient.ts"),
      serverModule("persistence/Layers/ImageGenerationRepository.ts"),
      serverModule("persistence/Services/ImageGenerationRepository.ts"),
      serverModule("imageGeneration/imageGenerationEngine.ts"),
      serverModule("imageBatches/engine.ts"),
      serverModule("imageBatches/repository.ts"),
      serverModule("agentGateway/imageBatchTools.ts"),
      import(path.join(root, "apps/desktop/src/resources/library.ts")),
    ]);
    const sharp = createRequire(path.join(root, "apps/server/package.json"))("sharp");
    const home = await mkdtemp(path.join(artifacts, "home-"));
    const serverPort = await port(),
      webPort = await port(),
      imagePort = await port();
    const log = createWriteStream(path.join(artifacts, "process.log"), { flags: "w" });
    let server: ChildProcess | undefined, web: ChildProcess | undefined;
    let library: ResourceHarness | undefined;
    const runtime = ManagedRuntime.make(
      ImageGenerationRepositoryLive.pipe(
        Layer.provideMerge(layer({ filename: path.join(home, "dev/state.sqlite") })),
      ),
    );
    const browser = await chromium.launch({ headless: true });
    let page: Page | undefined;
    const requests: { prompt: string; n: number }[] = [];
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#357b86" },
    })
      .png()
      .toBuffer();
    const fixture = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "fixture-image" }] }));
        return;
      }
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ prompt: body.prompt, n: body.n });
        if (body.prompt.includes("SLOW")) await wait(3000);
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-request-id", "fixture-" + requests.length);
        res.end(
          JSON.stringify({
            data: Array.from({ length: body.n }, () => ({ b64_json: png.toString("base64") })),
          }),
        );
      } catch (cause) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: String(cause) } }));
      }
    });
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
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      return child;
    };
    try {
      await new Promise<void>((resolve) => fixture.listen(imagePort, "127.0.0.1", resolve));
      server = startServer();
      web = spawn("bunx", ["vite", "--host", "127.0.0.1"], {
        cwd: path.join(root, "apps/web"),
        env: { ...process.env, PORT: String(webPort), VITE_WS_URL: `ws://127.0.0.1:${serverPort}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      web.stdout!.pipe(log, { end: false });
      web.stderr!.pipe(log, { end: false });
      await healthy(`http://127.0.0.1:${serverPort}/`);
      await healthy(`http://127.0.0.1:${webPort}/`);
      library = new ResourceLibrary(path.join(home, "resource-library.json")) as ResourceHarness;
      await mkdir(path.join(home, "resources"));
      await library.open(path.join(home, "resources"));
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        log.write("BROWSER ERROR " + e.message + "\n");
      });
      await page.exposeFunction("batchResourceRequest", async (raw: ResourceCommand) =>
        library!.serial(async () => {
          switch (raw.op) {
            case "snapshot":
              return library!.snapshot();
            case "listCollections":
              return library!.listCollections();
            case "prepareCollection":
              return library!.prepareCollection(raw);
            case "commitCollection":
              return library!.commitCollection(
                raw.operationId,
                raw.resultId,
                Uint8Array.from(raw.bytes as unknown as number[]),
              );
            case "linkCollection":
              return library!.linkCollection(raw.operationId, raw.resultId);
            case "failCollection":
              return library!.failCollection(raw.operationId, raw.resultId, raw.error);
            case "retryCollection":
              return library!.retryCollection(raw.operationId);
            case "finishCollection":
              return library!.finishCollection(raw.operationId);
            case "list":
              return library!.list(raw.query);
            case "resourceState":
              return library!.resourceState(raw.libraryId, raw.id);
            case "locate":
              return library!.locate(raw.id, raw.sort);
            case "refresh":
              return library!.scan();
            case "createDirectory":
              return library!.createDirectory(raw.parent, raw.name);
            case "read": {
              const r = await library!.read(raw.id, raw.thumbnail);
              return { ...r, bytes: Array.from(r.bytes) };
            }
            default:
              throw new Error("Unsupported fixture resource command: " + raw.op);
          }
        }),
      );
      await page.addInitScript((wsUrl) => {
        window.desktopBridge = {
          resourceLibrary: {
            request: (command: ResourceCommand) => {
              const raw =
                command.op === "commitCollection"
                  ? { ...command, bytes: Array.from(command.bytes) }
                  : command;
              return (
                window as unknown as {
                  batchResourceRequest: (command: unknown) => Promise<unknown>;
                }
              ).batchResourceRequest(raw);
            },
            onChanged: () => () => {},
            onProgress: () => () => {},
          },
          browser: { onBrowserUseOpenPanelRequest: () => () => {} },
          getWsUrl: () => wsUrl,
          setTheme: async () => {},
          getZoomFactor: () => 1,
          onZoomFactorChange: () => () => {},
        } as unknown as NonNullable<typeof window.desktopBridge>;
      }, `ws://127.0.0.1:${serverPort}`);
      await page.goto(`http://127.0.0.1:${webPort}/#/image-batches`);
      const skip = page.getByRole("button", { name: /^Skip setup$/ });
      await skip.waitFor();
      await skip.click();
      await page.getByRole("heading", { name: /Batch images|批量生图/, exact: true }).waitFor();
      const provider = await api<{ id: string }>(page, "imageGeneration.upsertProvider", {
        name: "Fixture image channel",
        baseUrl: `http://127.0.0.1:${imagePort}/v1`,
        enabled: true,
        models: [{ id: "fixture-image", source: "manual", lastTestAt: null, lastTestStatus: null }],
        defaultModel: "fixture-image",
        concurrency: 2,
        timeoutSeconds: 30,
      });
      let batch = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "create",
        requestId: crypto.randomUUID(),
        name: "E2E Knowledge images",
      });
      batch = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "bind-thread",
        batchId: batch.id,
        version: batch.version,
        threadId: "controlled-batch-thread",
      });
      // The application intentionally owns an exclusive SQLite connection. Seed the controlled
      // agent turn while it is stopped, using the real tool and repository, then reopen normally.
      await stop(server);
      server = undefined;
      const sql = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* SqlClient.SqlClient;
          }),
        ),
        repo = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* ImageGenerationRepository as typeof ImageRepositoryContext;
          }),
        );
      const images = new ImageGenerationEngine(
        repo,
        {
          get: () => Effect.succeed(null),
          set: () => Effect.void,
          remove: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        },
        path.join(home, "dev/drawing"),
        async () => {},
      );
      const batches = new ImageBatchEngine(
        new ImageBatchRepository(sql),
        images,
        path.join(home, "dev/image-batches"),
        async () => {},
      );
      const tool = makeImageBatchTools(batches, {
        list: async () => [
          {
            id: "attachment:brief",
            name: "brief.any",
            source: "attachment",
            messageId: "sent-message",
          },
        ],
        read: async () => ({
          name: "brief.any",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("Knowledge images: six tasks, two candidates each."),
          messageId: "sent-message",
          attachmentId: "brief",
        }),
      })[0]!;
      const toolContext = {
        principal: {
          kind: "provider-session",
          sessionKey: "fixture",
          threadId: batch.threadId!,
          provider: "codex",
          turnId: "turn",
        },
        callerThreadId: batch.threadId!,
        callerThreadLabel: "Fixture",
        callerSessionKey: "fixture",
        callerProvider: "codex",
        callerCapabilities: new Set(["thread:write"]),
        callerTurnId: "turn",
        assertCallerTurnActive: () => Effect.void,
        jsonRpcRequestId: 1,
      };
      const callTool = async (args: Record<string, unknown>) =>
        await Effect.runPromise(
          tool.handler(args, toolContext) as Effect.Effect<{ isError?: boolean }>,
        );
      expect((await callTool({ operation: "get" })).isError).not.toBe(true);
      batch = await batches.get(batch.id);
      expect(batch.sources).toHaveLength(1);
      expect(await readFile(batch.sources[0]!.path!, "utf8")).toContain("Knowledge");
      await callTool({
        operation: "report",
        reports: [
          { sourceId: batch.sources[0]!.id, status: "read", message: "Read fixture brief" },
        ],
      });
      const tasks: ImageBatchTask[] = Array.from({ length: 6 }, (_, i) => ({
        id: "task-" + i,
        name: "Knowledge " + (i + 1),
        prompt: "Knowledge illustration " + (i + 1),
        enabled: true,
        references: [],
        sourceIds: [batch.sources[0]!.id],
      }));
      expect(
        (
          await callTool({
            operation: "propose",
            requestId: "fixture-proposal",
            baseVersion: batch.version,
            summary: "Six tasks from brief",
            warnings: [],
            tasks,
          })
        ).isError,
      ).not.toBe(true);
      expect((await batches.get(batch.id)).tasks).toHaveLength(0);
      expect(requests).toHaveLength(0);
      await runtime.dispose();
      server = startServer();
      await healthy(`http://127.0.0.1:${serverPort}/`);
      await page.goto(`http://127.0.0.1:${webPort}/#/image-batches?batchId=${batch.id}`);
      await page.getByRole("button", { name: /^Preview changes$|^预览变更$/ }).click();
      await page.getByRole("button", { name: /^Apply changes$|^应用变更$/ }).click();
      batch = await current(page, batch.id);
      expect(batch.tasks).toHaveLength(6);
      // Row-level count change is a user edit of the versioned draft; defaults remain two.
      batch = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "save",
        batchId: batch.id,
        version: batch.version,
        name: batch.name,
        brief: batch.brief,
        defaults: {
          providerId: provider.id,
          model: "fixture-image",
          parameters: { n: 2, outputFormat: "png" },
        },
        tasks: batch.tasks.map((task, index) =>
          index === 0 ? { ...task, parameters: { n: 1 } } : task,
        ),
      });
      await page.reload();
      await page.getByRole("tab", { name: /^Task list$|^任务清单$/ }).click();
      await page.getByRole("button", { name: /^Review and generate$|^检查并生成$/ }).click();
      expect(await page.getByRole("dialog").innerText()).toMatch(/6.*11/);
      expect(await page.getByRole("dialog").innerText()).toContain("Fixture image channel");
      expect(requests).toHaveLength(0);
      await page.getByRole("button", { name: /^Confirm generation$|^确认生成$/ }).click();
      await expect
        .poll(
          async () => {
            batch = await current(page!, batch.id);
            return batch.executions.at(-1)?.finishedAt;
          },
          { timeout: 20000 },
        )
        .toBeTruthy();
      expect(requests).toHaveLength(6);
      expect(requests.reduce((n, r) => n + r.n, 0)).toBe(11);
      const confirmation = batch.executions[0]!;
      await Promise.all(
        [1, 2].map(() =>
          api(page!, "imageBatches.command", {
            operation: "confirm",
            batchId: batch.id,
            version: confirmation.draftVersion,
            requestId: confirmation.requestId,
          }),
        ),
      );
      expect((await current(page, batch.id)).executions).toHaveLength(1);
      expect(requests).toHaveLength(6);
      const resultPage = await api<{
        results: { id: string; asset: { id: string } }[];
        total: number;
      }>(page, "imageBatches.results", { batchId: batch.id });
      expect(resultPage.total).toBe(11);
      expect(new Set(resultPage.results.map((r) => r.id)).size).toBe(11);
      expect(new Set(resultPage.results.map((r) => r.asset.id)).size).toBe(1);
      await page.getByRole("tab", { name: /^Generated results$|^生成结果$/ }).click();
      await page
        .getByRole("button", { name: /Select result:|选择结果:/ })
        .first()
        .click();
      expect(library.list({ path: "" }).total).toBe(0);
      await page.getByRole("button", { name: /^Mark adopted$|^标记选用$/ }).click();
      await page.getByRole("button", { name: /^Add to resource center$|^添加到资源中心$/ }).click();
      await page.getByRole("dialog").getByRole("combobox").click();
      await page.getByRole("option", { name: /^Library root$|^资源库根目录$/ }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Add to resource center$|^添加到资源中心$/ })
        .click();
      await expect
        .poll(
          async () =>
            (await library!.listCollections())
              .flatMap((o) => o.items)
              .filter((i) => i.status === "linked").length,
          { timeout: 20000 },
        )
        .toBe(1);
      expect(library.list({ path: "" }).total).toBe(1);
      expect(requests).toHaveLength(6);
      await page.getByRole("button", { name: /^Preview$|^预览$/ }).click();
      await page
        .getByRole("button", { name: /^Locate in resource center$|^在资源中心定位$/ })
        .click();
      await page.getByRole("button", { name: /^Open image batch$|^打开生图批次$/ }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "collected-resource.png") });
      await page.getByRole("button", { name: /^Open image batch$|^打开生图批次$/ }).click();
      await page.getByRole("tab", { name: /^Generated results$|^生成结果$/ }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "batch-results.png") });
      await stop(server);
      server = startServer();
      await healthy(`http://127.0.0.1:${serverPort}/`);
      await page.reload();
      expect((await current(page, batch.id)).executions[0]!.id).toBe(confirmation.id);
      expect(requests).toHaveLength(6);
      expect(
        (await api<{ jobs: unknown[] }>(page, "imageGeneration.listJobs", { origin: "drawing" }))
          .jobs,
      ).toHaveLength(0);
      await page.setViewportSize({ width: 620, height: 850 });
      await page.getByRole("tab", { name: /^Task list$|^任务清单$/ }).click();
      await page.screenshot({ path: path.join(artifacts, "narrow-tasks.png") });
      expect(
        await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // Capacity and skin fixtures exercise the real page and shared typography tokens.
      let capacity = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "create",
        requestId: crypto.randomUUID(),
        name: "Capacity fixture",
      });
      capacity = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "save",
        batchId: capacity.id,
        version: capacity.version,
        name: capacity.name,
        brief: "",
        defaults: {
          providerId: provider.id,
          model: "fixture-image",
          parameters: { n: 5, outputFormat: "png" },
        },
        tasks: Array.from({ length: 100 }, (_, i) => ({
          id: "capacity-" + i,
          name: "Capacity " + i,
          prompt: "Capacity image " + i,
          enabled: true,
          references: [],
          sourceIds: [],
        })),
      });
      await page.goto(`http://127.0.0.1:${webPort}/#/image-batches?batchId=${capacity.id}`);
      await page.getByRole("tab", { name: /^Task list$|^任务清单$/ }).click();
      expect(await page.getByRole("button", { name: /^Add task$|^添加任务$/ }).isDisabled()).toBe(
        true,
      );
      expect(
        await page
          .locator("#batch-panel-tasks")
          .getByRole("checkbox", { name: /Select task:|选择任务:/ })
          .count(),
      ).toBe(100);
      await page.evaluate(async () => {
        const theme = await new Function("return import('/src/theme/theme.logic.ts')")(),
          hook = await new Function("return import('/src/hooks/useTheme.ts')")();
        hook.applyAhaThemeState(
          theme.serializeThemeState({ ...theme.DEFAULT_THEME_STATE, mode: "dark" }),
        );
      });
      await page.evaluate(() => {
        const root = document.documentElement,
          style = getComputedStyle(root);
        for (const key of ["ui", "ui-lg", "ui-sm", "ui-xs", "ui-2xs", "ui-meta", "ui-timestamp"]) {
          const name = "--app-font-size-" + key;
          root.style.setProperty(
            name,
            (parseFloat(style.getPropertyValue(name)) || 13) * 1.5 + "px",
          );
        }
      });
      await page.screenshot({ path: path.join(artifacts, "capacity-dark-150-percent.png") });
      expect(
        await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByRole("button", { name: /^Review and generate$|^检查并生成$/ }).click();
      expect(await page.getByRole("dialog").innerText()).toMatch(/100.*500/);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Cancel$|^取消$/ })
        .click();
      expect(requests).toHaveLength(6);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`http://127.0.0.1:${webPort}/#/image-batches?batchId=${batch.id}`);
      await page.getByRole("tab", { name: /^Generated results$|^生成结果$/ }).click();
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.ahaBackgrounds = "true";
        root.dataset.ahaContent = "image";
        root.style.setProperty(
          "--aha-content-image",
          'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221200%22 height=%22800%22%3E%3Crect width=%221200%22 height=%22800%22 fill=%22%23283c51%22/%3E%3Ccircle cx=%22800%22 cy=%22200%22 r=%22400%22 fill=%22%2352446c%22/%3E%3C/svg%3E")',
        );
        root.style.setProperty("--aha-content-opacity", "0.35");
        root.style.setProperty("--aha-content-overlay", "0.3");
      });
      await page.screenshot({ path: path.join(artifacts, "dark-background-results.png") });
      // A real sent request becomes uncertain after shutdown. Paused queued work resumes once;
      // the already sent request is never automatically repeated.
      let recovering = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "create",
        requestId: crypto.randomUUID(),
        name: "Recovery fixture",
      });
      recovering = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "save",
        batchId: recovering.id,
        version: recovering.version,
        name: recovering.name,
        brief: "",
        defaults: {
          providerId: provider.id,
          model: "fixture-image",
          parameters: { n: 1, outputFormat: "png" },
        },
        tasks: Array.from({ length: 3 }, (_, i) => ({
          id: "recover-" + i,
          name: "Recover " + i,
          prompt: "SLOW Recovery " + i,
          enabled: true,
          references: [],
          sourceIds: [],
        })),
      });
      recovering = await api<ImageBatchState>(page, "imageBatches.command", {
        operation: "confirm",
        batchId: recovering.id,
        version: recovering.version,
        requestId: crypto.randomUUID(),
      });
      await expect.poll(() => requests.length).toBe(7);
      await api(page, "imageBatches.command", {
        operation: "pause",
        batchId: recovering.id,
        executionId: recovering.executions[0]!.id,
      });
      await stop(server);
      server = startServer();
      await healthy(`http://127.0.0.1:${serverPort}/`);
      await page.reload();
      await expect
        .poll(
          async () => (await current(page!, recovering.id)).executions[0]!.attempts[0]!.status,
          { timeout: 10000 },
        )
        .toBe("uncertain");
      expect(requests).toHaveLength(7);
      await api(page, "imageBatches.command", {
        operation: "resume",
        batchId: recovering.id,
        executionId: recovering.executions[0]!.id,
      });
      await expect
        .poll(async () => (await current(page!, recovering.id)).executions[0]!.finishedAt, {
          timeout: 15000,
        })
        .toBeTruthy();
      const recovered = await current(page, recovering.id);
      expect(recovered.executions[0]!.attempts.map((a) => a.status)).toEqual([
        "uncertain",
        "succeeded",
        "succeeded",
      ]);
      expect(requests).toHaveLength(9);
      expect(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed()) {
        log.write(
          "FINAL " +
            page.url() +
            " " +
            (await page
              .locator("body")
              .innerText()
              .catch(() => "")) +
            "\n",
        );
        await page.screenshot({ path: path.join(artifacts, "last.png") }).catch(() => {});
      }
      await browser.close();
      library?.close();
      await runtime.dispose();
      await stop(server);
      await stop(web);
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      log.end();
    }
  },
  180000,
);
