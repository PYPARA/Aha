/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import { expect, it } from "vitest";
import { workflowConfiguration } from "./spriteWorkflow.fixture";
import { DEFAULT_SPRITE_SIZING } from "./spriteSizing";
import { spritePlanTasks } from "./spritePlan";
it.each([
  [256, 256, 4, 2, 2, 512, 512],
  [256, 256, 5, 3, 2, 768, 512],
  [256, 256, 6, 3, 2, 768, 512],
  [256, 256, 8, 4, 2, 1024, 512],
  [512, 512, 8, 4, 2, 2048, 1024],
  [128, 256, 8, 4, 2, 512, 512],
])("links %ix%i x%i to %ix%i = %ix%i", (w, h, n, cols, rows, iw, ih) => {
  const c = {
    ...workflowConfiguration(n),
    renderSpec: {
      mode: "illustration" as const,
      logicalWidth: w,
      logicalHeight: h,
      outputScale: 1,
    },
    width: w,
    height: h,
    sizing: DEFAULT_SPRITE_SIZING,
  };
  const tasks = spritePlanTasks(c);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.layout).toMatchObject({ columns: cols, rows, width: iw, height: ih });
  expect(tasks[0]!.parameters.size).toBe(`${iw}x${ih}`);
});
it("keeps 16 frames in two frozen requests and does not stretch cells for odd counts", () => {
  const tasks = spritePlanTasks({ ...workflowConfiguration(16), sizing: DEFAULT_SPRITE_SIZING });
  expect(tasks).toHaveLength(2);
  expect(tasks.flatMap((t) => t.layout!.cells.map((c) => c.frameIndex))).toEqual(
    Array.from({ length: 16 }, (_, i) => i),
  );
  expect(new Set(tasks.flatMap((t) => t.layout!.cells.map((c) => c.id))).size).toBe(16);
  for (const t of tasks) expect(spritePlanTasks(t)[0]!.layout).toEqual(t.layout);
});
it("respects source sampling, margin, gap and fixed arrangement without adding requests", () => {
  const c = {
    ...workflowConfiguration(),
    sizing: {
      ...DEFAULT_SPRITE_SIZING,
      sourceScale: 2 as const,
      margin: 10,
      gap: 4,
      arrangement: "fixed" as const,
      columns: 4,
      rows: 2,
    },
  };
  const [task] = spritePlanTasks(c);
  expect(task!.parameters.size).toBe("2080x1048");
  expect(task!.layout!.cells[0]).toMatchObject({ x: 10, y: 10, width: 512, height: 512 });
});
it("keeps manual dimensions, integral equal-ratio cells and centered external whitespace", () => {
  const c = {
    ...workflowConfiguration(8),
    sizing: { ...DEFAULT_SPRITE_SIZING, mode: "manual" as const },
    parameters: { n: 1, size: "1025x1025" },
  };
  const task = spritePlanTasks(c)[0]!;
  expect(task.parameters.size).toBe("1025x1025");
  expect(task.layout!.cells[0]!.width % 16).not.toBe(0);
  expect(task.layout!.cells[0]!.width).toBe(task.layout!.cells[0]!.height);
  expect(
    spritePlanTasks({ ...c, actions: c.actions.map((a) => ({ ...a, frameCount: 5 })) })[0]!
      .parameters.size,
  ).toBe("1025x1025");
});
it("rejects impossible capacity instead of reducing sampling or adding requests", () => {
  expect(() =>
    spritePlanTasks({
      ...workflowConfiguration(),
      renderSpec: { mode: "illustration", logicalWidth: 4096, logicalHeight: 4096, outputScale: 1 },
      sizing: DEFAULT_SPRITE_SIZING,
    }),
  ).toThrow();
});
it("distinguishes explicit model-size mode and preserves legacy task layouts", () => {
  const old = spritePlanTasks(workflowConfiguration())[0]!;
  expect(old.layout).toMatchObject({ width: 1024, height: 1024 });
  expect(
    spritePlanTasks({
      ...workflowConfiguration(),
      sizing: { ...DEFAULT_SPRITE_SIZING, mode: "model" },
      sizeSource: "auto",
    })[0]!.parameters.size,
  ).toBe("auto");
});
