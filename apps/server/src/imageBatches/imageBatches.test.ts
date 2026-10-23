import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import {
  imageBatchDiff,
  imageBatchPlanCounts,
  type ImageBatchState,
  type ImageBatchTask,
  type ImageJobCreateInput,
} from "@synara/contracts";
import { layerMemory } from "../persistence/NodeSqliteClient";
import imageMigration from "../persistence/Migrations/135_ImageGeneration";
import editMigration from "../persistence/Migrations/136_ImageEditDocuments";
import batchMigration from "../persistence/Migrations/138_ImageBatches";
import { ImageGenerationRepositoryLive } from "../persistence/Layers/ImageGenerationRepository";
import { ImageGenerationRepository } from "../persistence/Services/ImageGenerationRepository";
import { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { ImageBatchRepository } from "./repository";
import { ImageBatchEngine } from "./engine";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aha-batches-test-"));
  const runtime = ManagedRuntime.make(
    ImageGenerationRepositoryLive.pipe(
      Layer.provideMerge(
        Layer.effectDiscard(
          Effect.gen(function* () {
            yield* imageMigration;
            yield* editMigration;
            yield* batchMigration;
          }),
        ).pipe(Layer.provideMerge(layerMemory())),
      ),
    ),
  );
  const repository = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ImageGenerationRepository;
    }),
  );
  const sql = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SqlClient.SqlClient;
    }),
  );
  const secrets = {
    get: () => Effect.succeed(null),
    set: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  };
  const images = new ImageGenerationEngine(
    repository,
    secrets,
    path.join(root, "images"),
    async () => {},
  );
  const repo = new ImageBatchRepository(sql),
    engine = new ImageBatchEngine(repo, images, path.join(root, "batches"), async () => {});
  await engine.initialize();
  await images.initialize();
  const provider = await images.upsertProvider({
    name: "Mock",
    baseUrl: "http://127.0.0.1:9771/v1",
    enabled: true,
    models: [{ id: "mock", source: "manual", lastTestAt: null, lastTestStatus: null }],
    defaultModel: "mock",
    concurrency: 2,
    timeoutSeconds: 30,
  });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "blue" } })
    .png()
    .toBuffer();
  const response = (n = 1, status = 200) =>
    new Response(
      JSON.stringify(
        status === 200
          ? { data: Array.from({ length: n }, () => ({ b64_json: png.toString("base64") })) }
          : { error: { message: "mock rate limit" } },
      ),
      { status, headers: { "x-request-id": "mock-upstream" } },
    );
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    response(JSON.parse(String(init?.body)).n),
  );
  vi.stubGlobal("fetch", fetcher);
  const create = () =>
    engine.command({ operation: "create", name: "Batch", requestId: randomUUID() });
  const task = (id: string, n?: number): ImageBatchTask => ({
    id,
    name: id,
    prompt: "image " + id,
    enabled: true,
    references: [],
    sourceIds: [],
    ...(n ? { parameters: { n, outputFormat: "png" as const } } : {}),
  });
  const save = (s: ImageBatchState, tasks: ImageBatchTask[]) =>
    engine.command({
      operation: "save",
      batchId: s.id,
      version: s.version,
      name: s.name,
      brief: s.brief,
      defaults: s.defaults,
      tasks,
    });
  const confirm = (s: ImageBatchState, requestId = randomUUID()) =>
    engine.command({ operation: "confirm", batchId: s.id, version: s.version, requestId });
  const settle = async (id: string) => {
    await vi.waitFor(
      async () => {
        await engine.tick();
        await images.tick();
        await engine.tick();
        expect((await engine.get(id)).executions.at(-1)?.finishedAt).toBeTruthy();
      },
      { timeout: 5000, interval: 20 },
    );
    return engine.get(id);
  };
  return {
    root,
    runtime,
    images,
    repo,
    engine,
    repository,
    provider,
    response,
    fetcher,
    png,
    create,
    task,
    save,
    confirm,
    settle,
    close: async () => {
      await images.shutdown();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
  vi.unstubAllGlobals();
});

