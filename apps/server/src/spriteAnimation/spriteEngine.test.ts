import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpriteContext, SpriteState } from "@synara/contracts";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { SpriteEngine } from "./spriteEngine";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-delete-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const context = (id: string, asset = "shared-reference"): SpriteContext => ({
  projectId: id,
  threadId: `thread-${id}`,
  name: id,
  providerId: "drawing",
  model: "test",
  referenceAssetId: asset,
  action: "idle",
  frameCount: 8,
  fps: 12,
  width: 16,
  height: 16,
  background: "chroma",
  chromaKey: "#00ff00",
});
function fixture() {
  const images = { spriteAssetIds: new Set<string>(), cancelJob: vi.fn(async () => undefined) };
  const sprites = new SpriteEngine(
    root,
    images as unknown as ImageGenerationEngine,
    async () => {},
  );
  return { images, sprites };
}
describe("sprite project deletion", () => {
  it("removes bindings and records while retaining live shared references", async () => {
    const { images, sprites } = fixture();
    await sprites.initialize();
    for (const id of ["a", "b"])
      await sprites.command({ operation: "sync", projectId: id, context: context(id) });
    await sprites.command({ operation: "delete", projectId: "a" });
    expect(await sprites.forThread("thread-a")).toBeNull();
    expect(images.spriteAssetIds.has("shared-reference")).toBe(false);
    await expect(readFile(path.join(root, "a.json"))).rejects.toThrow();
    await sprites.command({ operation: "delete", projectId: "b" });
    expect(images.spriteAssetIds.size).toBe(0);
    await sprites.command({ operation: "delete", projectId: "a" });
    for (const operation of ["get", "sync", "generate"] as const)
      await expect(
        sprites.command({ operation, projectId: "a", context: context("a") }),
      ).rejects.toThrow("deleted");
    const restored = fixture();
    await restored.sprites.initialize();
    await expect(
      restored.sprites.command({ operation: "sync", projectId: "a", context: context("a") }),
    ).rejects.toThrow("deleted");
  });
  it("cancels active generation and can finish after a failed cancellation and restart", async () => {
    const c = context("a");
    const state: SpriteState = {
      context: c,
      runs: [
        {
          id: "run",
          context: c,
          input: { kind: "animation", requestId: "request", prompt: "idle" },
          jobId: "active-job",
          status: "running",
          source: null,
          frames: [],
          warnings: [],
          error: null,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await writeFile(path.join(root, "a.json"), JSON.stringify(state));
    const { images, sprites } = fixture();
    await sprites.initialize();
    images.cancelJob.mockRejectedValueOnce(new Error("cancel unavailable"));
    await expect(sprites.command({ operation: "delete", projectId: "a" })).rejects.toThrow(
      "cancel unavailable",
    );
    await expect(
      sprites.command({ operation: "sync", projectId: "a", context: c }),
    ).rejects.toThrow("deleted");
    const restarted = fixture();
    await restarted.sprites.initialize();
    expect(restarted.images.cancelJob).toHaveBeenCalledWith("active-job");
    await expect(readFile(path.join(root, "a.json"))).rejects.toThrow();
  });
  it("retains multiple bindings and ignores obsolete project references", async () => {
    const { images, sprites } = fixture();
    await sprites.initialize();
    await sprites.command({ operation: "sync", projectId: "a", context: context("a", "old") });
    await sprites.command({
      operation: "sync",
      projectId: "a",
      context: { ...context("a", "new"), threadId: "replacement" },
    });
    expect((await sprites.forThread("thread-a"))?.context?.projectId).toBe("a");
    expect((await sprites.forThread("replacement"))?.context?.projectId).toBe("a");
    expect([...images.spriteAssetIds]).toEqual([]);
  });
});

it("persists per-turn editing snapshots and all conversation bindings across restart", async () => {
  const { sprites } = fixture();
  await sprites.initialize();
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: context("a"),
    threadIds: ["thread-a", "thread-b"],
  });
  expect((await sprites.forThread("thread-a", "turn-1"))?.context?.action).toBe("idle");
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: { ...context("a"), threadId: "thread-b", action: "walk", fps: 24 },
    threadIds: ["thread-a", "thread-b"],
  });
  expect((await sprites.forThread("thread-a", "turn-1"))?.context?.action).toBe("idle");
  expect((await sprites.forThread("thread-b", "turn-2"))?.context?.action).toBe("walk");
  const restored = fixture();
  await restored.sprites.initialize();
  expect((await restored.sprites.forThread("thread-a", "turn-1"))?.context).toMatchObject({
    action: "idle",
    fps: 12,
    threadId: "thread-a",
    referenceAssetId: null,
  });
  await restored.sprites.command({ operation: "delete", projectId: "a" });
  expect(await restored.sprites.forThread("thread-a")).toBeNull();
  expect(await restored.sprites.forThread("thread-b")).toBeNull();
});
it("requires confirmation and freezes the selected drawing settings across editor changes", async () => {
  const images = {
    spriteAssetIds: new Set<string>(),
    createJob: vi.fn(async (_input: unknown) => ({ id: "job" })),
    upload: vi.fn(async () => ({ id: "guide" })),
    cancelJob: vi.fn(),
    listProviders: async () => [{ id: "drawing", enabled: true, models: [{ id: "test" }] }],
  };
  const sprites = new SpriteEngine(
    root,
    images as unknown as ImageGenerationEngine,
    async () => {},
  );
  await sprites.initialize();
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: context("a"),
    threadIds: ["thread-a", "thread-b"],
  });
  const state = await sprites.command({
    operation: "generate",
    projectId: "a",
    context: context("a"),
    input: { kind: "character", requestId: "request", prompt: "fox" },
  });
  expect(images.createJob).not.toHaveBeenCalled();
  const plan = state.plans![0]!;
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: { ...context("a"), threadId: "thread-b", model: "changed", background: "transparent" },
    threadIds: ["thread-a", "thread-b"],
  });
  const confirmed = await sprites.confirm({
    projectId: "a",
    planId: plan.id,
    threadId: "thread-a",
    version: plan.version,
  });
  expect(confirmed.runs[0]!.context).toMatchObject({
    threadId: "thread-a",
    model: "test",
    background: "chroma",
  });
  expect(images.createJob.mock.calls[0]?.[0]).toMatchObject({
    model: "test",
    parameters: { background: "opaque" },
  });
  await sprites.command({ operation: "retry", projectId: "a", runId: confirmed.runs[0]!.id });
  expect(images.createJob).toHaveBeenCalledTimes(1);
});

