import { workflowConfiguration } from "./spriteWorkflow.fixture";
import { describe, expect, it } from "vitest";
import { spritePlanTasks, spritePlanIssues, spritePlanPrompt } from "./spritePlan";
import { DEFAULT_SPRITE_RENDER_SPEC, spriteOutputSize, spriteTaskSlice } from "./spriteWorkflow";
import { validateSpriteSlice } from "./spriteProcessing";

describe("staged sprite layout", () => {
  it("keeps the per-frame request size and the output canvas independent", () => {
    const c = workflowConfiguration();
    const tasks = spritePlanTasks(c);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.parameters).toMatchObject({ size: "512x512", outputFormat: "gif" });
    expect(tasks[0]!.width).toBe(256);
    expect(spritePlanTasks({ ...c, sizeSource: "auto" })[0]!.parameters.size).toBe("auto");
  });
  it.each([2, 5, 8, 9, 16, 17, 32])(
    "maps %i frames to bounded GIF tasks without changing playback settings",
    (frames) => {
      const tasks = spritePlanTasks(workflowConfiguration(frames));
      expect(tasks).toHaveLength(Math.ceil(frames / 16));
      expect(
        tasks.flatMap((t) => t.layout!.cells.filter((c) => c.actionId).map((c) => c.frameIndex)),
      ).toEqual(Array.from({ length: frames }, (_, i) => i));
      for (const task of tasks) {
        expect(task.actions[0]).toMatchObject({ fps: 24, loop: false });
        expect(task.segment!.frameCount).toBeGreaterThanOrEqual(2);
        expect(task.parameters.frameCount).toBe(task.segment!.frameCount);
        const layout = task.layout!;
        validateSpriteSlice(spriteTaskSlice(layout, task.actions), layout.width, layout.height);
      }
    },
  );
  it("rejects single-frame actions and ignores retired model capability declarations", () => {
    const c = workflowConfiguration();
    const legacy = spritePlanTasks({
      ...c,
      sizePolicy: { kind: "custom", referenceImages: false, maxEdge: 128 },
    });
    expect(legacy.map((t) => t.layout)).toEqual(spritePlanTasks(c).map((t) => t.layout));
    expect(
      spritePlanIssues({ ...c, sizePolicy: { kind: "fixed", referenceImages: false } }),
    ).toEqual([]);
    expect(spritePlanIssues({ ...c, canonical: undefined })).toContain(
      "Confirm the character reference before generating actions.",
    );
    expect(spritePlanIssues(workflowConfiguration(1))).toContain(
      "Each action needs at least 2 frames for GIF generation.",
    );
  });
  it("derives output dimensions and rejects noninteger pixel magnification", () => {
    expect(spriteOutputSize(DEFAULT_SPRITE_RENDER_SPEC)).toEqual({ width: 256, height: 256 });
    expect(() => spriteOutputSize({ ...DEFAULT_SPRITE_RENDER_SPEC, outputScale: 1.5 })).toThrow();
    expect(() =>
      spriteOutputSize({
        mode: "illustration",
        logicalWidth: 256,
        logicalHeight: 256,
        outputScale: 2,
      }),
    ).toThrow();
  });
  it("replans a segment from its own settings and protects its global frame range", () => {
    const task = spritePlanTasks(workflowConfiguration(20))[1]!;
    expect(task.segment).toMatchObject({ frameStart: 10, frameCount: 10, index: 1 });
    expect(spritePlanTasks(task)[0]).toEqual(task);
    expect(() =>
      spritePlanTasks({ ...task, actions: [{ ...task.actions[0]!, frameCount: 6 }] }),
    ).toThrow("frame range");
  });
  it("describes GIF segments without layout guides", () => {
    const [first, second] = spritePlanTasks(workflowConfiguration(20));
    const prompt = spritePlanPrompt(second!);
    expect(prompt).toContain("animated GIF");
    expect(prompt).toContain("global frames 11–20 of 20");
    expect(prompt).toContain("last two frames of the previous segment");
    expect(prompt).not.toMatch(/layout|slot|grid guide/i);
    expect(spritePlanPrompt(first!)).toContain("Begin the action at its initial phase.");
  });
});
