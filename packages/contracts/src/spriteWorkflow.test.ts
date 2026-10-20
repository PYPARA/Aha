import { workflowConfiguration } from "./spriteWorkflow.fixture";
import { describe, expect, it } from "vitest";
import { spritePlanTasks, spritePlanIssues } from "./spritePlan";
import { DEFAULT_SPRITE_RENDER_SPEC, spriteOutputSize, spriteTaskSlice } from "./spriteWorkflow";
import { validateSpriteSlice } from "./spriteProcessing";

describe("staged sprite layout", () => {
  it("keeps request size and frame canvas independent and preserves explicit automatic requests", () => {
    const c = workflowConfiguration();
    const illustration = {
      mode: "illustration" as const,
      logicalWidth: 256,
      logicalHeight: 256,
      outputScale: 1,
    };
    const ordinary = spritePlanTasks({
      ...c,
      renderSpec: illustration,
      parameters: { n: 1, size: "512x512" },
    });
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]!.layout).toMatchObject({ width: 512, height: 512 });
    expect(ordinary[0]!.width).toBe(256);
    const larger = spritePlanTasks({
      ...c,
      width: 512,
      height: 512,
      renderSpec: { ...illustration, logicalWidth: 512, logicalHeight: 512 },
    });
    expect(larger).toHaveLength(1);
    expect(larger[0]!.layout).toMatchObject({ width: 1024, height: 1024 });
    expect(spritePlanTasks({ ...c, sizeSource: "auto" })[0]!.parameters.size).toBe("auto");
  });
  it.each([1, 5, 6, 8, 9, 32])(
    "maps %i frames to bounded tasks without changing playback settings",
    (frames) => {
      const tasks = spritePlanTasks(workflowConfiguration(frames));
      expect(tasks).toHaveLength(Math.ceil(frames / 8));
      expect(
        tasks.flatMap((t) => t.layout!.cells.filter((c) => c.actionId).map((c) => c.frameIndex)),
      ).toEqual(Array.from({ length: frames }, (_, i) => i));
      for (const task of tasks) {
        expect(task.actions[0]).toMatchObject({ fps: 24, loop: false });
        expect(task.segment!.frameCount).toBeLessThanOrEqual(8);
        const layout = task.layout!;
        expect(layout.width).toBe(1024);
        expect(layout.height).toBe(1024);
        for (const c of layout.cells) {
          expect(c.width).toBe(c.height);
          expect(c.x + c.width).toBeLessThanOrEqual(layout.width);
          expect(c.y + c.height).toBeLessThanOrEqual(layout.height);
        }
        validateSpriteSlice(spriteTaskSlice(layout, task.actions), layout.width, layout.height);
      }
    },
  );
  it("uses the request size and ignores retired model capability declarations", () => {
    const c = workflowConfiguration();
    const ordinary = spritePlanTasks(c);
    const legacy = spritePlanTasks({
      ...c,
      sizePolicy: { kind: "custom", referenceImages: false, maxEdge: 128 },
    });
    expect(legacy.map((t) => t.layout)).toEqual(ordinary.map((t) => t.layout));
    expect(ordinary[0]!.layout).toMatchObject({ columns: 3, rows: 3, width: 1024, height: 1024 });
    expect(
      spritePlanIssues({ ...c, sizePolicy: { kind: "fixed", referenceImages: false } }),
    ).toEqual([]);
    expect(spritePlanIssues({ ...c, canonical: undefined })).toContain(
      "Confirm the character reference before generating actions.",
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
  it("allows explicit request sizes without changing the output frame or task count", () => {
    const c = {
      ...workflowConfiguration(),
      sizeSource: "user" as const,
      parameters: { n: 1, size: "2048x256" },
    };
    const tasks = spritePlanTasks({ ...c, sizePolicy: { kind: "fixed", sizes: ["1024x1024"] } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.layout).toMatchObject({ width: 2048, height: 256 });
    expect(tasks[0]!.width).toBe(256);
    expect(() => spritePlanTasks({ ...c, parameters: { n: 1, size: "8192x8192" } })).toThrow();
  });
  it("replans a segment's physical layout for the selected model and protects its global frame range", () => {
    const task = spritePlanTasks(workflowConfiguration(9))[0]!;
    const custom = spritePlanTasks({
      ...task,
      parameters: { ...task.parameters, size: "1152x576" },
    })[0]!;
    expect(custom.layout).toMatchObject({ columns: 4, rows: 2, width: 1152, height: 576 });
    expect(custom.segment).toEqual(task.segment);
    expect(() =>
      spritePlanTasks({ ...task, actions: [{ ...task.actions[0]!, frameCount: 6 }] }),
    ).toThrow("frame range");
  });
});
