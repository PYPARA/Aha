import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Effect } from "effect";
import {
  spritePlanLayout,
  spritePlanPrompt,
  spritePlanTasks,
  type ImageAsset,
  type SpriteContext,
  type SpritePlanConfiguration,
  type ImageJobCreateInput,
} from "@synara/contracts";
import { ImageApiError } from "../imageGeneration/imageApi";
import { SpriteEngine } from "./spriteEngine";
import { processSprite } from "./processSprite";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-plans-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const asset: ImageAsset = {
  id: "character",
  name: "fox.png",
  mimeType: "image/png",
  url: "/image",
  thumbnailUrl: "/thumb",
  width: 16,
  height: 16,
  bytes: 100,
  createdAt: "2026-10-14T00:00:00.000Z",
};
const renderSpec = {
  mode: "illustration" as const,
  logicalWidth: 16,
  logicalHeight: 16,
  outputScale: 1,
};
const canonical = {
  revision: "revision",
  source: asset,
  asset,
  renderSpec,
  registration: { scale: 1, offsetX: 0, offsetY: 0 },
  pivotX: 8,
  pivotY: 14,
  confirmedAt: asset.createdAt,
};
/** Retired sprite-sheet projects, still used to check slicing of imported sheets. */
const sheetContext: SpriteContext = {
  projectId: "project",
  threadId: "thread",
  name: "Fox",
  providerId: "provider",
  model: "model",
  referenceAssetId: null,
  action: "idle",
  fps: 12,
  frameCount: 8,
  width: 16,
  height: 16,
  background: "transparent",
  chromaKey: "#00ff00",
};
const context: SpriteContext = { ...sheetContext, workflowVersion: 2, renderSpec };
const sheetConfig = (): SpritePlanConfiguration => ({
  kind: "animation",
  mode: "combined",
  prompt: "A fox with consistent proportions",
  creative: {
    character: "A fox",
    style: "Pixel art",
    view: "Side view",
    sources: { character: "user", style: "user", view: "suggested" },
  },
  providerId: "provider",
  model: "model",
  width: 16,
  height: 16,
  background: "transparent",
  chromaKey: "#00ff00",
  parameters: { n: 1, size: "auto", quality: "auto", outputFormat: "png" },
  references: [{ referenceId: "attachment:fox", asset, role: "character", actionId: null }],
  actions: [8, 12, 6].map((frameCount, i) => ({
    id: `action-${i}`,
    name: ["idle", "walk", "jump"][i]!,
    description: "move smoothly",
    frameCount,
    fps: 12 + i,
    loop: i !== 2,
    enabled: true,
  })),
});
/** Three independent actions: idle 8, walk 12 and jump 6 frames. */
const threeActions = (): SpritePlanConfiguration => ({
  ...sheetConfig(),
  workflowVersion: 2,
  renderSpec,
  canonical,
  mode: "separate",
  references: [{ referenceId: "canonical:revision", asset, role: "character", actionId: null }],
});
/** One idle action, so lifecycle tests make a single paid request. */
const config = (): SpritePlanConfiguration => ({
  ...threeActions(),
  actions: [threeActions().actions[0]!],
});
/** A transparent GIF whose frames each hold a small moving square. */
async function gif(frames: number, width: number, height: number) {
  const pages = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp(
        Buffer.from(
          `<svg width="${width}" height="${height}"><rect x="${width * 0.3 + (i % 3)}" y="${height * 0.4}" width="${width * 0.3}" height="${height * 0.4}" fill="red"/></svg>`,
        ),
      )
        .png()
        .toBuffer(),
    ),
  );
  return sharp(pages, { join: { animated: true } })
    .gif({ delay: 80 })
    .toBuffer();
}
const gifAsset = (id: string, frames: number, width = 288, height = 288): ImageAsset => ({
  ...asset,
  id,
  name: `${id}.gif`,
  mimeType: "image/gif",
  width,
  height,
  animation: { frameCount: frames, durationMs: frames * 80 },
});
function fixture() {
  const jobs = new Map<string, { id: string; status: string; outputs: ImageAsset[] }>();
  const stored = new Map<string, Uint8Array>();
  const upload = async (bytes: Uint8Array, name: string) => {
    // Content-addressed like the real asset store, so re-expanding a GIF reuses its sheet.
    const id = `upload-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
    const metadata = await sharp(bytes).metadata();
    stored.set(id, bytes);
    return { ...asset, id, name, width: metadata.width!, height: metadata.height! };
  };
  const images = {
    spriteAssetIds: new Set<string>(),
    listProviders: vi.fn(async () => [
      { id: "provider", enabled: true, concurrency: 4, models: [{ id: "model" }] },
    ]),
    getAsset: vi.fn(async (id: string) => ({ ...asset, id })),
    upload: vi.fn(upload),
    createJob: vi.fn(async (input: ImageJobCreateInput) => {
      const size = /^(\d+)x(\d+)$/.exec(input.parameters.size ?? "");
      const job = {
        id: `job-${jobs.size}`,
        status: "succeeded",
        outputs: [
          gifAsset(
            `gif-${jobs.size}`,
            input.parameters.frameCount ?? 2,
            Number(size?.[1] ?? 288),
            Number(size?.[2] ?? 288),
          ),
        ],
      };
      jobs.set(input.clientRequestId, job);
      return job;
    }),
    getJob: vi.fn(async (id: string) => [...jobs.values()].find((j) => j.id === id)),
    repository: { getRequest: (id: string) => Effect.succeed(jobs.get(id) ?? null) },
    assets: {
      read: async (target: ImageAsset) => {
        if (!stored.has(target.id) && target.animation)
          stored.set(
            target.id,
            await gif(target.animation.frameCount, target.width, target.height),
          );
        return stored.get(target.id) ?? (await gif(2, 16, 16));
      },
    },
    cancelJob: vi.fn(async () => {}),
  };
  const engine = new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {});
  return { engine, images, jobs };
}
async function prepare(engine: SpriteEngine, c = config()) {
  // The project already has an approved character reference.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(root, "project.json"),
    JSON.stringify({
      context,
      runs: [],
      canonical,
      canonicalVersions: [canonical],
      threadIds: ["thread"],
    }),
  );
  await engine.initialize();
  await engine.command({ operation: "sync", projectId: "project", context });
  await engine.command(
    { operation: "capture-references", projectId: "project", context, references: c.references },
    true,
  );
  return (
    await engine.command({
      operation: "propose",
      projectId: "project",
      context,
      configuration: c,
      input: { requestId: "proposal", kind: "animation", prompt: c.prompt },
    })
  ).plans![0]!;
}
const confirmInput = (p: { id: string; version: number }) => ({
  projectId: "project",
  threadId: "thread",
  planId: p.id,
  version: p.version,
});
async function sheet(c = sheetConfig(), odd = false) {
  const l = spritePlanLayout(c),
    w = odd ? 125 : 120,
    h = odd ? 35 : 30;
  const rects = l.actions.flatMap((a, row) =>
    Array.from(
      { length: a.frameCount },
      (_, col) =>
        `<rect x="${Math.floor((col * w) / l.columns) + 2}" y="${Math.floor((row * h) / l.rows) + 2}" width="3" height="3" fill="${row === 0 ? "red" : row === 1 ? "blue" : "green"}"/>`,
    ),
  );
  return sharp(Buffer.from(`<svg width="${w}" height="${h}">${rects.join("")}</svg>`))
    .png()
    .toBuffer();
}
describe("confirmed sprite generation plans", () => {
  it("submits one GIF job per action only after confirmation, then slices 8/12/6 frames", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine, threeActions());
    expect(images.createJob).not.toHaveBeenCalled();
    expect(spritePlanLayout(plan.configuration)).toMatchObject({ rows: 1, frames: 26, jobs: 3 });
    await Promise.all([engine.confirm(confirmInput(plan)), engine.confirm(confirmInput(plan))]);
    // Different actions run at most two at a time.
    expect(images.createJob).toHaveBeenCalledTimes(2);
    expect(images.createJob.mock.calls[0]![0]).toMatchObject({
      parameters: {
        n: 1,
        background: "transparent",
        outputFormat: "gif",
        frameCount: 8,
        frameDurationMs: 80,
        size: "288x288",
      },
      inputAssetIds: ["character"],
    });
    expect(images.createJob.mock.calls[0]![0].prompt).toContain("Animate exactly 8 frames");
    await engine.tick();
    await engine.tick();
    expect(images.createJob).toHaveBeenCalledTimes(3);
    const state = await engine.command({ operation: "get", projectId: "project" });
    expect(state.runs.map((r) => r.actions![0]!.frames.length)).toEqual([8, 12, 6]);
    expect(state.runs.map((r) => [r.actions![0]!.action.fps, r.actions![0]!.action.loop])).toEqual([
      [12, true],
      [13, true],
      [14, false],
    ]);
    const candidate = state.runs[0]!.candidates![0]!;
    expect(candidate.animationSource?.id).toBe("gif-0");
    expect(state.runs[0]!.source?.id).toBe(candidate.source.id);
    expect(candidate.source).toMatchObject({ width: 288 * 8, height: 288 });
    expect(state.runs[0]!.configuration!.layout).toMatchObject({ columns: 8, rows: 1 });
    // Twelve frames wrap to two rows to stay within browser canvas limits.
    expect(state.runs[1]!.configuration!.layout).toMatchObject({ columns: 6, rows: 2 });
    expect(images.spriteAssetIds.has("gif-0")).toBe(true);
  });
  it("keeps extra GIF frames unassigned and blocks adoption when frames are missing", async () => {
    const { engine, jobs } = fixture();
    const plan = await prepare(engine, threeActions());
    await engine.confirm(confirmInput(plan));
    const [idle, walk] = [...jobs.values()];
    idle!.outputs = [gifAsset("gif-extra", 10)];
    walk!.outputs = [gifAsset("gif-short", 9)];
    await engine.tick();
    const state = await engine.command({ operation: "get", projectId: "project" });
    const [extra, short] = state.runs.map((r) => r.candidates?.[0]);
    expect(state.runs[0]!.configuration!.layout!.cells.map((c) => c.frameIndex)).toEqual([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      null,
      null,
    ]);
    expect(extra!.frames).toHaveLength(8);
    expect(extra!.issues!.map((i) => i.code)).toContain("gif-frame-count");
    expect(extra!.issues!.find((i) => i.code === "gif-frame-count")!.severity).toBe("warning");
    expect(short!.frames).toHaveLength(9);
    expect(short!.issues!.map((i) => i.code)).toEqual(
      expect.arrayContaining(["gif-frame-count", "missing-frames"]),
    );
    expect(short!.status).toBe("needs-adjustment");
  });
  it("creates GIF tasks with ordered, appropriately scoped references and no layout guide", async () => {
    const { engine, images } = fixture();
    const initial = threeActions();
    const c: SpritePlanConfiguration = {
      ...initial,
      references: [
        ...initial.references,
        {
          ...initial.references[0]!,
          referenceId: "attachment:pose",
          asset: { ...asset, id: "pose" },
          role: "pose",
          actionId: "action-1",
        },
      ],
    };
    const plan = await prepare(engine, c);
    await engine.confirm(confirmInput(plan));
    await engine.tick();
    expect(images.createJob).toHaveBeenCalledTimes(3);
    expect(images.createJob.mock.calls.map(([input]) => input.inputAssetIds)).toEqual([
      ["character"],
      ["character", "pose"],
      ["character"],
    ]);
    expect(images.upload.mock.calls.map(([, name]) => name)).not.toContain("sprite-layout.png");
    expect(images.createJob.mock.calls[1]![0].prompt).toContain('Action "walk"');
  });
  it("preserves completed actions when a separate task fails and clones only the requested action", async () => {
    const c = threeActions();
    const { engine, images } = fixture();
    const plan = await prepare(engine, c);
    images.createJob.mockRejectedValueOnce(
      new ImageApiError("provider_disabled", "Provider unavailable"),
    );
    await engine.confirm(confirmInput(plan));
    await engine.tick();
    const state = await engine.command({ operation: "get", projectId: "project" });
    expect(state.runs[0]!.status).toBe("failed");
    expect(state.runs[1]!.frames).toHaveLength(12);
    const clone = await engine.command({
      operation: "clone-plan",
      projectId: "project",
      planId: plan.id,
      actionId: "action-1",
    });
    expect(clone.plans!.at(-1)!.configuration.actions.map((a) => a.id)).toEqual(["action-1"]);
    expect(clone.plans!.at(-1)!.configuration.mode).toBe("separate");
    expect(images.createJob).toHaveBeenCalledTimes(3);
  });
  it("rejects stale confirmation, foreign references and unbound threads", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    await engine.command({
      operation: "update-plan",
      projectId: "project",
      planId: plan.id,
      version: 1,
      configuration: { ...config(), background: "chroma" },
    });
    await expect(engine.confirm(confirmInput(plan))).rejects.toThrow("Plan changed");
    await expect(
      engine.command({
        operation: "update-plan",
        projectId: "project",
        planId: plan.id,
        version: 2,
        configuration: {
          ...config(),
          references: [{ ...config().references[0]!, asset: { ...asset, id: "foreign" } }],
        },
      }),
    ).rejects.toThrow("does not belong");
    await expect(engine.confirm({ ...confirmInput(plan), threadId: "foreign" })).rejects.toThrow(
      "unavailable",
    );
    expect(images.createJob).not.toHaveBeenCalled();
  });
  it("keeps drafts across restart, invalidates them on deletion and clones retries without submitting", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    expect((await restored.forThread("thread"))?.plans?.[0]).toEqual(plan);
    const confirmed = await restored.confirm(confirmInput(plan));
    const retry = await restored.command({
      operation: "retry",
      projectId: "project",
      runId: confirmed.runs[0]!.id,
    });
    expect(retry.plans!.at(-1)!.status).toBe("draft");
    expect(images.createJob).toHaveBeenCalledTimes(1);
    await restored.detachThread("thread");
    await expect(restored.confirm(confirmInput(retry.plans!.at(-1)!))).rejects.toThrow(
      "unavailable",
    );
    expect(
      (await restored.command({ operation: "get", projectId: "project" })).plans!.at(-1)!.status,
    ).toBe("dismissed");
  });
  it("links an existing durable job after an interrupted local save without resubmitting", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    const confirmed = await engine.confirm(confirmInput(plan));
    const file = path.join(root, "project.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      file,
      JSON.stringify({
        ...confirmed,
        runs: confirmed.runs.map((r) => Object.assign({}, r, { jobId: null })),
      }),
    );
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    await restored.tick();
    expect((await restored.forThread("thread"))?.runs[0]?.jobId).toBe("job-0");
    expect(images.createJob).toHaveBeenCalledTimes(1);
  });
  it("prevents over-budget plans and exposes accurate compiled prompts", async () => {
    const { engine, images } = fixture();
    const large = { ...renderSpec, logicalWidth: 4096, logicalHeight: 4096 };
    await expect(
      prepare(engine, { ...config(), renderSpec: large, width: 4096, height: 4096 }),
    ).rejects.toThrow("GIF limits");
    expect(images.createJob).not.toHaveBeenCalled();
    expect(spritePlanPrompt(config())).toContain("Animate exactly 8 frames");
  });
});
it("supports uneven image dimensions and ignores unexpected artwork in unused cells", async () => {
  const c = sheetConfig();
  const bytes = await sheet(c, true);
  const result = await processSprite(bytes, sheetContext, c.actions);
  expect(result.actions.map((o) => o.frames.length)).toEqual([8, 12, 6]);
  const metadata = await sharp(result.frames[0]).metadata();
  expect([metadata.width, metadata.height]).toEqual([16, 16]);
  const polluted = await sharp(bytes)
    .composite([
      {
        input: await sharp({ create: { width: 3, height: 3, channels: 4, background: "red" } })
          .png()
          .toBuffer(),
        left: 117,
        top: 26,
      },
    ])
    .png()
    .toBuffer();
  const dirty = await processSprite(polluted, sheetContext, c.actions);
  expect(dirty.actions[2]!.frames).toHaveLength(6);
  expect(dirty.actions[2]!.warnings.join(" ")).toContain("unused cell");
});

it("retains valid blank frames and warns when a transparent request returns opaque output", async () => {
  const c = { ...sheetConfig(), actions: [sheetConfig().actions[0]!] };
  const opaque = await sharp({ create: { width: 80, height: 10, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  const result = await processSprite(opaque, sheetContext, c.actions);
  expect(result.warnings.join(" ")).toContain("Expected transparency");
  const blank = await sharp({
    create: { width: 80, height: 10, channels: 4, background: "#00000000" },
  })
    .png()
    .toBuffer();
  const empty = await processSprite(blank, sheetContext, c.actions);
  expect(empty.actions[0]!.frames).toHaveLength(8);
  expect(empty.actions[0]!.warnings.join(" ")).toContain("empty");
});

describe("conversation draft lifecycle", () => {
  it("reuses revisions on repeated and concurrent clicks, and replaces another draft atomically", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    const confirmed = await engine.confirm(confirmInput(plan));
    const input = {
      operation: "retry" as const,
      projectId: "project",
      runId: confirmed.runs[0]!.id,
      displayAfter: "2026-10-14T00:02:00.000Z",
    };
    const results = await Promise.all([
      engine.command(input),
      engine.command(input),
      engine.command(input),
    ]);
    expect(new Set(results.map((s) => s.resultPlanId)).size).toBe(1);
    const current = results[0]!.plans!.find((p) => p.id === results[0]!.resultPlanId)!;
    expect(current.displayAfter).toBe(input.displayAfter);
    expect(results.at(-1)!.plans!.filter((p) => p.status === "draft")).toHaveLength(1);
    await expect(
      engine.command({ operation: "clone-plan", projectId: "project", planId: plan.id }),
    ).rejects.toThrow("draft already exists");
    await expect(
      engine.command({
        operation: "clone-plan",
        projectId: "project",
        planId: plan.id,
        replacePlanId: current.id,
        version: current.version - 1,
      }),
    ).rejects.toThrow("draft already exists");
    await expect(
      engine.command({
        operation: "clone-plan",
        projectId: "project",
        planId: plan.id,
        replacePlanId: current.id,
        version: current.version,
        configuration: { ...config(), chromaKey: "green" },
      }),
    ).rejects.toThrow();
    expect(
      (await engine.command({ operation: "get", projectId: "project" })).plans!.find(
        (p) => p.id === current.id,
      )?.status,
    ).toBe("draft");
    const replaced = await engine.command({
      operation: "clone-plan",
      projectId: "project",
      planId: plan.id,
      replacePlanId: current.id,
      version: current.version,
    });
    expect(replaced.plans!.filter((p) => p.status === "draft")).toHaveLength(1);
    expect(replaced.plans!.find((p) => p.id === current.id)).toMatchObject({
      status: "dismissed",
      supersededBy: replaced.resultPlanId,
    });
    expect(images.createJob).toHaveBeenCalledTimes(1);
  });
  it("imports protected references without an implicit default and restores them", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    await expect(
      engine.command({
        operation: "import-references",
        projectId: "project",
        threadId: "other",
        references: config().references,
      }),
    ).rejects.toThrow("available conversation");
    await engine.command({
      operation: "import-references",
      projectId: "project",
      threadId: "thread",
      references: config().references,
    });
    await expect(
      engine.command({
        operation: "select-reference",
        projectId: "project",
        threadId: "thread",
        references: config().references,
      }),
    ).rejects.toThrow("generation plan");
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const state = await restored.forThread("thread");
    expect(state?.referencePool).toHaveLength(1);
    expect(state?.selectedReferences).toBeUndefined();
    expect(state?.plans?.[0]?.id).toBe(plan.id);
    expect(images.createJob).not.toHaveBeenCalled();
  });
  it("migrates old duplicate drafts without altering confirmed snapshots or deleting their text", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    await engine.confirm(confirmInput(plan));
    const { writeFile, readFile } = await import("node:fs/promises");
    const file = path.join(root, "project.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    const legacy = {
      ...plan,
      configuration: {
        ...config(),
        creative: undefined,
        prompt: "Pixel fox on a green background at 256x256",
      },
      status: "draft",
    };
    saved.plans.push(
      { ...legacy, id: "old", createdAt: "2026-10-14T00:01:00.000Z" },
      { ...legacy, id: "new", createdAt: "2026-10-14T00:02:00.000Z" },
    );
    await writeFile(file, JSON.stringify(saved));
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const state = await restored.forThread("thread");
    expect(state!.plans!.filter((p) => p.status === "draft").map((p) => p.id)).toEqual(["new"]);
    expect(state!.plans!.find((p) => p.id === "old")).toMatchObject({
      status: "dismissed",
      supersededBy: "new",
    });
    expect(state!.plans!.find((p) => p.id === "new")!.configuration).toMatchObject({
      prompt: expect.stringContaining("green background"),
    });
    expect(state!.plans!.find((p) => p.id === plan.id)!.configuration).toEqual(plan.configuration);
    await expect(
      restored.confirm(confirmInput(state!.plans!.find((p) => p.id === "new")!)),
    ).rejects.toThrow("Background conflicts");
  });
  it("compiles creative fields and prevents contradictory technical free text", async () => {
    const { engine, images } = fixture();
    const c = {
      ...config(),
      creative: { ...config().creative!, character: "A fox wearing a green coat" },
    };
    const plan = await prepare(engine, c);
    await engine.confirm(confirmInput(plan));
    const prompt = images.createJob.mock.calls[0]![0].prompt;
    expect(prompt).toContain("green coat");
    expect(prompt).toContain("Transparent background");
    expect(prompt).not.toContain("Output frame canvas");
    expect(prompt).toContain("animated GIF");
    const revision = await engine.command({
      operation: "clone-plan",
      projectId: "project",
      planId: plan.id,
    });
    const draft = revision.plans!.find((p) => p.id === revision.resultPlanId)!;
    const edited = await engine.command({
      operation: "update-plan",
      projectId: "project",
      planId: draft.id,
      version: draft.version,
      configuration: { ...c, prompt: "Use a green background" },
    });
    await expect(
      engine.confirm(confirmInput(edited.plans!.find((p) => p.id === draft.id)!)),
    ).rejects.toThrow("Background conflicts");
    expect(images.createJob).toHaveBeenCalledTimes(1);
  });
});

describe("candidate and task lifecycle", () => {
  it("retains all outputs, processes additional candidates on demand and soft removes without deleting jobs", async () => {
    const { engine, images, jobs } = fixture();
    const plan = await prepare(engine);
    const confirmed = await engine.confirm(confirmInput(plan));
    const job = [...jobs.values()][0]!;
    job.outputs.push(gifAsset("second", 8, 320, 320));
    const state = await engine.command({ operation: "get", projectId: "project" });
    const run = state.runs[0]!;
    expect(run.candidates).toHaveLength(2);
    expect(run.candidates![0]!.frames).toHaveLength(8);
    expect(run.candidates![1]).toMatchObject({
      id: "second",
      status: "pending",
      animationSource: { id: "second" },
    });
    expect(images.createJob).toHaveBeenCalledTimes(1);
    const second = run.candidates![1]!;
    const selected = await engine.command({
      operation: "select-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: second.id,
    });
    expect(selected.runs[0]!.source!.id).toBe(second.source.id);
    expect(selected.runs[0]!.candidates![1]!.frames).toHaveLength(8);
    expect(selected.runs[0]!.candidates![1]!.animationSource!.id).toBe("second");
    expect(selected.runs[0]!.frames[0]!.id).not.toBe(run.frames[0]!.id);
    const removed = await engine.command({
      operation: "remove-run",
      projectId: "project",
      runIds: [run.id],
    });
    expect(removed.runs[0]!.removedAt).toBeTruthy();
    expect(images.spriteAssetIds.has("second")).toBe(true);
    expect(images.spriteAssetIds.has(second.source.id)).toBe(true);
    expect(images.cancelJob).not.toHaveBeenCalled();
    const restored = await engine.command({
      operation: "restore-run",
      projectId: "project",
      runIds: [run.id],
    });
    expect(restored.runs[0]!.removedAt).toBeNull();
    expect(restored.runs[0]!.jobId).toBe(confirmed.runs[0]!.jobId);
    expect(images.createJob).toHaveBeenCalledTimes(1);
  });
  it("recovers missing extra outputs for historical completed runs without regenerating", async () => {
    const { engine, images, jobs } = fixture();
    const plan = await prepare(engine);
    await engine.confirm(confirmInput(plan));
    await engine.command({ operation: "get", projectId: "project" });
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = path.join(root, "project.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    delete saved.runs[0].candidates;
    delete saved.runs[0].selectedCandidateId;
    await writeFile(file, JSON.stringify(saved));
    [...jobs.values()][0]!.outputs.push(gifAsset("recovered", 8, 320, 320));
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const state = await restored.command({ operation: "get", projectId: "project" });
    const candidates = state.runs[0]!.candidates!;
    expect(candidates.map((c) => c.animationSource?.id)).toEqual(["gif-0", "recovered"]);
    expect(candidates[0]!.source.id).toBe(saved.runs[0].source.id);
    expect(state.runs[0]!.frames).toEqual(saved.runs[0].frames);
    expect(images.createJob).toHaveBeenCalledTimes(1);
  });
  it("marks new plans as GIF and re-derives whole-sheet sizes of older drafts", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    expect(plan.configuration.generation).toEqual({ version: 1 });
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = path.join(root, "project.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    const old = saved.plans[0].configuration;
    delete old.generation;
    Object.assign(old, {
      sizing: {
        version: 1,
        mode: "manual",
        sourceScale: 1,
        arrangement: "auto",
        margin: 0,
        gap: 0,
      },
      sizeSource: "user",
      parameters: { ...old.parameters, size: "1152x576" },
    });
    await writeFile(file, JSON.stringify(saved));
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const draft = (await restored.forThread("thread"))!.plans![0]!;
    const updated = await restored.command({
      operation: "update-plan",
      projectId: "project",
      planId: draft.id,
      version: draft.version,
      configuration: draft.configuration,
    });
    const c = updated.plans![0]!.configuration;
    expect(c).toMatchObject({ generation: { version: 1 }, sizing: { mode: "linked" } });
    expect(spritePlanTasks(c)[0]!.parameters.size).toBe("288x288");
    const manual = await restored.command({
      operation: "update-plan",
      projectId: "project",
      planId: draft.id,
      version: updated.plans![0]!.version,
      configuration: {
        ...c,
        sizing: { ...c.sizing!, mode: "manual" },
        sizeSource: "user",
        parameters: { ...c.parameters, size: "320x320" },
      },
    });
    expect(spritePlanTasks(manual.plans![0]!.configuration)[0]!.parameters.size).toBe("320x320");
  });
  it("restores previously blank migrated drafts while preserving parameters and references", async () => {
    const { engine, images } = fixture();
    const plan = await prepare(engine);
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = path.join(root, "project.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    Object.assign(saved.plans[0].configuration, {
      prompt: "",
      legacyPrompt: "A fox in a blue coat",
      needsReview: true,
      width: 128,
      creative: { character: "", style: "", view: "", sources: {} },
    });
    await writeFile(file, JSON.stringify(saved));
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const state = await restored.forThread("thread");
    expect(state?.plans?.[0]?.configuration).toMatchObject({
      prompt: "A fox in a blue coat",
      width: 128,
      references: plan.configuration.references,
    });
    expect(state?.plans?.[0]?.configuration.needsReview).toBeUndefined();
    expect(images.createJob).not.toHaveBeenCalled();
  });
});

it("saves corrected candidate versions atomically, rejects stale edits and restores without submitting images", async () => {
  const { engine, images } = fixture();
  const plan = await prepare(engine);
  await engine.confirm(confirmInput(plan));
  const state = await engine.command({ operation: "get", projectId: "project" });
  const run = state.runs[0]!,
    candidate = run.candidates![0]!;
  const { spriteGridSlice } = await import("@synara/contracts");
  const correction = {
    ...spriteGridSlice(
      candidate.source.width,
      candidate.source.height,
      config().actions.map((a) => Object.assign({}, a, { frameCount: 2 })),
    ),
    reviewedActionIds: config().actions.map((a) => a.id),
  };
  const preview = await engine.command({
    operation: "preview-slicing",
    projectId: "project",
    runId: run.id,
    candidateId: candidate.id,
    version: candidate.version!,
    slice: correction,
  });
  expect(preview.runs[0]!.candidates![0]!.frames).toHaveLength(2);
  expect(
    (await engine.command({ operation: "get", projectId: "project" })).runs[0]!.frames,
  ).toHaveLength(8);
  const saved = await engine.command({
    operation: "save-slicing",
    projectId: "project",
    runId: run.id,
    candidateId: candidate.id,
    version: candidate.version!,
    slice: correction,
  });
  const revised = saved.runs[0]!.candidates![0]!;
  expect(revised.frames).toHaveLength(2);
  expect(revised.status).toBe("needs-adjustment");
  expect(revised.slice!.reviewedActionIds).toEqual([]);
  await expect(
    engine.command({
      operation: "review-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: revised.version ?? 0,
      processingVersionId: revised.processingVersionId,
      analysisRevision: revised.analysisRevision ?? 0,
      actionId: revised.actions[0]!.action.id,
    }),
  ).rejects.toThrow("structural frame errors");
  const checked = await engine.command({ operation: "get", projectId: "project" });
  expect(checked.runs[0]!.candidates![0]!.reviews ?? []).toEqual([]);
  expect(saved.plans![0]!.configuration).toEqual(plan.configuration);
  await expect(
    engine.command({
      operation: "save-slicing",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version!,
      slice: correction,
    }),
  ).rejects.toThrow("Candidate changed");
  const restored = await engine.command({
    operation: "restore-slicing",
    projectId: "project",
    runId: run.id,
    candidateId: candidate.id,
    version: revised.version!,
    processingVersionId: candidate.processingVersionId!,
  });
  expect(restored.runs[0]!.frames).toHaveLength(8);
  expect(images.createJob).toHaveBeenCalledTimes(1);
  const invalid = {
    ...correction,
    rows: [
      {
        ...correction.rows[0]!,
        cells: [{ ...correction.rows[0]!.cells[0]!, x: candidate.source.width + 10 }],
      },
    ],
  };
  await expect(
    engine.command({
      operation: "save-slicing",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: restored.runs[0]!.candidates![0]!.version!,
      slice: invalid,
    }),
  ).rejects.toThrow("outside");
  expect(
    (await engine.command({ operation: "get", projectId: "project" })).runs[0]!.frames,
  ).toHaveLength(8);
});

it("retries only failed tasks with the frozen inputs and deduplicates confirmations across restarts", async () => {
  const { engine, images, jobs } = fixture();
  const plan = await prepare(engine);
  await engine.confirm(confirmInput(plan));
  const originals = [...jobs.values()];
  originals[0]!.status = "failed";
  originals[0]!.outputs = [];
  await engine.tick();
  const state = await engine.command({ operation: "get", projectId: "project" });
  const first = state.runs[0]!;
  const input = {
    projectId: "project",
    threadId: "thread",
    runIds: [first.id],
    requestId: "retry-click",
  };
  const before = images.createJob.mock.calls[0]![0];
  const [retried] = await Promise.all([engine.retryConfirm(input), engine.retryConfirm(input)]);
  expect(images.createJob).toHaveBeenCalledTimes(2);
  const after = images.createJob.mock.calls[1]![0];
  expect(after).toMatchObject({
    prompt: before.prompt,
    parameters: before.parameters,
    inputAssetIds: before.inputAssetIds,
  });
  expect(after.clientRequestId).not.toBe(before.clientRequestId);
  expect(retried.runs).toHaveLength(2);
  expect(retried.runs[1]!.retryOfRunId).toBe(first.id);
  const restored = new SpriteEngine(
    root,
    images as unknown as ImageGenerationEngine,
    async () => {},
  );
  await restored.initialize();
  await restored.retryConfirm(input);
  expect(images.createJob).toHaveBeenCalledTimes(2);
  await expect(restored.retryConfirm({ ...input, requestId: "second-click" })).rejects.toThrow(
    "already has a retry",
  );
  const retryJob = [...jobs.values()][1]!;
  retryJob.status = "failed";
  retryJob.outputs = [];
  await restored.tick();
  await restored.retryConfirm({
    ...input,
    runIds: [retried.runs[1]!.id],
    requestId: "next-attempt",
  });
  expect(images.createJob).toHaveBeenCalledTimes(3);
  await expect(
    restored.retryConfirm({ ...input, threadId: "other", requestId: "wrong-owner" }),
  ).rejects.toThrow("unavailable");
});

it("does not regenerate candidates or uncertain submissions", async () => {
  const { engine, images } = fixture();
  const plan = await prepare(engine);
  await engine.confirm(confirmInput(plan));
  await engine.tick();
  const state = await engine.command({ operation: "get", projectId: "project" });
  await expect(
    engine.retryConfirm({
      projectId: "project",
      threadId: "thread",
      runIds: [state.runs[0]!.id],
      requestId: "no-paid-reprocess",
    }),
  ).rejects.toThrow("Images already exist");
  expect(images.createJob).toHaveBeenCalledTimes(1);
});

it("blocks uncertain submissions instead of issuing another request", async () => {
  const { engine, images } = fixture();
  const plan = await prepare(engine);
  images.createJob.mockRejectedValueOnce(new Error("Disconnected while submitting"));
  const interrupted = await engine.confirm(confirmInput(plan));
  expect(interrupted.runs[0]!).toMatchObject({
    status: "interrupted",
    submissionPhase: "uncertain",
  });
  await expect(
    engine.retryConfirm({
      projectId: "project",
      threadId: "thread",
      runIds: [interrupted.runs[0]!.id],
      requestId: "uncertain",
    }),
  ).rejects.toThrow("verified");
  expect(images.createJob).toHaveBeenCalledTimes(1);
});
