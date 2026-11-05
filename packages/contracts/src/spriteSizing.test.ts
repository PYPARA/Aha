import { expect, it } from "vitest";
import { workflowConfiguration } from "./spriteWorkflow.fixture";
import {
  DEFAULT_SPRITE_SIZING,
  SPRITE_REQUEST_MAX_PIXELS,
  spriteGifFrameDuration,
  spriteGifLayout,
  spriteGifSegments,
} from "./spriteSizing";
import { IMAGE_REQUEST_MIN_PIXELS } from "./imageSize";
import { spritePlanTasks } from "./spritePlan";

const illustration = (w: number, h: number, sourceScale: 1 | 2 = 2, frames = 8) => ({
  ...workflowConfiguration(frames),
  renderSpec: { mode: "illustration" as const, logicalWidth: w, logicalHeight: h, outputScale: 1 },
  width: w,
  height: h,
  sizing: { ...DEFAULT_SPRITE_SIZING, sourceScale },
});

// GIF frames are requested per frame; the combined sheet must reach the pixel minimum.
it.each([
  [256, 256, 2, 8, 512, 512],
  [256, 256, 1, 8, 288, 288],
  [256, 256, 1, 4, 416, 416],
  [128, 256, 1, 8, 208, 416],
  [512, 512, 1, 8, 512, 512],
] as const)("requests %ix%i at %i× for %i frames as %ix%i GIF frames", (w, h, scale, n, fw, fh) => {
  const tasks = spritePlanTasks(illustration(w, h, scale, n));
  expect(tasks).toHaveLength(1);
  const task = tasks[0]!;
  expect(task.parameters).toMatchObject({
    size: `${fw}x${fh}`,
    outputFormat: "gif",
    frameCount: n,
    frameDurationMs: 40,
  });
  expect(task.generation).toEqual({ version: 1 });
  expect(task.layout).toMatchObject({ columns: n, rows: 1, width: fw * n, height: fh });
  expect(n * fw * fh).toBeGreaterThanOrEqual(IMAGE_REQUEST_MIN_PIXELS);
  expect((fw % 16) + (fh % 16)).toBe(0);
  for (const [i, cell] of task.layout!.cells.entries())
    expect(cell).toMatchObject({ x: i * fw, y: 0, width: fw, height: fh, frameIndex: i });
});
it("enlarges small pixel-art frames by whole logical pixels", () => {
  const c = {
    ...workflowConfiguration(8),
    renderSpec: { mode: "pixel" as const, logicalWidth: 64, logicalHeight: 64, outputScale: 4 },
    sizing: { ...DEFAULT_SPRITE_SIZING, sourceScale: 1 as const },
  };
  const task = spritePlanTasks(c)[0]!;
  expect(task.parameters.size).toBe("320x320");
  expect(spritePlanTasks({ ...c, sizing: DEFAULT_SPRITE_SIZING })[0]!.parameters.size).toBe(
    "512x512",
  );
});
it("splits actions evenly without single-frame segments and keeps segment geometry stable", () => {
  expect(spriteGifSegments(17, 16).map((s) => s.frameCount)).toEqual([9, 8]);
  expect(spriteGifSegments(24, 16).map((s) => s.frameCount)).toEqual([12, 12]);
  expect(spriteGifSegments(32, 16).map((s) => s.frameStart)).toEqual([0, 16]);
  const tasks = spritePlanTasks(illustration(256, 256, 2, 17));
  expect(tasks.map((t) => t.segment!.frameCount)).toEqual([9, 8]);
  expect(tasks.flatMap((t) => t.layout!.cells.map((c) => c.frameIndex))).toEqual(
    Array.from({ length: 17 }, (_, i) => i),
  );
  expect(new Set(tasks.flatMap((t) => t.layout!.cells.map((c) => c.id))).size).toBe(17);
  for (const t of tasks) expect(spritePlanTasks(t)[0]).toEqual(t);
});
it("reduces frames per request until the combined sheet fits", () => {
  const c = illustration(512, 512, 2, 16);
  const tasks = spritePlanTasks(c);
  expect(tasks.map((t) => t.segment!.frameCount)).toEqual([6, 5, 5]);
  for (const t of tasks)
    expect(t.segment!.frameCount * 1024 * 1024).toBeLessThanOrEqual(SPRITE_REQUEST_MAX_PIXELS);
  expect(
    spritePlanTasks({
      ...illustration(256, 256, 2, 24),
      generation: { version: 1, segmentFrames: 24 },
    }),
  ).toHaveLength(1);
});
it("keeps per-frame manual sizes, re-derives legacy whole-sheet sizes and sends auto", () => {
  const manual = {
    ...illustration(256, 256),
    sizing: { ...DEFAULT_SPRITE_SIZING, mode: "manual" as const },
  };
  expect(
    spritePlanTasks({
      ...manual,
      generation: { version: 1 },
      parameters: { n: 1, size: "640x640" },
    })[0]!.parameters.size,
  ).toBe("640x640");
  expect(
    spritePlanTasks({ ...manual, parameters: { n: 1, size: "1152x576" } })[0]!.parameters.size,
  ).toBe("512x512");
  const auto = spritePlanTasks({
    ...manual,
    sizing: { ...DEFAULT_SPRITE_SIZING, mode: "model" },
  })[0]!;
  expect(auto.parameters.size).toBe("auto");
  expect(auto.layout).toMatchObject({ width: 4096, height: 512 });
});
it("rounds frame durations to GIF limits", () => {
  expect([1, 12, 24, 60, 0.4].map(spriteGifFrameDuration)).toEqual([1000, 80, 40, 20, 2000]);
});
it("keeps returned frames beyond the plan as unassigned cells", () => {
  const layout = spriteGifLayout("walk", 8, 8, 10, 400, 300);
  expect(layout).toMatchObject({ width: 2000, height: 600, columns: 5, rows: 2 });
  expect(layout.cells[5]).toMatchObject({ x: 0, y: 300 });
  expect(layout.cells.map((c) => c.frameIndex)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, null, null]);
  expect(layout.cells.slice(-2).every((c) => c.actionId === null)).toBe(true);
});