it("keeps repeated request ids independent between conversations and deduplicates within each", async () => {
  const images = {
    spriteAssetIds: new Set<string>(),
    createJob: vi.fn(async (_input: unknown) => ({ id: "job" })),
  };
  const sprites = new SpriteEngine(
    root,
    images as unknown as ImageGenerationEngine,
    async () => {},
  );
  await sprites.initialize();
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: context("a"),
    threadIds: ["thread-a", "thread-b"],
  });
  for (const threadId of ["thread-a", "thread-b", "thread-a"])
    await sprites.command({
      operation: "generate",
      projectId: "a",
      context: { ...context("a"), threadId, referenceAssetId: null },
      input: { kind: "character", requestId: "same-id", prompt: "fox" },
    });
  expect(images.createJob).not.toHaveBeenCalled();
  const plans = (await sprites.command({ operation: "get", projectId: "a" })).plans!;
  expect(plans).toHaveLength(2);
  expect(plans.map((p) => p.threadId)).toEqual(["thread-a", "thread-b"]);
});

it("detaches a deleted conversation, cancels only its active jobs and preserves completed shared artwork", async () => {
  const { images, sprites } = fixture();
  const c = context("a");
  const asset = {
    id: "shared-image",
    name: "fox.png",
    mimeType: "image/png",
    url: "/image",
    thumbnailUrl: "/thumb",
    width: 16,
    height: 16,
    bytes: 1,
    createdAt: new Date().toISOString(),
  };
  const run = {
    id: "own",
    context: c,
    input: { kind: "character", requestId: "r", prompt: "fox" },
    jobId: "own-job",
    status: "running",
    source: null,
    frames: [],
    warnings: [],
    error: null,
    createdAt: asset.createdAt,
  };
  await writeFile(
    path.join(root, "a.json"),
    JSON.stringify({
      context: c,
      threadIds: ["thread-a", "thread-b"],
      runs: [
        run,
        { ...run, id: "other", context: { ...c, threadId: "thread-b" }, jobId: "other-job" },
        { ...run, id: "completed", status: "ready", source: asset, frames: [asset] },
      ],
    }),
  );
  await sprites.initialize();
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: c,
    threadIds: ["thread-a", "thread-b"],
  });
  await sprites.detachThread("thread-a");
  expect(images.cancelJob).toHaveBeenCalledExactlyOnceWith("own-job");
  expect(await sprites.forThread("thread-a")).toBeNull();
  expect((await sprites.forThread("thread-b"))?.runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "own", status: "cancelled" }),
      expect.objectContaining({ id: "other", status: "running" }),
      expect.objectContaining({ id: "completed", frames: [asset] }),
    ]),
  );
  expect(images.spriteAssetIds.has("shared-image")).toBe(true);
  // Stale sync must not restore the deleted binding.
  await sprites.command({
    operation: "sync",
    projectId: "a",
    context: c,
    threadIds: ["thread-a", "thread-b"],
  });
  expect(await sprites.forThread("thread-a")).toBeNull();
  await expect(
    sprites.command({ operation: "retry", projectId: "a", runId: "completed" }),
  ).rejects.toThrow("deleted");
  const restarted = fixture();
  await restarted.sprites.initialize();
  expect(await restarted.sprites.forThread("thread-a")).toBeNull();
  expect(restarted.images.spriteAssetIds.has("shared-image")).toBe(true);
});

it("persists conversation removal intent before cancellation and recovers a partial failure", async () => {
  const c = context("a");
  await writeFile(
    path.join(root, "a.json"),
    JSON.stringify({
      context: c,
      threadIds: ["thread-a"],
      runs: [
        {
          id: "run",
          context: c,
          input: { kind: "character", requestId: "r", prompt: "fox" },
          jobId: "job",
          status: "running",
          source: null,
          frames: [],
          warnings: [],
          error: null,
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const { sprites, images } = fixture();
  await sprites.initialize();
  images.cancelJob.mockRejectedValueOnce(new Error("cancel unavailable"));
  await expect(sprites.detachThread("thread-a")).rejects.toThrow("cancel unavailable");
  expect(await sprites.forThread("thread-a")).toBeNull();
  const restarted = fixture();
  await restarted.sprites.initialize();
  expect(restarted.images.cancelJob).toHaveBeenCalledWith("job");
  expect(JSON.parse(await readFile(path.join(root, "a.json"), "utf8"))).toMatchObject({
    threadIds: [],
    runs: [{ status: "cancelled" }],
  });
  await restarted.sprites.detachThread("thread-a");
});