describe("batch drafts and proposals", () => {
  it("allows more than 100 tasks, enforces the 500 image boundary and pages 500 distinct result identities", async () => {
    let s = await f.create();
    s = await f.save(
      s,
      Array.from({ length: 120 }, (_, i) => ({ ...f.task("staged" + i, 5), enabled: false })),
    );
    expect(s.tasks).toHaveLength(120);
    s = await f.save(
      s,
      Array.from({ length: 100 }, (_, i) => f.task("task" + i, 5)),
    );
    expect((await f.engine.preflight(s.id)).images).toBe(500);
    expect(
      imageBatchPlanCounts([{ ...f.task("inherit"), parameters: { quality: "high" } }], s.defaults)
        .images,
    ).toBe(2);
    await expect(f.save(s, [...s.tasks, f.task("extra", 1)])).rejects.toThrow("500");
    await expect(
      f.save(
        s,
        s.tasks.map((task, i) => (i === 0 ? { ...task, parameters: { n: 6 } } : task)),
      ),
    ).rejects.toThrow("500");
    const asset = await f.images.upload(f.png, "mock.png");
    await f.repo.save(
      s,
      Array.from({ length: 500 }, (_, i) => ({
        id: "candidate" + i,
        batchId: s.id,
        executionId: "execution",
        attemptId: "attempt" + Math.floor(i / 5),
        taskId: "task" + Math.floor(i / 5),
        taskName: "Task",
        position: i % 5,
        asset,
        prompt: "prompt",
        model: "mock",
        parameters: { n: 5 },
        createdAt: asset.createdAt,
        adopted: i % 2 === 0,
      })),
    );
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await f.repo.results({ batchId: s.id, ...(cursor ? { cursor } : {}) });
      expect(page.results.length).toBeLessThanOrEqual(100);
      page.results.forEach((result) => {
        expect(ids.has(result.id)).toBe(false);
        ids.add(result.id);
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(500);
    expect((await f.repo.results({ batchId: s.id, filter: "adopted" })).total).toBe(250);
  });
  it("previews before applying, checks versions, counts row overrides and freezes executions", async () => {
    let s = await f.create();
    s = await f.engine.command({
      operation: "bind-thread",
      batchId: s.id,
      version: s.version,
      threadId: "thread",
    });
    const tasks = Array.from({ length: 6 }, (_, i) => f.task("task" + i));
    const proposal = {
      batchId: s.id,
      baseVersion: s.version,
      requestId: randomUUID(),
      summary: "six images",
      warnings: [],
      tasks,
    };
    s = await f.engine.propose(proposal, "thread", "turn");
    expect(s.tasks).toEqual([]);
    expect(imageBatchDiff(s.tasks, tasks).added).toHaveLength(6);
    s = await f.engine.command({
      operation: "apply-proposal",
      batchId: s.id,
      version: s.version,
      proposalId: s.proposals[0]!.id,
    });
    expect(imageBatchPlanCounts(s.tasks, s.defaults).images).toBe(12);
    s = await f.save(
      s,
      s.tasks.map((t, i) => (i === 0 ? { ...t, parameters: { n: 1 } } : t)),
    );
    expect((await f.engine.preflight(s.id)).images).toBe(11);
    await expect(f.save({ ...s, version: s.version - 1 }, [])).rejects.toThrow("changed");
    await expect(
      f.engine.propose({ ...proposal, requestId: randomUUID() }, "thread", "turn2"),
    ).rejects.toThrow("changed");
    s = await f.confirm(s);
    const frozen = structuredClone(s.executions[0]);
    s = await f.save(s, [{ ...s.tasks[0]!, prompt: "next draft" }]);
    expect(s.executions[0]).toEqual(frozen);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.confirm(s)).rejects.toThrow("active execution");
  });
  it("rejects foreign references and source IDs, and keeps sent sources after conversation removal", async () => {
    let s = await f.create();
    s = await f.engine.command({
      operation: "bind-thread",
      batchId: s.id,
      version: s.version,
      threadId: "thread",
    });
    const source = {
      id: "source",
      name: "brief.weird",
      mimeType: "application/octet-stream",
      bytes: 3,
      threadId: "thread",
      messageId: "message",
      attachmentId: "sent",
      data: new Uint8Array([1, 2, 3]),
    };
    s = await f.engine.captureSources(s.id, "thread", [source]);
    const input = {
      batchId: s.id,
      baseVersion: s.version,
      requestId: randomUUID(),
      summary: "",
      warnings: [],
      tasks: [{ ...f.task("one"), sourceIds: ["foreign"] }],
    };
    await expect(f.engine.propose(input, "thread", "turn")).rejects.toThrow("not owned");
    await expect(f.engine.captureSources(s.id, "foreign", [source])).rejects.toThrow("Invalid");
    await f.engine.detachThread("thread");
    expect(await f.engine.sourceBytes(s.id, "source")).toEqual(source.data);
    expect((await f.engine.get(s.id)).sources).toHaveLength(1);
  });
});
describe("staged references", () => {
  it("accepts this batch's results as references and rejects another batch's results", async () => {
    f.fetcher.mockImplementation(async () => f.response(1));
    let s = await f.save(await f.create(), [
      { ...f.task("sample", 1), output: "heroes/sample.png" },
    ]);
    s = await f.confirm(s);
    s = await f.settle(s.id);
    s = await f.engine.command({
      operation: "bind-thread",
      batchId: s.id,
      version: s.version,
      threadId: "thread",
    });
    const [sample] = (await f.repo.results({ batchId: s.id })).results;
    expect(sample!.output).toBe("heroes/sample.png");
    const reference = { id: "ref", assetId: sample!.asset.id, documentId: null };
    const proposal = (tasks: ImageBatchTask[], state = s) => ({
      batchId: state.id,
      baseVersion: state.version,
      requestId: randomUUID(),
      summary: "",
      warnings: [],
      tasks,
    });
    s = await f.engine.propose(
      proposal([s.tasks[0]!, { ...f.task("later"), references: [reference] }]),
      "thread",
      "turn",
    );
    expect(s.proposals.at(-1)!.tasks[1]!.references[0]!.assetId).toBe(sample!.asset.id);
    let other = await f.create();
    other = await f.engine.command({
      operation: "bind-thread",
      batchId: other.id,
      version: other.version,
      threadId: "other-thread",
    });
    await expect(
      f.engine.propose(
        proposal([{ ...f.task("foreign"), references: [reference] }], other),
        "other-thread",
        "turn",
      ),
    ).rejects.toThrow("not owned");
  });
});
describe("batch execution consistency", () => {
  it("requires verification when a missing retry descendant is uncertain", async () => {
    f.fetcher.mockImplementation(async () => f.response(1));
    let s = await f.save(await f.create(), [f.task("one", 2)]);
    s = await f.confirm(s);
    s = await f.settle(s.id);
    const parent = s.executions[0]!.attempts[0]!;
    s = await f.engine.command({
      operation: "retry",
      batchId: s.id,
      version: s.version,
      requestId: randomUUID(),
      attemptIds: [parent.id],
      mode: "missing",
      acknowledgeUncertain: false,
    });
    await f.engine.tick();
    s = await f.engine.get(s.id);
    const child = s.executions.at(-1)!.attempts[0]!;
    const job = await f.images.getJob(child.jobId!);
    await Effect.runPromise(f.repository.saveJob({ ...job, status: "running" }));
    await f.images.initialize();
    await f.engine.tick();
    await expect(
      f.engine.command({
        operation: "retry",
        batchId: s.id,
        version: s.version,
        requestId: randomUUID(),
        attemptIds: [parent.id],
        mode: "missing",
        acknowledgeUncertain: false,
      }),
    ).rejects.toThrow("Verify");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("deduplicates confirmations and lost task acknowledgements, preserves identical candidates and database source filtering", async () => {
    let s = await f.save(await f.create(), [f.task("one")]);
    const requestId = randomUUID();
    s = await f.confirm(s, requestId);
    expect(
      (await f.confirm({ ...s, version: s.executions[0]!.draftVersion }, requestId)).executions,
    ).toHaveLength(1);
    expect(
      (
        await f.engine.command({
          requestId,
          version: s.executions[0]!.draftVersion,
          batchId: s.id,
          operation: "confirm",
        })
      ).executions,
    ).toHaveLength(1);
    await expect(
      f.engine.command({
        operation: "retry",
        batchId: s.id,
        version: s.version,
        requestId,
        attemptIds: [s.executions[0]!.attempts[0]!.id],
        mode: "regenerate",
        acknowledgeUncertain: false,
      }),
    ).rejects.toThrow("different content");
    const create = f.images.createJob.bind(f.images);
    const spy = vi.spyOn(f.images, "createJob").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("lost acknowledgement");
    });
    await f.engine.tick();
    expect((await f.engine.get(s.id)).executions[0]!.attempts[0]!.jobId).toBeTruthy();
    s = await f.settle(s.id);
    spy.mockRestore();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const results = (await f.repo.results({ batchId: s.id })).results;
    expect(results).toHaveLength(2);
    expect(results[0]!.asset.id).toBe(results[1]!.asset.id);
    expect(results[0]!.id).not.toBe(results[1]!.id);
    expect(
      (await Effect.runPromise(f.repository.listJobs({ origin: "drawing" }))).jobs,
    ).toHaveLength(0);
    expect((await Effect.runPromise(f.repository.listJobs({ origin: "all" }))).jobs).toHaveLength(
      1,
    );
    await f.engine.command({
      operation: "adopt",
      batchId: s.id,
      resultIds: [results[0]!.id],
      adopted: true,
    });
    expect((await f.repo.results({ batchId: s.id, filter: "adopted" })).total).toBe(1);
  });
  it("fills only the remaining deficit across retries and never silently repeats unknown requests", async () => {
    f.fetcher.mockImplementation(async () => f.response(1));
    let s = await f.save(await f.create(), [f.task("one", 3)]);
    s = await f.confirm(s);
    s = await f.settle(s.id);
    const original = s.executions[0]!.attempts[0]!;
    expect(original.status).toBe("partial");
    s = await f.engine.command({
      operation: "retry",
      batchId: s.id,
      version: s.version,
      requestId: randomUUID(),
      attemptIds: [original.id],
      mode: "missing",
      acknowledgeUncertain: false,
    });
    expect(s.executions.at(-1)!.attempts[0]!.parameters.n).toBe(2);
    s = await f.settle(s.id);
    s = await f.engine.command({
      operation: "retry",
      batchId: s.id,
      version: s.version,
      requestId: randomUUID(),
      attemptIds: [original.id],
      mode: "missing",
      acknowledgeUncertain: false,
    });
    expect(s.executions.at(-1)!.attempts[0]!.parameters.n).toBe(1);
    s = await f.settle(s.id);
    await expect(
      f.engine.command({
        operation: "retry",
        batchId: s.id,
        version: s.version,
        requestId: randomUUID(),
        attemptIds: [original.id],
        mode: "missing",
        acknowledgeUncertain: false,
      }),
    ).rejects.toThrow("No missing");
    expect((await f.repo.results({ batchId: s.id })).total).toBe(3);
    let unknown = await f.save(await f.create(), [f.task("unknown", 1)]);
    unknown = await f.confirm(unknown);
    await f.engine.tick();
    const attempt = (await f.engine.get(unknown.id)).executions[0]!.attempts[0]!;
    const job = await f.images.getJob(attempt.jobId!);
    await Effect.runPromise(f.repository.saveJob({ ...job, status: "running" }));
    await f.images.initialize();
    await f.engine.tick();
    unknown = await f.engine.get(unknown.id);
    expect(unknown.executions[0]!.attempts[0]!.status).toBe("uncertain");
    await expect(
      f.engine.command({
        operation: "retry",
        batchId: unknown.id,
        version: unknown.version,
        requestId: randomUUID(),
        attemptIds: [attempt.id],
        mode: "missing",
        acknowledgeUncertain: false,
      }),
    ).rejects.toThrow("Verify");
  });
  it("pauses unsent requests, reserves direct drawing capacity and retains results when cancelling", async () => {
    let release: ((value: Response) => void) | undefined;
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    let s = await f.save(await f.create(), [f.task("one", 1), f.task("two", 1)]);
    s = await f.confirm(s);
    await f.engine.tick();
    await f.images.tick();
    const execution = s.executions[0]!;
    await f.engine.command({ operation: "pause", batchId: s.id, executionId: execution.id });
    const direct: ImageJobCreateInput = {
      clientRequestId: randomUUID(),
      providerId: f.provider.id,
      model: "mock",
      prompt: "direct",
      parameters: { n: 1 },
      inputAssetIds: [],
      maskAssetId: null,
      sourceJobId: null,
    };
    await f.images.createJob(direct);
    await f.images.tick();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    release!(f.response());
    await vi.waitFor(async () =>
      expect(
        (await f.images.getJob((await f.engine.get(s.id)).executions[0]!.attempts[0]!.jobId!))
          .status,
      ).toBe("succeeded"),
    );
    await f.engine.tick();
    await f.images.tick();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.engine.command({ operation: "cancel", batchId: s.id, executionId: execution.id });
    s = await f.settle(s.id);
    expect(s.executions[0]!.attempts.map((a) => a.status)).toEqual(["succeeded", "cancelled"]);
    expect((await f.repo.results({ batchId: s.id })).total).toBe(1);
  });
  it("blocks a rate-limited channel and resumes only after user intervention", async () => {
    f.fetcher.mockImplementationOnce(async () => f.response(0, 429));
    let s = await f.save(await f.create(), [f.task("one", 1), f.task("two", 1)]);
    s = await f.confirm(s);
    await f.engine.tick();
    await f.images.tick();
    await vi.waitFor(async () =>
      expect(
        (await f.images.getJob((await f.engine.get(s.id)).executions[0]!.attempts[0]!.jobId!))
          .status,
      ).toBe("failed"),
    );
    await f.engine.tick();
    await f.images.tick();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.engine.get(s.id)).executions[0]!.blockedProviders).toEqual([f.provider.id]);
    await f.engine.command({
      operation: "resume",
      batchId: s.id,
      executionId: s.executions[0]!.id,
    });
    await f.settle(s.id);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("protects batch assets after engine jobs are removed and supports recoverable archive", async () => {
    let s = await f.save(await f.create(), [f.task("one", 1)]);
    s = await f.confirm(s);
    s = await f.settle(s.id);
    const result = (await f.repo.results({ batchId: s.id })).results[0]!;
    await f.images.deleteJob(s.executions[0]!.attempts[0]!.jobId!);
    expect((await f.images.getAsset(result.asset.id)).id).toBe(result.asset.id);
    s = await f.engine.command({
      operation: "archive",
      batchId: s.id,
      version: s.version,
      archived: true,
    });
    expect((await f.repo.list({ filter: "archived" })).batches).toHaveLength(1);
    s = await f.engine.command({
      operation: "archive",
      batchId: s.id,
      version: s.version,
      archived: false,
    });
    expect(s.archived).toBe(false);
    expect((await f.repo.results({ batchId: s.id })).total).toBe(1);
  });
  it("retains originals while a durable resource copy is pending, even after removing the batch", async () => {
    let s = await f.save(await f.create(), [f.task("one", 1)]);
    s = await f.confirm(s);
    s = await f.settle(s.id);
    const result = (await f.repo.results({ batchId: s.id })).results[0]!;
    s = await f.engine.command({
      operation: "collection-start",
      batchId: s.id,
      operationId: "copy",
      resultIds: [result.id],
    });
    s = await f.engine.command({ operation: "remove", batchId: s.id, version: s.version });
    await expect(
      f.engine.command({ operation: "clear-originals", batchId: s.id, version: s.version }),
    ).rejects.toThrow("pending resource copies");
    await f.engine.command({
      operation: "collection",
      batchId: s.id,
      resultId: result.id,
      libraryId: "library",
      resourceId: "resource",
    });
    s = await f.engine.command({
      operation: "collection-finish",
      batchId: s.id,
      operationId: "copy",
    });
    s = await f.engine.command({ operation: "clear-originals", batchId: s.id, version: s.version });
    expect((await f.repo.results({ batchId: s.id })).total).toBe(0);
    expect(s.activeCollections).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
const ref = (id: string, assetId: string) => ({ id, assetId, documentId: null });
describe("batch style", () => {
  const withStyle = (
    s: ImageBatchState,
    style: Pick<ImageBatchState["defaults"], "stylePrompt" | "styleReferences">,
    tasks: ImageBatchTask[] = s.tasks,
  ) =>
    f.engine.command({
      operation: "save",
      batchId: s.id,
      version: s.version,
      name: s.name,
      brief: s.brief,
      defaults: { ...s.defaults, ...style },
      tasks,
    });
  const sentPrompts = () =>
    f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).prompt as string);
  it("freezes the style at confirmation and reuses it unchanged for retries", async () => {
    let s = await withStyle(await f.create(), { stylePrompt: "  flat pixel art  " }, [
      f.task("one", 1),
    ]);
    expect((await f.engine.preflight(s.id)).issues).toEqual([]);
    s = await f.confirm(s);
    expect(s.executions[0]!.attempts[0]).toMatchObject({
      prompt: "image one",
      stylePrompt: "flat pixel art",
    });
    s = await f.settle(s.id);
    expect(sentPrompts()).toEqual(["flat pixel art\n\nimage one"]);
    expect((await f.repo.results({ batchId: s.id })).results[0]!.prompt).toBe(
      "flat pixel art\n\nimage one",
    );
    // A later style edit applies to the next confirmation only, never to a retry of an old attempt.
    s = await withStyle(s, { stylePrompt: "watercolor" });
    s = await f.engine.command({
      operation: "retry",
      batchId: s.id,
      version: s.version,
      requestId: randomUUID(),
      attemptIds: [s.executions[0]!.attempts[0]!.id],
      mode: "regenerate",
      acknowledgeUncertain: false,
    });
    expect(s.executions.at(-1)!.attempts[0]!.stylePrompt).toBe("flat pixel art");
    s = await f.settle(s.id);
    expect(sentPrompts()).toEqual(["flat pixel art\n\nimage one", "flat pixel art\n\nimage one"]);
  });
  it("places style references first, sends a shared image once and protects style assets", async () => {
    const color = async (r: number) =>
      sharp({ create: { width: 4, height: 4, channels: 4, background: { r, g: 9, b: 9 } } })
        .png()
        .toBuffer();
    const style = await f.images.upload(await color(200), "style.png");
    const own = await f.images.upload(await color(100), "own.png");
    let s = await withStyle(await f.create(), { styleReferences: [ref("style", style.id)] }, [
      { ...f.task("one", 1), references: [ref("own", own.id), ref("again", style.id)] },
    ]);
    const sql = await f.runtime.runPromise(
      Effect.gen(function* () {
        return yield* SqlClient.SqlClient;
      }),
    );
    const refs = await Effect.runPromise(
      sql<{ asset_id: string }>`SELECT asset_id FROM image_batch_asset_refs WHERE batch_id=${s.id}`,
    );
    expect(refs.map((r) => r.asset_id)).toContain(style.id);
    s = await f.engine.command({
      operation: "confirm",
      batchId: s.id,
      version: s.version,
      requestId: randomUUID(),
    });
    expect(s.executions[0]!.attempts[0]!.references.map((r) => r.assetId)).toEqual([
      style.id,
      own.id,
    ]);
    await f.settle(s.id);
    // A task that fits on its own but exceeds the request limit with the style is reported.
    const distinct = await Promise.all(
      Array.from({ length: 17 }, async (_, i) =>
        f.images.upload(
          await sharp({
            create: { width: 4, height: 4, channels: 4, background: { r: i, g: 0, b: 0 } },
          })
            .png()
            .toBuffer(),
          i + ".png",
        ),
      ),
    );
    s = await withStyle(
      await f.engine.get(s.id),
      { styleReferences: distinct.slice(0, 8).map((a) => ref("s" + a.id, a.id)) },
      [{ ...f.task("full", 1), references: distinct.slice(8).map((a) => ref("t" + a.id, a.id)) }],
    );
    expect((await f.engine.preflight(s.id)).issues.map((i) => i.message)).toEqual([
      "Batch style and task references exceed 16 images.",
    ]);
  });
});
