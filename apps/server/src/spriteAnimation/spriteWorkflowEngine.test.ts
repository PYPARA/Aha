import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import sharp from "sharp";
import {
  DEFAULT_SPRITE_RENDER_SPEC,
  NEW_SPRITE_RENDER_SPEC,
  spriteOutputSize,
  type SpriteRenderSpec,
  spritePlanTasks,
  type SpriteContext,
  type SpritePlanConfiguration,
  type ImageAsset,
  type ImageJobCreateInput,
} from "@synara/contracts";
import { SpriteEngine } from "./spriteEngine";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context: SpriteContext = {
  workflowVersion: 2,
  renderSpec: DEFAULT_SPRITE_RENDER_SPEC,
  projectId: "project",
  threadId: "thread",
  name: "Fox",
  providerId: "provider",
  model: "model",
  referenceAssetId: null,
  action: "jump",
  frameCount: 9,
  fps: 24,
  loop: false,
  width: 256,
  height: 256,
  background: "transparent",
  chromaKey: "#00ff00",
};
async function fixture(spec: SpriteRenderSpec = DEFAULT_SPRITE_RENDER_SPEC, sourceEdge = 64) {
  const activeContext = { ...context, renderSpec: spec, ...spriteOutputSize(spec) };
  const root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-workflow-"));
  roots.push(root);
  const assets = new Map<string, { asset: ImageAsset; bytes: Uint8Array }>(),
    jobs = new Map<string, { id: string; status: string; outputs: ImageAsset[] }>();
  let nextId = 0,
    layouts: SpritePlanConfiguration[] = [],
    failRead = false,
    crash = false;
  const upload = async (bytes: Uint8Array, name: string) => {
    const metadata = await sharp(bytes).metadata(),
      id = `asset-${nextId++}`;
    const asset: ImageAsset = {
      id,
      name,
      mimeType: "image/png",
      url: `/${id}`,
      thumbnailUrl: `/${id}`,
      width: metadata.width!,
      height: metadata.height!,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    assets.set(id, { asset, bytes });
    return asset;
  };
  const images = {
    spriteAssetIds: new Set<string>(),
    upload: vi.fn(upload),
    getAsset: async (id: string) => assets.get(id)!.asset,
    assets: {
      read: async (asset: ImageAsset) => {
        if (failRead && asset.name.startsWith("sheet")) throw new Error("Invalid source image.");
        return assets.get(asset.id)!.bytes;
      },
    },
    listProviders: async () => [
      { id: "provider", enabled: true, concurrency: 2, models: [{ id: "model" }] },
    ],
    cancelJob: vi.fn(),
    repository: { getRequest: (key: string) => Effect.succeed(jobs.get(key) ?? null) },
    getJob: async (id: string) => [...jobs.values()].find((job) => job.id === id)!,
    createJob: vi.fn(async (input: ImageJobCreateInput) => {
      const config = layouts.find(
        (task) =>
          input.prompt.includes(`Action "${task.actions[0]!.name}"`) &&
          input.prompt.includes(
            `global frames ${task.segment!.frameStart + 1}–${task.segment!.frameStart + task.segment!.frameCount}`,
          ),
      )!;
      const layout = config.layout!;
      const rects = layout.cells
        .filter((c) => c.actionId)
        .map(
          (c, i) =>
            `<rect x="${c.x + c.width * 0.3}" y="${c.y + c.height * (i % 2 ? 0.3 : 0.5)}" width="${c.width * 0.3}" height="${c.height * 0.3}" fill="red"/>`,
        )
        .join("");
      const output = await upload(
        await sharp(
          Buffer.from(`<svg width="${layout.width}" height="${layout.height}">${rects}</svg>`),
        )
          .png()
          .toBuffer(),
        `sheet-${jobs.size}.png`,
      );
      const job = { id: `job-${jobs.size}`, status: "running", outputs: [output] };
      jobs.set(input.clientRequestId, job);
      return job;
    }),
  };
  const engine = new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {
    if (crash) {
      crash = false;
      throw new Error("simulated interruption after durable save");
    }
  });
  await engine.initialize();
  await engine.command({ operation: "sync", projectId: "project", context: activeContext });
  const source = await upload(
    await sharp(
      Buffer.from(
        `<svg width="${sourceEdge}" height="${sourceEdge}" viewBox="0 0 64 64"><rect x="20" y="12" width="24" height="40" fill="red"/></svg>`,
      ),
    )
      .png()
      .toBuffer(),
    "reference.png",
  );
  const canonical = await engine.command({
    operation: "confirm-character",
    projectId: "project",
    context: activeContext,
    renderSpec: spec,
    references: [
      { referenceId: `project:${source.id}`, asset: source, role: "character", actionId: null },
    ],
  });
  async function propose(frames = 9, secondAction = false) {
    const configuration: SpritePlanConfiguration = {
      workflowVersion: 2,
      renderSpec: spec,
      canonical: canonical.canonical,
      kind: "animation",
      mode: "combined",
      prompt: "A red fox jumping",
      providerId: "provider",
      model: "model",
      width: 256,
      height: 256,
      background: "transparent",
      chromaKey: "#00ff00",
      parameters: { n: 1, size: "auto", outputFormat: "png" },
      references: [],
      actions: [
        {
          id: "jump",
          name: "jump",
          description: "jump and land",
          enabled: true,
          frameCount: frames,
          fps: 24,
          loop: false,
        },
        ...(secondAction
          ? [
              {
                id: "idle",
                name: "idle",
                description: "breathe",
                enabled: true,
                frameCount: 8,
                fps: 12,
                loop: true,
              },
            ]
          : []),
      ],
    };
    const state = await engine.command({
      operation: "propose",
      projectId: "project",
      context: activeContext,
      configuration,
      input: { kind: "animation", prompt: configuration.prompt, requestId: `proposal-${nextId++}` },
    });
    const plan = state.plans!.find((p) => p.id === state.resultPlanId)!;
    layouts = spritePlanTasks(plan.configuration);
    return plan;
  }
  const confirm = (plan: { id: string; version: number }) =>
    engine.confirm({
      projectId: "project",
      threadId: "thread",
      planId: plan.id,
      version: plan.version,
    });
  const finish = () => {
    for (const job of jobs.values()) job.status = "succeeded";
  };
  return {
    engine,
    images,
    root,
    assets,
    jobs,
    propose,
    confirm,
    finish,
    setFailRead: (value: boolean) => {
      failRead = value;
    },
    setCrash: () => {
      crash = true;
    },
  };
}
describe("staged sprite engine", () => {
  it("uses the high-resolution appearance reference while output frames remain 256 pixels", async () => {
    const f = await fixture(NEW_SPRITE_RENDER_SPEC, 1024);
    const state = await f.engine.command({ operation: "get", projectId: "project" });
    expect(state.canonical!.source.width).toBe(1024);
    expect(state.canonical!.asset.width).toBe(256);
    expect(state.canonical!.generationReference!.width).toBe(1024);
    const plan = await f.propose(8);
    expect(plan.configuration.references[0]!.asset.id).toBe(
      state.canonical!.generationReference!.id,
    );
    expect(spritePlanTasks(plan.configuration)).toHaveLength(1);
    await f.confirm(plan);
    const request = f.images.createJob.mock.calls[0]![0];
    expect(request.inputAssetIds[0]).toBe(state.canonical!.generationReference!.id);
    expect(request.parameters.size).toBe("1024x512");
    f.finish();
    await f.engine.tick();
    const finished = await f.engine.command({ operation: "get", projectId: "project" });
    expect(finished.runs[0]!.frames).toHaveLength(8);
    expect(
      finished.runs[0]!.frames.every((frame) => frame.width === 256 && frame.height === 256),
    ).toBe(true);
    expect(f.images.spriteAssetIds.has(state.canonical!.generationReference!.id)).toBe(true);
  });
  it("keeps independent action drafts through repeated openings, conversations and restarts", async () => {
    const f = await fixture();
    const first = await f.propose(8);
    const otherConfig = {
      ...first.configuration,
      actions: first.configuration.actions.map((a) => ({ ...a, id: "walk", name: "walk" })),
    };
    const other = await f.engine.command({
      operation: "propose",
      projectId: "project",
      configuration: otherConfig,
      input: { kind: "animation", prompt: "walk", requestId: "walk-draft" },
    });
    expect(other.plans!.filter((p) => p.status === "draft")).toHaveLength(2);
    const duplicate = await f.propose(8);
    expect(duplicate.id).toBe(first.id);
    const restarted = new SpriteEngine(
      f.root,
      f.images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await restarted.initialize();
    expect(
      (await restarted.command({ operation: "get", projectId: "project" })).plans!.filter(
        (p) => p.status === "draft",
      ),
    ).toHaveLength(2);
    expect(f.images.createJob).not.toHaveBeenCalled();
  });
  it("versions character approval and invalidates unsubmitted plans while preserving its sources", async () => {
    const f = await fixture(),
      plan = await f.propose(8);
    const before = await f.engine.command({ operation: "get", projectId: "project" });
    const canonical = before.canonical!;
    const next = await f.engine.command({
      operation: "confirm-character",
      projectId: "project",
      context,
      renderSpec: DEFAULT_SPRITE_RENDER_SPEC,
      registration: { scale: 1, offsetX: 1, offsetY: 0 },
      references: [
        {
          referenceId: `project:${canonical.source.id}`,
          asset: canonical.source,
          role: "character",
          actionId: null,
        },
      ],
    });
    expect(next.canonical!.revision).not.toBe(canonical.revision);
    expect(next.canonicalVersions?.map((v) => v.revision)).toEqual([
      canonical.revision,
      next.canonical!.revision,
    ]);
    expect(next.plans!.find((p) => p.id === plan.id)!.status).toBe("dismissed");
    expect(f.images.spriteAssetIds.has(canonical.asset.id)).toBe(true);
    await expect(f.confirm(plan)).rejects.toThrow();
    expect(f.images.createJob).not.toHaveBeenCalled();
  });
  it("locks the reference, starts independent actions together, and waits for segment dependencies", async () => {
    const f = await fixture(),
      plan = await f.propose(9, true);
    expect(f.images.createJob).not.toHaveBeenCalled();
    await Promise.all([f.confirm(plan), f.confirm(plan)]);
    expect(f.images.createJob).toHaveBeenCalledTimes(2);
    let state = await f.engine.command({ operation: "get", projectId: "project" });
    expect(state.runs.map((r) => r.status)).toEqual(["running", "queued", "running"]);
    f.finish();
    await f.engine.tick();
    expect(f.images.createJob).toHaveBeenCalledTimes(3);
    const second = f.images.createJob.mock.calls[2]![0];
    state = await f.engine.command({ operation: "get", projectId: "project" });
    expect(second.inputAssetIds[0]).toBe(state.canonical!.asset.id);
    expect(second.inputAssetIds.slice(1, 3)).toEqual(
      state.runs[0]!.frames.slice(-2).map((a) => a.id),
    );
    f.finish();
    await f.engine.tick();
    state = await f.engine.command({ operation: "get", projectId: "project" });
    expect(
      state.runs.filter((r) => r.context.action === "jump").flatMap((r) => r.frames),
    ).toHaveLength(9);
    expect(state.runs[1]!.actions![0]!.action).toMatchObject({ fps: 24, loop: false });
  });
  it("keeps paid source images after processing failure and reprocesses without a new image job", async () => {
    const f = await fixture(),
      plan = await f.propose(8);
    await f.confirm(plan);
    f.setFailRead(true);
    f.finish();
    await f.engine.tick();
    let state = await f.engine.command({ operation: "get", projectId: "project" });
    const run = state.runs[0]!,
      candidate = run.candidates![0]!;
    expect(candidate.status).toBe("failed");
    expect(candidate.source).toBeTruthy();
    f.setFailRead(false);
    state = await f.engine.command({
      operation: "reprocess-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version ?? 0,
    });
    expect(state.runs[0]!.frames).toHaveLength(8);
    expect(f.images.createJob).toHaveBeenCalledTimes(1);
    const version = state.runs[0]!.candidates![0]!.version;
    state = await f.engine.command({
      operation: "analyze-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version,
    });
    expect(state.runs[0]!.candidates![0]!.version).toBe(version);
    expect(state.runs[0]!.candidates![0]!.analysisRevision).toBe(1);
  });
  it("resumes authorized prepared tasks after a crash before submission", async () => {
    const f = await fixture(),
      plan = await f.propose(8);
    f.setCrash();
    await expect(f.confirm(plan)).rejects.toThrow("simulated interruption");
    expect(f.images.createJob).not.toHaveBeenCalled();
    const resumed = new SpriteEngine(
      f.root,
      f.images as unknown as ImageGenerationEngine,
      async () => {},
    );
    await resumed.initialize();
    await resumed.tick();
    expect(f.images.createJob).toHaveBeenCalledTimes(1);
    await resumed.tick();
    expect(f.images.createJob).toHaveBeenCalledTimes(1);
  });
  it("records a review without regenerating or processing frames and rejects stale reviews", async () => {
    const f = await fixture(),
      plan = await f.propose(8);
    await f.confirm(plan);
    f.finish();
    await f.engine.tick();
    const state = await f.engine.command({ operation: "get", projectId: "project" });
    const run = state.runs[0]!,
      candidate = run.candidates![0]!;
    const uploads = f.images.upload.mock.calls.length,
      jobs = f.images.createJob.mock.calls.length;
    const command = {
      operation: "review-candidate" as const,
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version ?? 0,
      processingVersionId: candidate.processingVersionId,
      analysisRevision: candidate.analysisRevision ?? 0,
      actionId: "jump",
    };
    const reviewed = await f.engine.command(command),
      record = reviewed.runs[0]!.candidates![0]!;
    expect(record.reviews).toEqual([
      expect.objectContaining({
        actionId: "jump",
        processingVersionId: candidate.processingVersionId,
        analysisRevision: 0,
      }),
    ]);
    expect(record.frames).toEqual(candidate.frames);
    expect(record.processingVersionId).toBe(candidate.processingVersionId);
    expect(f.images.upload).toHaveBeenCalledTimes(uploads);
    expect(f.images.createJob).toHaveBeenCalledTimes(jobs);
    await f.engine.command({
      operation: "analyze-candidate",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version,
    });
    await expect(f.engine.command(command)).rejects.toThrow("Candidate changed");
    const corrected = await f.engine.command({
      operation: "save-slicing",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version,
      slice: {
        ...candidate.slice!,
        rows: candidate.slice!.rows.map((r) =>
          Object.assign({}, r, {
            cells: r.cells.map((c, i) => Object.assign({}, c, { enabled: i !== 0 })),
          }),
        ),
      },
    });
    const broken = corrected.runs[0]!.candidates![0]!;
    await expect(
      f.engine.command({
        ...command,
        version: broken.version ?? 0,
        processingVersionId: broken.processingVersionId,
        analysisRevision: broken.analysisRevision ?? 0,
      }),
    ).rejects.toThrow("structural frame errors");
    expect(f.images.createJob).toHaveBeenCalledTimes(jobs);
  });
  it("forks a stale processing draft without discarding the saved correction or charging again", async () => {
    const f = await fixture(),
      plan = await f.propose(8);
    await f.confirm(plan);
    f.finish();
    await f.engine.tick();
    const original = await f.engine.command({ operation: "get", projectId: "project" });
    const run = original.runs[0]!,
      candidate = run.candidates![0]!;
    await f.engine.command({
      operation: "save-slicing",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version!,
      slice: { ...candidate.slice!, registration: { scale: 1, offsetX: 1, offsetY: 0 } },
    });
    const forked = await f.engine.command({
      operation: "fork-slicing",
      projectId: "project",
      runId: run.id,
      candidateId: candidate.id,
      version: candidate.version!,
      slice: { ...candidate.slice!, registration: { scale: 1, offsetX: 0, offsetY: 1 } },
    });
    const result = forked.runs[0]!.candidates![0]!;
    expect(result.processingVersions).toHaveLength(3);
    expect(result.processingVersions![1]!.configuration.registration).toEqual({
      scale: 1,
      offsetX: 1,
      offsetY: 0,
    });
    expect(result.slice!.registration).toEqual({ scale: 1, offsetX: 0, offsetY: 1 });
    expect(f.images.createJob).toHaveBeenCalledTimes(1);
  });
});

it("opens imports idempotently without AI, suggests a multi-row grid and preserves intentional blanks for review", async () => {
  const f = await fixture(NEW_SPRITE_RENDER_SPEC);
  const source = await f.images.upload(
    await sharp(
      Buffer.from(
        '<svg width="192" height="192">' +
          Array.from(
            { length: 8 },
            (_, i) =>
              `<rect x="${(i % 3) * 64 + 20}" y="${Math.floor(i / 3) * 64 + 10}" width="24" height="44" fill="red"/>`,
          ).join("") +
          "</svg>",
      ),
    )
      .png()
      .toBuffer(),
    "manual.png",
  );
  const input = {
    operation: "inspect-source" as const,
    projectId: "project",
    context: { ...context, renderSpec: NEW_SPRITE_RENDER_SPEC },
    references: [
      {
        referenceId: `project:${source.id}`,
        asset: source,
        role: "reference" as const,
        actionId: null,
      },
    ],
  };
  const first = await f.engine.command(input);
  const imported = first.runs.find((r) => r.importOrigin?.sourceAssetId === source.id)!;
  expect(imported.input.requestId).toMatch(/^import-/);
  expect(imported.actions).toHaveLength(1);
  expect(imported.actions![0]!.frames).toHaveLength(9);
  expect(imported.candidates![0]!.slice?.edit?.cells).toHaveLength(9);
  expect(f.images.createJob).not.toHaveBeenCalled();
  const second = await f.engine.command(input);
  expect(second.runs).toHaveLength(1);
  const analyzed = await f.engine.command({
    operation: "analyze-candidate",
    projectId: "project",
    runId: imported.id,
    candidateId: imported.selectedCandidateId!,
  });
  expect(analyzed.runs[0]!.candidates![0]!.analysis?.nonEmptyCells).toBe(8);
  expect(analyzed.runs[0]!.candidates![0]!.analysis?.suggestion.rows[0]!.cells).toHaveLength(9);
});
