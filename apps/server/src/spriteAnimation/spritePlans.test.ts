import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Effect } from "effect";
import {
  spritePlanLayout,
  spritePlanPrompt,
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
const context: SpriteContext = {
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
const config = (): SpritePlanConfiguration => ({
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
function fixture(bytes?: Uint8Array) {
  let uploads = 0;
  const jobs = new Map<string, { id: string; status: string; outputs: ImageAsset[] }>();
  const images = {
    spriteAssetIds: new Set<string>(),
    listProviders: vi.fn(async () => [
      { id: "provider", enabled: true, models: [{ id: "model" }] },
    ]),
    getAsset: vi.fn(async (id: string) => ({ ...asset, id })),
    upload: vi.fn(async (_bytes: Uint8Array, name: string) => ({
      ...asset,
      id: `upload-${++uploads}`,
      name,
    })),
    createJob: vi.fn(async (input: ImageJobCreateInput) => {
      const job = {
        id: `job-${jobs.size}`,
        status: "succeeded",
        outputs: [{ ...asset, id: "sheet" }],
      };
      jobs.set(input.clientRequestId, job);
      return job;
    }),
    getJob: vi.fn(async (id: string) => [...jobs.values()].find((j) => j.id === id)),
    repository: { getRequest: (id: string) => Effect.succeed(jobs.get(id) ?? null) },
    assets: { read: async () => bytes },
    cancelJob: vi.fn(async () => {}),
  };
  const engine = new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {});
  return { engine, images, jobs };
}
async function prepare(engine: SpriteEngine, c = config()) {
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
async function sheet(c = config(), odd = false) {
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
  it("submits one combined job only after confirmation, then slices 8/12/6 frames", async () => {
    const { engine, images } = fixture(await sheet());
    const plan = await prepare(engine);
    expect(images.createJob).not.toHaveBeenCalled();
    expect(spritePlanLayout(plan.configuration)).toMatchObject({
      rows: 3,
      columns: 12,
      frames: 26,
      empty: 10,
      jobs: 1,
    });
    await Promise.all([engine.confirm(confirmInput(plan)), engine.confirm(confirmInput(plan))]);
    expect(images.createJob).toHaveBeenCalledTimes(1);
    expect(images.createJob.mock.calls[0]![0]).toMatchObject({
      parameters: { n: 1, background: "transparent", outputFormat: "png" },
      inputAssetIds: ["character", "upload-1"],
    });
    expect(images.createJob.mock.calls[0]![0].prompt).toContain(
      "3 equal-height rows and 12 equal-width columns",
    );
    await engine.tick();
    const state = await engine.command({ operation: "get", projectId: "project" });
    expect(state.runs[0]!.actions!.map((a) => a.frames.length)).toEqual([8, 12, 6]);
    expect(state.runs[0]!.actions!.map((a) => [a.action.fps, a.action.loop])).toEqual([
      [12, true],
      [13, true],
      [14, false],
    ]);
    expect(state.runs[0]!.source?.id).toBe("sheet");
  });
  it("creates separate tasks with ordered, appropriately scoped references", async () => {
    const { engine, images } = fixture();
    const initial = config();
    const c: SpritePlanConfiguration = {
      ...initial,
      mode: "separate",
      references: [
        {
          ...initial.references[0]!,
          asset: { ...asset, id: "pose" },
          role: "pose",
          actionId: "action-1",
        },
        ...initial.references,
      ],
    };
    const plan = await prepare(engine, c);
    await engine.confirm(confirmInput(plan));
    expect(images.createJob).toHaveBeenCalledTimes(3);
    expect(images.createJob.mock.calls.map(([input]) => input.inputAssetIds.slice(0, -1))).toEqual([
      ["character"],
      ["pose", "character"],
      ["character"],
    ]);
    expect(images.createJob.mock.calls[1]![0].prompt).toContain('Row 1: action "walk"');
  });
  it("preserves completed actions when a separate task fails and clones only the requested action", async () => {
    const c: SpritePlanConfiguration = { ...config(), mode: "separate" };
    const { engine, images } = fixture(await sheet({ ...c, actions: [c.actions[0]!] }));
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
    const c = { ...config(), width: 4096, height: 4096 };
    const plan = await prepare(engine, c);
    await expect(engine.confirm(confirmInput(plan))).rejects.toThrow("64 megapixels");
    expect(images.createJob).not.toHaveBeenCalled();
    expect(spritePlanPrompt(config())).toContain("leave the remaining 6 cells completely empty");
  });
});
it("supports uneven image dimensions and ignores unexpected artwork in unused cells", async () => {
  const c = config();
  const bytes = await sheet(c, true);
  const result = await processSprite(bytes, context, c.actions);
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
  const dirty = await processSprite(polluted, context, c.actions);
  expect(dirty.actions[2]!.frames).toHaveLength(6);
  expect(dirty.actions[2]!.warnings.join(" ")).toContain("unused cell");
});

it("retains valid blank frames and warns when a transparent request returns opaque output", async () => {
  const c = { ...config(), actions: [config().actions[0]!] };
  const opaque = await sharp({ create: { width: 80, height: 10, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  const result = await processSprite(opaque, context, c.actions);
  expect(result.warnings.join(" ")).toContain("Expected transparency");
  const blank = await sharp({
    create: { width: 80, height: 10, channels: 4, background: "#00000000" },
  })
    .png()
    .toBuffer();
  const empty = await processSprite(blank, context, c.actions);
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
        configuration: { ...config(), width: 0 },
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
    expect(prompt).toContain("Requested whole image size:");
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
    const bytes = await sharp({
      create: {
        width: 192,
        height: 48,
        channels: 4,
        background: { r: 40, g: 80, b: 100, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const { engine, images, jobs } = fixture(bytes);
    const plan = await prepare(engine);
    const confirmed = await engine.confirm(confirmInput(plan));
    const job = [...jobs.values()][0]!;
    job.outputs.push({ ...asset, id: "second" });
    const state = await engine.command({ operation: "get", projectId: "project" });
    const run = state.runs[0]!;
    expect(run.candidates).toHaveLength(2);
    expect(run.candidates![0]!.frames).toHaveLength(26);
    expect(run.candidates![1]!.status).toBe("pending");
    expect(images.createJob).toHaveBeenCalledTimes(1);
    const selected = await engine.command({
      operation: "select-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: "second",
    });
    expect(selected.runs[0]!.source!.id).toBe("second");
    expect(selected.runs[0]!.candidates![1]!.frames).toHaveLength(26);
    expect(selected.runs[0]!.frames[0]!.id).not.toBe(run.frames[0]!.id);
    const removed = await engine.command({
      operation: "remove-run",
      projectId: "project",
      runIds: [run.id],
    });
    expect(removed.runs[0]!.removedAt).toBeTruthy();
    expect(images.spriteAssetIds.has("second")).toBe(true);
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
    const bytes = await sharp({
      create: {
        width: 192,
        height: 48,
        channels: 4,
        background: { r: 40, g: 80, b: 100, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const { engine, images, jobs } = fixture(bytes);
    const plan = await prepare(engine);
    await engine.confirm(confirmInput(plan));
    await engine.command({ operation: "get", projectId: "project" });
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = path.join(root, "project.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    delete saved.runs[0].candidates;
    delete saved.runs[0].selectedCandidateId;
    await writeFile(file, JSON.stringify(saved));
    [...jobs.values()][0]!.outputs.push({ ...asset, id: "recovered" });
    const restored = new SpriteEngine(
      root,
      images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restored.initialize();
    const state = await restored.command({ operation: "get", projectId: "project" });
    expect(state.runs[0]!.candidates?.map((c) => c.id)).toEqual(["sheet", "recovered"]);
    expect(state.runs[0]!.frames).toEqual(saved.runs[0].frames);
    expect(images.createJob).toHaveBeenCalledTimes(1);
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
  const bytes = await sharp({
    create: {
      width: 192,
      height: 48,
      channels: 4,
      background: { r: 20, g: 90, b: 150, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const { engine, images } = fixture(bytes);
  const plan = await prepare(engine);
  await engine.confirm(confirmInput(plan));
  const state = await engine.command({ operation: "get", projectId: "project" });
  const run = state.runs[0]!,
    candidate = run.candidates![0]!;
  const { spriteGridSlice } = await import("@synara/contracts");
  const correction = {
    ...spriteGridSlice(
      192,
      48,
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
  expect(preview.runs[0]!.candidates![0]!.frames).toHaveLength(6);
  expect(
    (await engine.command({ operation: "get", projectId: "project" })).runs[0]!.frames,
  ).toHaveLength(26);
  const saved = await engine.command({
    operation: "save-slicing",
    projectId: "project",
    runId: run.id,
    candidateId: candidate.id,
    version: candidate.version!,
    slice: correction,
  });
  const revised = saved.runs[0]!.candidates![0]!;
  expect(revised.frames).toHaveLength(6);
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
  expect(restored.runs[0]!.frames).toHaveLength(26);
  expect(images.createJob).toHaveBeenCalledTimes(1);
  const invalid = {
    ...correction,
    rows: [{ ...correction.rows[0]!, cells: [{ ...correction.rows[0]!.cells[0]!, x: 200 }] }],
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
  ).toHaveLength(26);
});

it("retries only failed tasks with the frozen inputs and deduplicates confirmations across restarts", async () => {
  const { engine, images, jobs } = fixture();
  const plan = await prepare(engine, { ...config(), mode: "separate" });
  await engine.confirm(confirmInput(plan));
  const originals = [...jobs.values()];
  originals[0]!.status = "failed";
  originals[0]!.outputs = [];
  originals[1]!.status = "queued";
  originals[2]!.status = "queued";
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
  expect(images.createJob).toHaveBeenCalledTimes(4);
  const after = images.createJob.mock.calls[3]![0];
  expect(after).toMatchObject({
    prompt: before.prompt,
    parameters: before.parameters,
    inputAssetIds: before.inputAssetIds,
  });
  expect(after.clientRequestId).not.toBe(before.clientRequestId);
  expect(retried.runs).toHaveLength(4);
  expect(retried.runs[3]!.retryOfRunId).toBe(first.id);
  const restored = new SpriteEngine(
    root,
    images as unknown as ImageGenerationEngine,
    async () => {},
  );
  await restored.initialize();
  await restored.retryConfirm(input);
  expect(images.createJob).toHaveBeenCalledTimes(4);
  await expect(restored.retryConfirm({ ...input, requestId: "second-click" })).rejects.toThrow(
    "already has a retry",
  );
  const retryJob = [...jobs.values()][3]!;
  retryJob.status = "failed";
  retryJob.outputs = [];
  await restored.tick();
  await restored.retryConfirm({
    ...input,
    runIds: [retried.runs[3]!.id],
    requestId: "next-attempt",
  });
  expect(images.createJob).toHaveBeenCalledTimes(5);
  await expect(
    restored.retryConfirm({ ...input, threadId: "other", requestId: "wrong-owner" }),
  ).rejects.toThrow("unavailable");
});

it("does not regenerate candidates or uncertain submissions", async () => {
  const { engine, images } = fixture(await sheet());
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
