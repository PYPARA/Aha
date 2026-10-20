/* eslint-disable oxc/no-map-spread -- Fixtures exercise immutable candidate updates. */
import { expect, it, vi, afterEach } from "vitest";
import type { SpriteRun } from "@synara/contracts";
import { newSpriteProject, spriteFrameDuration, spriteFrameAtTime } from "./spriteModel";
import { spriteExportLayout } from "./spriteExportLayout";
import { spriteBlockedActions } from "@synara/contracts";
import {
  snapshotSpriteActions,
  restoreSpriteActionVersion,
  spriteActionCandidates,
  spriteActionRepairRun,
  spriteCandidateStructuralErrors,
  spriteExportFingerprint,
} from "./spriteWorkbenchModel";

afterEach(() => vi.unstubAllGlobals());
function project() {
  const p = newSpriteProject();
  p.sources = [
    {
      id: "source",
      name: "frame.png",
      width: 16,
      height: 16,
      blob: new Blob(["pixels"], { type: "image/png" }),
      usage: "generated-frame",
    },
  ];
  p.actions[0]!.frames = [
    { id: "frame", sourceId: "source", x: 0, y: 0, width: 16, height: 16, offsetX: 0, offsetY: -4 },
  ];
  return p;
}
function run(actionId: string): SpriteRun {
  return {
    id: "run",
    createdAt: "2026-10-19T00:00:00Z",
    input: { kind: "animation" },
    status: "ready",
    context: { projectId: "project", action: "idle" },
    selectedCandidateId: "candidate",
    source: { id: "candidate", width: 16, height: 16 },
    frames: [{ id: "result" }],
    actions: [{ action: { id: actionId, name: "idle" }, frames: [{ id: "result" }] }],
    candidates: [
      {
        id: "candidate",
        status: "ready",
        source: { id: "candidate", width: 16, height: 16 },
        processingVersionId: "processing",
        frames: [{ id: "result" }],
        actions: [{ action: { id: actionId, name: "idle" }, frames: [{ id: "result" }] }],
        issues: [],
      },
    ],
  } as unknown as SpriteRun;
}
it("inherits FPS for old frames and preserves explicit durations when FPS changes", () => {
  const p = project(),
    a = p.actions[0]!,
    f = a.frames[0]!;
  expect(spriteFrameDuration({ ...a, fps: 10 }, f)).toBe(100);
  expect(spriteFrameDuration({ ...a, fps: 20 }, { ...f, durationMs: 250 })).toBe(250);
});
it("retains edited versions and restores only the requested action with source provenance", () => {
  const p = project(),
    id = p.actions[0]!.id;
  p.actionVersions = snapshotSpriteActions(p, [id]);
  const original = p.actionVersions[0]!;
  p.actions[0] = {
    ...p.actions[0]!,
    fps: 5,
    frames: [{ ...p.actions[0]!.frames[0]!, offsetY: 12, durationMs: 400 }],
  };
  p.actions.push({ id: "walk", name: "walk", fps: 12, loop: true, frames: [] });
  const restored = restoreSpriteActionVersion(p, original.id);
  expect(restored.actions[0]!.frames[0]!.offsetY).toBe(-4);
  expect(restored.actions[1]).toEqual(p.actions[1]);
  expect(restored.actionVersions).toHaveLength(2);
  expect(restored.actionVersions![1]!.action.frames[0]!.durationMs).toBe(400);
  expect(p.actions[0]!.frames[0]!.offsetY).toBe(12);
});
it("does not associate candidates by name and uses stable IDs or provenance", () => {
  const p = project(),
    r = run("remote-id");
  p.actions[0]!.name = "idle";
  expect(spriteActionCandidates(p, { context: null, runs: [r] })[0]!.localActionId).toBeUndefined();
  const exact = run(p.actions[0]!.id);
  expect(spriteActionCandidates(p, { context: null, runs: [exact] })[0]!.localActionId).toBe(
    p.actions[0]!.id,
  );
  p.provenance = [
    {
      runId: "run",
      candidateId: "candidate",
      actionId: "remote-id",
      localActionId: p.actions[0]!.id,
      processingVersionId: "previous",
      prompt: "",
      action: "idle",
      model: "",
      providerId: "",
    },
  ];
  expect(spriteActionCandidates(p, { context: null, runs: [r] })[0]!.localActionId).toBe(
    p.actions[0]!.id,
  );
});
it("keeps missing or empty frames blocked after a proposed human review", () => {
  const r = run("idle");
  const bad = {
    ...r,
    candidates: r.candidates!.map((c) => ({
      ...c,
      issues: [
        {
          code: "missing-frames",
          severity: "error" as const,
          actionId: "idle",
          frameIndex: null,
          message: "Missing frames",
        },
      ],
    })),
  };
  expect(spriteCandidateStructuralErrors(bad, "idle")).toBe(true);
  expect(spriteCandidateStructuralErrors(r, "idle")).toBe(false);
});
it("locates a paid source whose local frame processing failed without matching names", () => {
  const p = project(),
    r = run(p.actions[0]!.id);
  const broken = Object.assign({}, r, {
    status: "failed" as const,
    configuration: {
      actions: [{ id: p.actions[0]!.id }],
    } as unknown as import("@synara/contracts").SpritePlanConfiguration,
    candidates: r.candidates!.map((c) =>
      Object.assign({}, c, { status: "failed" as const, frames: [] }),
    ),
  });
  expect(spriteActionRepairRun(p, { context: null, runs: [broken] }, p.actions[0]!.id)?.id).toBe(
    "run",
  );
  expect(
    spriteActionRepairRun(p, { context: null, runs: [broken] }, "different-id"),
  ).toBeUndefined();
});
it("export fingerprint changes with frame timing, geometry and export scale", async () => {
  const p = project(),
    ids = [p.actions[0]!.id];
  const original = await spriteExportFingerprint(p, ids);
  expect(await spriteExportFingerprint({ ...p, updatedAt: new Date().toISOString() }, ids)).toBe(
    original,
  );
  p.actions[0]!.frames[0]!.durationMs = 300;
  expect(await spriteExportFingerprint(p, ids)).not.toBe(original);
});
it("samples a common playback clock using each action's frame durations", () => {
  const a = project().actions[0]!;
  a.frames = [
    { ...a.frames[0]!, durationMs: 100 },
    { ...a.frames[0]!, id: "second", durationMs: 300 },
  ];
  expect([0, 99, 100, 399, 400, 500].map((t) => spriteFrameAtTime(a, t))).toEqual([
    0, 0, 1, 1, 0, 1,
  ]);
  expect(spriteFrameAtTime({ ...a, loop: false }, 900)).toBe(1);
});
it("invalidates only reviews from a changed processing version or analysis revision", () => {
  const c = {
    ...run("idle").candidates![0]!,
    status: "needs-adjustment" as const,
    analysisRevision: 2,
    issues: [
      {
        code: "layout-body",
        severity: "error" as const,
        actionId: "idle",
        frameIndex: 0,
        message: "Body risk",
      },
    ],
    reviews: [
      { actionId: "idle", processingVersionId: "processing", analysisRevision: 2, createdAt: "" },
    ],
  };
  expect(spriteBlockedActions(c).has("idle")).toBe(false);
  expect(spriteBlockedActions({ ...c, analysisRevision: 3 }).has("idle")).toBe(true);
  expect(spriteBlockedActions({ ...c, processingVersionId: "other" }).has("idle")).toBe(true);
});
it("uses one atlas placement for uneven rows, subsets and file order", () => {
  const p = project(),
    base = p.actions[0]!;
  p.actions = [
    {
      ...base,
      id: "idle",
      frames: Array.from({ length: 3 }, (_, i) => ({ ...base.frames[0]!, id: `idle-${i}` })),
    },
    { ...base, id: "walk", name: "walk", frames: [{ ...base.frames[0]!, id: "walk-0" }] },
  ];
  const layout = spriteExportLayout(p, ["walk", "idle"], "combined", 2, 3)!;
  expect(layout.rows).toBe(3);
  expect(layout.entries.map((e) => e.action.id)).toEqual(["idle", "walk"]);
  expect(layout.entries[1]!.frames[0]!.y).toBe(2 * (p.height + 3));
  expect(spriteExportLayout(p, ["walk"], "sequence", 2, 3)!.files).toEqual([
    "01-walk/0001.png",
    "animation.json",
  ]);
});
it("protects all current actions before restoring historical canvas settings", () => {
  const p = project();
  p.actionVersions = snapshotSpriteActions(p, [p.actions[0]!.id]);
  const version = p.actionVersions[0]!;
  p.width = 512;
  p.renderSpec = { ...p.renderSpec!, outputScale: 8 };
  expect(() => restoreSpriteActionVersion(p, version.id)).toThrow("canvas settings");
  const restored = restoreSpriteActionVersion(p, version.id, true);
  expect(restored.width).toBe(version.width);
  expect(restored.renderSpec).toEqual(version.renderSpec);
  expect(restored.actionVersions).toHaveLength(2);
});
