import { describe, expect, it } from "vitest";
import type { SpriteRun, SpritePlanConfiguration } from "@synara/contracts";
import { spritePlanTasks } from "@synara/contracts";
import {
  spriteCombinedActionRun,
  spriteTaskSnapshots,
  spriteFrameRun,
} from "./spriteWorkflowModel";
import { spriteBlockedActions } from "@synara/contracts";
const asset = (id: string) => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png" as const,
  url: `/${id}`,
  thumbnailUrl: `/${id}`,
  width: 256,
  height: 256,
  bytes: 100,
  createdAt: "2026-10-18T00:00:00Z",
});
function runs(): SpriteRun[] {
  const c: SpritePlanConfiguration = {
    workflowVersion: 2,
    sequenceId: "sequence",
    renderSpec: { mode: "pixel", logicalWidth: 64, logicalHeight: 64, outputScale: 4 },
    kind: "animation",
    mode: "separate",
    prompt: "jump",
    providerId: "p",
    model: "m",
    width: 256,
    height: 256,
    background: "transparent",
    chromaKey: "#00ff00",
    references: [],
    parameters: { n: 1 },
    actions: [
      {
        id: "jump",
        name: "jump",
        description: "jump",
        enabled: true,
        frameCount: 9,
        fps: 24,
        loop: false,
      },
    ],
  };
  return spritePlanTasks(c).map((configuration, i) => {
    const source = asset(`source-${i}`),
      frames = Array.from({ length: configuration.segment!.frameCount }, (_, j) =>
        asset(`frame-${configuration.segment!.frameStart + j}`),
      );
    const actions = [{ action: configuration.actions[0]!, frames, warnings: [] }];
    return {
      id: `run-${i}`,
      planId: "plan",
      configuration,
      context: {
        projectId: "project",
        threadId: "thread",
        name: "Fox",
        providerId: "p",
        model: "m",
        referenceAssetId: null,
        action: "jump",
        frameCount: configuration.segment!.frameCount,
        fps: 24,
        width: 256,
        height: 256,
        background: "transparent",
        chromaKey: "#00ff00",
      },
      input: { requestId: `request-${i}`, kind: "animation", prompt: "jump" },
      jobId: `job-${i}`,
      status: "ready",
      source,
      frames,
      actions,
      warnings: [],
      error: null,
      createdAt: source.createdAt,
      selectedCandidateId: source.id,
      candidates: [
        {
          id: source.id,
          source,
          frames,
          actions,
          warnings: [],
          issues: [],
          status: "ready",
          error: null,
          processingVersionId: `version-${i}`,
        },
      ],
    } as SpriteRun;
  });
}
describe("complete action assembly", () => {
  it("previews complete segments before review and validates the review of every segment", () => {
    const parts = runs();
    const risk = {
      code: "layout-risk",
      severity: "error" as const,
      message: "Review the detected subject",
      actionId: "jump",
      frameIndex: 0,
    };
    const pending = parts.map((p) =>
      Object.assign({}, p, {
        candidates: p.candidates!.map((c) =>
          Object.assign({}, c, { status: "needs-adjustment" as const, issues: [risk] }),
        ),
      }),
    );
    const assembled = spriteCombinedActionRun(pending[0]!, pending)!;
    expect(assembled.frames).toHaveLength(9);
    expect(spriteBlockedActions(assembled.candidates![0]!).has("jump")).toBe(true);
    const checked = pending.map((p) =>
      Object.assign({}, p, {
        candidates: p.candidates!.map((c) =>
          Object.assign({}, c, {
            reviews: [
              {
                actionId: "jump",
                processingVersionId: c.processingVersionId,
                analysisRevision: 0,
                createdAt: "now",
              },
            ],
          }),
        ),
      }),
    );
    expect(
      spriteBlockedActions(spriteCombinedActionRun(checked[0]!, checked)!.candidates![0]!).size,
    ).toBe(0);
    const revised = checked.map((p, i) =>
      i === 1
        ? Object.assign({}, p, {
            candidates: p.candidates!.map((c) => Object.assign({}, c, { analysisRevision: 1 })),
          })
        : p,
    );
    expect(
      spriteBlockedActions(spriteCombinedActionRun(revised[0]!, revised)!.candidates![0]!).has(
        "jump",
      ),
    ).toBe(true);
  });
  it("locates the actual segment and local frame from a combined preview asset", () => {
    const parts = runs(),
      whole = spriteCombinedActionRun(parts[0]!, parts)!;
    expect(spriteFrameRun(whole, parts, "frame-8")).toEqual({ run: parts[1], index: 0 });
    expect(spriteFrameRun(whole, parts, "frame-3")).toEqual({ run: parts[0], index: 3 });
  });
  it("assembles chronological frames even if parts finish in reverse order", () => {
    const parts = runs(),
      result = spriteCombinedActionRun(parts[1]!, parts.toReversed())!;
    expect(result.frames.map((f) => f.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `frame-${i}`),
    );
    expect(result.actions![0]!.action).toMatchObject({ frameCount: 9, fps: 24, loop: false });
    expect(result.assembledRunIds).toEqual(["run-0", "run-1"]);
    const snapshots = spriteTaskSnapshots(result, parts);
    expect(snapshots.map((s) => s.segment.frameStart)).toEqual([0, 8]);
    expect(snapshots[0]!.layout.cells.filter((c) => c.actionId).map((c) => c.frameIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });
  it("blocks partial or empty actions and replaces only the repaired segment", () => {
    const parts = runs();
    expect(spriteCombinedActionRun(parts[0]!, parts.slice(0, 1))).toBeUndefined();
    const failed = {
      ...parts[1]!,
      status: "failed" as const,
      candidates: [{ ...parts[1]!.candidates![0]!, status: "failed" as const }],
    };
    expect(spriteCombinedActionRun(parts[0]!, [parts[0]!, failed])).toBeUndefined();
    const repaired = {
      ...parts[1]!,
      id: "repair",
      planId: "repair-plan",
      frames: [asset("repaired")],
      actions: [{ ...parts[1]!.actions![0]!, frames: [asset("repaired")] }],
      candidates: [
        {
          ...parts[1]!.candidates![0]!,
          frames: [asset("repaired")],
          actions: [{ ...parts[1]!.actions![0]!, frames: [asset("repaired")] }],
          processingVersionId: "repaired-version",
        },
      ],
    };
    const result = spriteCombinedActionRun(parts[0]!, [...parts, repaired])!;
    expect(result.frames.at(-1)!.id).toBe("repaired");
    expect(result.frames.slice(0, 8).map((f) => f.id)).toEqual(parts[0]!.frames.map((f) => f.id));
    expect(result.candidates![0]!.processingVersionId).not.toBe(
      spriteCombinedActionRun(parts[0]!, parts)!.candidates![0]!.processingVersionId,
    );
  });
});
