import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { ImageJobCreateInput, ImageProviderInput } from "@synara/contracts";
import { layerMemory } from "../persistence/NodeSqliteClient";
import editMigration from "../persistence/Migrations/136_ImageEditDocuments";
import migration from "../persistence/Migrations/135_ImageGeneration";
import { ImageGenerationRepositoryLive } from "../persistence/Layers/ImageGenerationRepository";
import { ImageGenerationRepository } from "../persistence/Services/ImageGenerationRepository";
import { ImageGenerationEngine } from "./imageGenerationEngine";
import {
  discoverImageModels,
  downloadImage,
  imageEndpoint,
  imageRequestParameters,
  isPublicImageAddress,
  requestImages,
} from "./imageApi";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

const providerInput = (name = "One"): ImageProviderInput => ({
  name,
  baseUrl: "https://mock.example/custom/api",
  apiKey: "test-provider-secret",
  enabled: true,
  models: [{ id: "gpt-image-test", source: "manual", lastTestAt: null, lastTestStatus: null }],
  defaultModel: "gpt-image-test",
  concurrency: 2,
  timeoutSeconds: 600,
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aha-drawing-test-"));
  const runtime = ManagedRuntime.make(
    ImageGenerationRepositoryLive.pipe(
      Layer.provideMerge(
        Layer.effectDiscard(
          Effect.gen(function* () {
            yield* migration;
            yield* editMigration;
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
  const values = new Map<string, Uint8Array>();
  const secrets: ServerSecretStoreShape = {
    get: (id) => Effect.succeed(values.get(id) ?? null),
    set: (id, value) =>
      Effect.sync(() => {
        values.set(id, value);
      }),
    remove: (id) =>
      Effect.sync(() => {
        values.delete(id);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  };
  const engine = new ImageGenerationEngine(repository, secrets, root, async () => {});
  await engine.initialize();
  const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: "blue" } })
    .png()
    .toBuffer();
  const response = (n = 1) =>
    new Response(
      JSON.stringify({
        data: Array.from({ length: n }, () => ({ b64_json: png.toString("base64") })),
        usage: { total_tokens: 4 },
        size: "16x12",
      }),
      { headers: { "x-request-id": "mock-request" } },
    );
  const close = async () => {
    await engine.shutdown();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  };
  return { engine, repository, root, png, response, close };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
  vi.unstubAllGlobals();
});
const input = (id: string, extra: Partial<ImageJobCreateInput> = {}): ImageJobCreateInput => ({
  clientRequestId: randomUUID(),
  providerId: id,
  model: "gpt-image-test",
  prompt: "A blue circle",
  parameters: { n: 1 },
  inputAssetIds: [],
  maskAssetId: null,
  sourceJobId: null,
  ...extra,
});
async function waitFor(id: string, status: string) {
  await vi.waitFor(async () => expect((await f.engine.getJob(id)).status).toBe(status), {
    timeout: 3000,
    interval: 20,
  });
  return f.engine.getJob(id);
}

describe("image provider and Images API contracts", () => {
  it("preserves explicitly configured root paths and omits default fields", () => {
    expect(imageEndpoint("https://example.com/custom/v2/", "images/generations")).toBe(
      "https://example.com/custom/v2/images/generations",
    );
    expect(imageEndpoint("http://127.0.0.1:8000/", "models")).toBe("http://127.0.0.1:8000/models");
    for (const url of [
      "https://user:pass@example.com/v1",
      "https://example.com/v1?x=1",
      "https://example.com/#secret",
    ])
      expect(() => imageEndpoint(url, "models")).toThrow();
    expect(imageRequestParameters({ n: 1 })).toEqual({ n: 1 });
    expect(() => imageRequestParameters({ n: 1, background: "transparent" })).toThrow();
    expect(
      imageRequestParameters({
        n: 3,
        size: "1500x700",
        quality: "max",
        outputFormat: "webp",
        background: "transparent",
      }),
    ).toEqual({
      n: 3,
      size: "1500x700",
      quality: "max",
      output_format: "webp",
      background: "transparent",
    });
  });
  it("keeps independent provider secrets out of configuration and preserves selected models", async () => {
    const one = await f.engine.upsertProvider(providerInput()),
      two = await f.engine.upsertProvider({ ...providerInput("Two"), apiKey: "second-secret" });
    expect(JSON.stringify(await f.engine.listProviders())).not.toContain("secret");
    expect(await f.engine.key(one.id)).toBe("test-provider-secret");
    expect(await f.engine.key(two.id)).toBe("second-secret");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "text-model" }, { id: "gpt-image" }, { id: "gpt-image" }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await f.engine.discoverModels({ id: one.id, baseUrl: one.baseUrl })).models.map((m) => m.id),
    ).toEqual(["gpt-image", "text-model"]);
    expect((await f.engine.listProviders())[0]?.models.map((m) => m.id)).toEqual([
      "gpt-image-test",
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://mock.example/custom/api/models");
  });
  it.each([401, 404, 429, 500])("classifies %s errors and redacts credentials", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "bad test-provider-secret Bearer test-provider-secret" },
          }),
          { status },
        ),
      ),
    );
    await expect(
      discoverImageModels("https://mock.example", "test-provider-secret"),
    ).rejects.toMatchObject({ upstreamStatus: status });
    try {
      await discoverImageModels("https://mock.example", "test-provider-secret");
    } catch (error) {
      expect(String(error)).not.toContain("test-provider-secret");
    }
  });
  it("reports malformed/empty model lists and timeout without generation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("invalid"))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockRejectedValueOnce(new TypeError("Fetch failed with test-provider-secret"));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverImageModels("https://mock.example", "")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(discoverImageModels("https://mock.example", "")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(await discoverImageModels("https://mock.example", "")).toEqual([]);
    await expect(discoverImageModels("https://mock.example", "")).rejects.toMatchObject({
      code: "timeout",
      message: "Model discovery timed out after 15 seconds.",
    });
    await expect(
      discoverImageModels("https://mock.example", "test-provider-secret"),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: "Could not connect to image provider for model discovery.",
    });
  });
  it("searches all persisted history literally before filtering and paginating", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const jobs = [];
    for (let i = 0; i < 42; i++) {
      const job = await f.engine.createJob(
        input(p.id, { prompt: i === 0 ? "old literal %_ mountain" : `mountain ${i}` }),
      );
      const status =
        i < 32
          ? "succeeded"
          : i < 35
            ? "queued"
            : i < 37
              ? "partial"
              : i < 39
                ? "failed"
                : i === 39
                  ? "interrupted"
                  : "cancelled";
      await Effect.runPromise(f.repository.saveJob({ ...job, status }));
      jobs.push(job);
    }
    const literal = await Effect.runPromise(f.repository.listJobs({ query: "%_" }));
    expect(literal.jobs.map((job) => job.id)).toEqual([jobs[0]!.id]);
    const page = await Effect.runPromise(
      f.repository.listJobs({ query: "MOUNTAIN", statusGroup: "completed" }),
    );
    expect(page.jobs).toHaveLength(30);
    const rest = await Effect.runPromise(
      f.repository.listJobs({
        query: "mountain",
        statusGroup: "completed",
        cursor: page.nextCursor!,
      }),
    );
    expect(rest.jobs).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
    expect(new Set([...page.jobs, ...rest.jobs].map((job) => job.id)).size).toBe(32);
    expect(
      (await Effect.runPromise(f.repository.listJobs({ statusGroup: "active", query: "mountain" })))
        .jobs,
    ).toHaveLength(3);
    expect(
      (await Effect.runPromise(f.repository.listJobs({ statusGroup: "issues" }))).jobs,
    ).toHaveLength(5);
    expect(
      (await Effect.runPromise(f.repository.listJobs({ query: "missing" }))).jobs,
    ).toHaveLength(0);
    expect(
      (await Effect.runPromise(f.repository.listJobs({ statusGroup: "all" }))).jobs.some(
        (job) => job.status === "cancelled",
      ),
    ).toBe(true);
  });
  it("sends edits as multipart with references, mask and explicit parameters once", async () => {
    const fetcher = vi.fn().mockResolvedValue(f.response(2));
    vi.stubGlobal("fetch", fetcher);
    await requestImages({
      baseUrl: "https://mock.example/v1",
      key: "test",
      model: "any-model",
      prompt: "edit",
      parameters: {
        n: 2,
        quality: "xhigh",
        size: "16x12",
        outputFormat: "png",
        background: "transparent",
      },
      images: [f.png, f.png],
      mask: f.png,
      signal: new AbortController().signal,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://mock.example/v1/images/edits");
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(form.get("n")).toBe("2");
    expect(form.get("quality")).toBe("xhigh");
  });
  it("rejects local returned URLs while allowing explicit local provider roots", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicImageAddress(address)).toBe(false);
    expect(isPublicImageAddress("8.8.8.8")).toBe(true);
    await expect(
      downloadImage("http://127.0.0.1/result.png", new AbortController().signal),
    ).rejects.toMatchObject({ code: "unsafe_image_url" });
  });
});
describe("durable image generation tasks", () => {
  it("uses per-provider concurrency, idempotent submission and FIFO", async () => {
    const one = await f.engine.upsertProvider(providerInput()),
      two = await f.engine.upsertProvider(providerInput("Two"));
    let inflight = 0,
      max = 0;
    const release: Array<() => void> = [];
    const fetcher = vi.fn().mockImplementation(() => {
      inflight++;
      max = Math.max(max, inflight);
      return new Promise<Response>((resolve) =>
        release.push(() => {
          inflight--;
          resolve(f.response());
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const a = await f.engine.createJob(input(one.id)),
      b = await f.engine.createJob(input(one.id)),
      c = await f.engine.createJob(input(one.id)),
      d = await f.engine.createJob(input(two.id));
    expect(
      (await f.engine.createJob(input(one.id, { clientRequestId: a.clientRequestId }))).id,
    ).toBe(a.id);
    await f.engine.tick();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(max).toBe(3);
    expect((await f.engine.getJob(c.id)).status).toBe("queued");
    release.splice(0).forEach((fn) => fn());
    await waitFor(a.id, "succeeded");
    await waitFor(b.id, "succeeded");
    await waitFor(d.id, "succeeded");
    await f.engine.tick();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    release.splice(0).forEach((fn) => fn());
    await waitFor(c.id, "succeeded");
  });
  it("saves usable results, metadata and a partial result without resending", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const fetcher = vi.fn().mockResolvedValue(f.response());
    vi.stubGlobal("fetch", fetcher);
    const job = await f.engine.createJob(input(p.id, { parameters: { n: 2 } }));
    await f.engine.tick();
    const done = await waitFor(job.id, "partial");
    expect(done.outputs).toHaveLength(1);
    expect(done.actualParameters.size).toBe("16x12");
    expect(done.usage).toEqual({ total_tokens: 4 });
    expect(done.upstreamRequestId).toBe("mock-request");
    expect(await f.engine.assets.read(done.outputs[0]!)).toBeInstanceOf(Uint8Array);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry generation errors, saves a failed test and supports cancellation", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"message":"test-provider-secret rejected"}}', { status: 429 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const job = await f.engine.testModel({
      id: p.id,
      model: p.defaultModel,
      clientRequestId: randomUUID(),
    });
    await f.engine.tick();
    const failed = await waitFor(job.id, "failed");
    expect(failed.error?.message).not.toContain("test-provider-secret");
    expect((await f.engine.listProviders())[0]?.models[0]?.lastTestStatus).toBe("failed");
    await f.engine.tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );
    const running = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await f.engine.cancelJob(running.id);
    expect((await f.engine.getJob(running.id)).status).toBe("cancelled");
    const queued = await f.engine.createJob(input(p.id));
    await f.engine.cancelJob(queued.id);
    await f.engine.tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("pauses disabled providers and rejects queued jobs after connection/key changes", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const job = await f.engine.createJob(input(p.id));
    await f.engine.upsertProvider({ ...p, enabled: false });
    await f.engine.tick();
    expect((await f.engine.getJob(job.id)).status).toBe("queued");
    await expect(f.engine.deleteProvider(p.id)).rejects.toMatchObject({ code: "provider_busy" });
    await f.engine.upsertProvider({ ...p, apiKey: "new-secret", enabled: true });
    await f.engine.tick();
    expect((await f.engine.getJob(job.id)).error?.code).toBe("provider_changed");
  });
  it("normalizes EXIF orientation and validates mask dimensions and alpha", async () => {
    const rotated = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const base = await f.engine.upload(rotated, "rotated.jpg");
    expect([base.width, base.height]).toEqual([8, 12]);
    expect((await sharp(await f.engine.assets.read(base)).metadata()).orientation).toBeUndefined();
    const opaque = await f.engine.upload(
      await sharp({
        create: {
          width: 8,
          height: 12,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
      "mask.png",
    );
    await expect(f.engine.assets.validateMask(opaque, base)).rejects.toMatchObject({
      code: "empty_mask",
    });
    const mask = await f.engine.upload(
      await sharp({
        create: {
          width: 8,
          height: 12,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        },
      })
        .png()
        .toBuffer(),
      "mask.png",
    );
    await f.engine.assets.validateMask(mask, base);
    await expect(
      f.engine.assets.validateMask(mask, await f.engine.upload(f.png, "reference.png")),
    ).rejects.toMatchObject({ code: "invalid_mask" });
  });
  it("reports timeouts, corrupt images and disk failures without retry", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
        ),
      )
      .mockResolvedValueOnce(f.response());
    vi.stubGlobal("fetch", fetcher);
    const timeout = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    expect((await waitFor(timeout.id, "failed")).error?.code).toBe("timeout");
    const corrupt = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    expect((await waitFor(corrupt.id, "failed")).outputs).toHaveLength(0);
    vi.spyOn(f.engine.assets, "save").mockRejectedValueOnce(new Error("Disk full"));
    const disk = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    expect((await waitFor(disk.id, "failed")).error?.code).toBe("incomplete_results");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("keeps assets referenced by later edits/drafts after source deletion and paginates without duplicates", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(f.response()));
    const a = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    const done = await waitFor(a.id, "succeeded");
    const b = await f.engine.createJob(input(p.id, { inputAssetIds: [done.outputs[0]!.id] }));
    await f.engine.deleteJob(a.id);
    expect(await f.engine.getAsset(done.outputs[0]!.id)).toBeTruthy();
    await f.engine.cancelJob(b.id);
    await f.engine.upsertDraft({
      id: "draft",
      prompt: "",
      providerId: p.id,
      model: p.defaultModel,
      parameters: { n: 1 },
      inputAssetIds: [done.outputs[0]!.id],
      maskAssetId: null,
      updatedAt: new Date().toISOString(),
    });
    await f.engine.deleteJob(b.id);
    expect(await f.engine.getAsset(done.outputs[0]!.id)).toBeTruthy();
    for (let i = 0; i < 32; i++) await f.engine.createJob(input(p.id));
    const first = await Effect.runPromise(f.repository.listJobs({})),
      second = await Effect.runPromise(f.repository.listJobs({ cursor: first.nextCursor! }));
    expect(first.jobs).toHaveLength(30);
    expect(second.jobs).toHaveLength(2);
    expect(new Set([...first.jobs, ...second.jobs].map((j) => j.id)).size).toBe(32);
  });
  it("recovers interrupted requests and saving checkpoints without generation POSTs", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    const a = await f.engine.createJob(input(p.id)),
      b = await f.engine.createJob(input(p.id, { parameters: { n: 2 } }));
    const asset = await f.engine.upload(f.png, "result.png");
    await Effect.runPromise(f.repository.saveJob({ ...a, status: "running" }));
    await Effect.runPromise(f.repository.saveJob({ ...b, status: "saving", outputs: [asset] }));
    await writeFile(
      path.join(f.root, "pending", `${b.id}.json`),
      JSON.stringify({
        payload: { data: [{ b64_json: "invalid" }, { b64_json: f.png.toString("base64") }] },
        saved: { "1": asset.id },
      }),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const recovered = new ImageGenerationEngine(
      f.repository,
      f.engine.secrets,
      f.root,
      async () => {},
    );
    await recovered.initialize();
    expect((await recovered.getJob(a.id)).status).toBe("interrupted");
    const restored = await recovered.getJob(b.id);
    expect(restored.status).toBe("partial");
    expect(restored.outputs).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
    await recovered.shutdown();
    expect(JSON.stringify(restored)).not.toContain("test-provider-secret");
  });
  it("deletes unreferenced job assets without deleting new uploads", async () => {
    const p = await f.engine.upsertProvider(providerInput());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(f.response()));
    const a = await f.engine.createJob(input(p.id));
    await f.engine.tick();
    const done = await waitFor(a.id, "succeeded");
    const other = await f.engine.upload(
      await sharp(f.png).negate().png().toBuffer(),
      "new-upload.png",
    );
    await f.engine.deleteJob(a.id);
    expect(await f.engine.getAsset(other.id)).toBeTruthy();
    await expect(readFile(f.engine.assets.filePath(done.outputs[0]!.id))).rejects.toThrow();
  });
});

describe("editable image documents", () => {
  it("persists immutable objects, expands comments once, and retains source assets", async () => {
    const provider = await f.engine.upsertProvider(providerInput());
    const base = await f.engine.upload(f.png, "base.png");
    const bytes = await sharp(f.png).tint("red").png().toBuffer();
    const composite = await f.engine.upload(bytes, "annotated.png");
    const document = await f.engine.createDocument({
      baseAssetId: base.id,
      compositeAssetId: composite.id,
      width: 16,
      height: 12,
      elements: [
        {
          id: "object",
          type: "shape",
          shape: "rect",
          start: { x: 2, y: 2 },
          end: { x: 10, y: 10 },
          color: "#ff0000",
          width: 2,
        },
      ],
      comments: [{ id: "comment", x: 0.52, y: 0.41, text: "Change to red" }],
    });
    const reference = { id: "stable-reference", assetId: composite.id, documentId: document.id };
    const job = await f.engine.createJob(
      input(provider.id, {
        prompt: "",
        inputAssetIds: [composite.id],
        inputReferences: [reference],
      }),
    );
    expect(job.prompt).toBe("");
    expect(job.requestPrompt).toBe("[image 1] notes:\n1. (X=52%, Y=41%) Change to red");
    expect((await f.engine.getDocument(document.id)).elements).toEqual(document.elements);
    const again = await f.engine.createJob(
      input(provider.id, {
        prompt: job.prompt,
        inputAssetIds: [composite.id],
        inputReferences: job.inputReferences,
      }),
    );
    expect(again.requestPrompt).toBe(job.requestPrompt);
    await f.engine.upsertDraft({
      id: "doc-draft",
      prompt: "",
      providerId: provider.id,
      model: provider.defaultModel,
      parameters: { n: 1 },
      inputAssetIds: [composite.id],
      inputReferences: [reference],
      maskAssetId: null,
      updatedAt: new Date().toISOString(),
    });
    await f.engine.cancelJob(job.id);
    await f.engine.deleteJob(job.id);
    expect((await f.engine.getDocument(document.id)).id).toBe(document.id);
    expect((await f.engine.getAsset(base.id)).id).toBe(base.id);
    expect(
      (await Effect.runPromise(f.repository.getDraft("doc-draft")))?.inputReferences?.[0]
        ?.comments?.[0]?.text,
    ).toBe("Change to red");
    await expect(
      f.engine.createJob(
        input(provider.id, { inputAssetIds: [base.id], inputReferences: [reference] }),
      ),
    ).rejects.toThrow("Reference metadata");
    await expect(
      f.engine.createJob(
        input(provider.id, {
          inputAssetIds: [base.id],
          inputReferences: [{ ...reference, assetId: base.id }],
        }),
      ),
    ).rejects.toThrow("does not match");
    await expect(
      f.engine.createDocument({ ...document, compositeAssetId: composite.id, width: 17 }),
    ).rejects.toThrow("dimensions");
  });
  it("reorders comment numbers by reference order and rejects expanded prompts above the limit", async () => {
    const provider = await f.engine.upsertProvider(providerInput());
    const asset = await f.engine.upload(f.png, "ref.png");
    const doc = await f.engine.createDocument({
      baseAssetId: asset.id,
      compositeAssetId: asset.id,
      width: 16,
      height: 12,
      elements: [],
      comments: [{ id: "c", x: 0.1, y: 0.8, text: "Remove" }],
    });
    const refs = [
      { id: "a", assetId: asset.id, documentId: null },
      { id: "b", assetId: asset.id, documentId: doc.id },
    ];
    const job = await f.engine.createJob(
      input(provider.id, { inputAssetIds: [asset.id, asset.id], inputReferences: refs }),
    );
    expect(job.requestPrompt).toContain("[image 2] notes:");
    const moved = await f.engine.createJob(
      input(provider.id, {
        inputAssetIds: [asset.id, asset.id],
        inputReferences: [refs[1]!, refs[0]!],
      }),
    );
    expect(moved.requestPrompt).toContain("[image 1] notes:");
    await expect(
      f.engine.createJob(
        input(provider.id, {
          prompt: "x".repeat(32000),
          inputAssetIds: [asset.id, asset.id],
          inputReferences: refs,
        }),
      ),
    ).rejects.toThrow("32,000");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const detached = { ...doc, id: randomUUID(), createdAt: old };
    await Effect.runPromise(f.repository.saveDocument(detached));
    await f.engine.cleanup(false);
    await expect(f.engine.getDocument(detached.id)).rejects.toThrow("not found");
    expect((await f.engine.getDocument(doc.id)).id).toBe(doc.id);
  });
});

// The sprite orchestration uses the actual Drawing engine/repository and a mock
// upstream, so reference uploads, idempotency and job recovery cross the real boundary.
describe("sprite workbench generation through Drawing", () => {
  it("generates a reference and action, restores records, and keeps retries explicit", async () => {
    const { SpriteEngine } = await import("../spriteAnimation/spriteEngine");
    const provider = await f.engine.upsertProvider(providerInput());
    const sprites = new SpriteEngine(path.join(f.root, "sprites"), f.engine, async () => {});
    await sprites.initialize();
    const context = {
      projectId: "sprite-project",
      threadId: "sprite-thread",
      name: "Fox",
      providerId: provider.id,
      model: "gpt-image-test",
      referenceAssetId: null,
      action: "idle",
      frameCount: 2,
      fps: 12,
      width: 16,
      height: 16,
      background: "chroma" as const,
      chromaKey: "#00ff00",
    };
    await sprites.command({ operation: "sync", projectId: context.projectId, context });
    const bytes = await sharp(
      Buffer.from(
        '<svg width="32" height="16"><rect width="32" height="16" fill="#00ff00"/><rect x="5" y="8" width="4" height="6" fill="red"/><rect x="22" y="5" width="4" height="6" fill="red"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const upstream = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] })),
    );
    vi.stubGlobal("fetch", upstream);
    const create = {
      operation: "generate" as const,
      projectId: context.projectId,
      input: { requestId: "character-one", kind: "character" as const, prompt: "Fox" },
    };
    const first = await sprites.command(create);
    const jobId = first.runs[0]!.jobId!;
    expect((await sprites.command(create)).runs).toHaveLength(1);
    await f.engine.tick();
    await waitFor(jobId, "succeeded");
    await sprites.tick();
    const done = await sprites.command({ operation: "get", projectId: context.projectId });
    expect(done.runs[0]!.frames).toHaveLength(1);
    await sprites.command({
      operation: "sync",
      projectId: context.projectId,
      context: { ...context, referenceAssetId: done.runs[0]!.frames[0]!.id },
    });
    const animation = await sprites.command({
      operation: "generate",
      projectId: context.projectId,
      input: { requestId: "idle-one", kind: "animation", prompt: "Idle breathing" },
    });
    const animationJob = animation.runs[1]!.jobId!;
    expect((await f.engine.getJob(animationJob)).inputs).toHaveLength(2);
    await f.engine.tick();
    await waitFor(animationJob, "succeeded");
    await sprites.tick();
    const restored = new SpriteEngine(path.join(f.root, "sprites"), f.engine, async () => {});
    await restored.initialize();
    const recovered = await restored.forThread("sprite-thread");
    expect(recovered?.runs[1]!.frames).toHaveLength(2);
    expect(recovered?.runs[1]!.status).toBe("ready");
    await f.engine.deleteJob(animationJob);
    expect((await f.engine.getAsset(recovered!.runs[1]!.source!.id)).id).toBe(
      recovered!.runs[1]!.source!.id,
    );
    expect((await f.engine.getAsset(recovered!.runs[1]!.frames[0]!.id)).id).toBe(
      recovered!.runs[1]!.frames[0]!.id,
    );
    const calls = upstream.mock.calls.length;
    await restored.tick();
    expect(upstream.mock.calls).toHaveLength(calls);
    const retry = await restored.command({
      operation: "retry",
      projectId: context.projectId,
      runId: recovered!.runs[1]!.id,
      input: { requestId: "retry-idle", kind: "animation", prompt: "More motion" },
    });
    expect(retry.runs).toHaveLength(3);
    expect(retry.runs[1]!.frames).toHaveLength(2);
    await restored.command({
      operation: "cancel",
      projectId: context.projectId,
      runId: retry.runs[2]!.id,
    });
    expect(
      (await restored.command({ operation: "get", projectId: context.projectId })).runs[2]!.status,
    ).toBe("cancelled");
  });
});
