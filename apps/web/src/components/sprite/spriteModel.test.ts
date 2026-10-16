import { expect, it } from "vitest";
import {
  sliceFrames,
  framePlacement,
  moveFrames,
  newSpriteProject,
  spriteContext,
  safeFilename,
  selectSpriteFrame,
  reorderSelectedFrames,
  actionFromSelectedFrames,
  removeSpriteSource,
} from "./spriteModel";
const source = { id: "source", name: "sheet.png", width: 34, height: 18, blob: new Blob() };
it("slices row-major with margins and gaps without including partial cells", () => {
  const frames = sliceFrames(source, {
    mode: "size",
    width: 8,
    height: 8,
    margin: 1,
    gap: 0,
    columns: 1,
    rows: 1,
  });
  expect(frames).toHaveLength(8);
  expect(frames[4]).toMatchObject({ x: 1, y: 9, width: 8, height: 8 });
  const uneven = sliceFrames(source, {
    mode: "grid",
    width: 8,
    height: 8,
    margin: 0,
    gap: 0,
    columns: 3,
    rows: 1,
  });
  expect(uneven).toHaveLength(3);
  expect(uneven.at(-1)!.x + uneven.at(-1)!.width).toBe(source.width);
  expect(
    Math.max(...uneven.map((f) => f.width)) - Math.min(...uneven.map((f) => f.width)),
  ).toBeLessThanOrEqual(1);
});
it("aligns to a common bottom center and moves selected frames as a group", () => {
  const frames = sliceFrames(source, {
    mode: "size",
    width: 8,
    height: 8,
    margin: 1,
    gap: 0,
    columns: 1,
    rows: 1,
  });
  expect(framePlacement({ ...frames[0]!, offsetY: -3 }, 16, 16)).toEqual({ x: 4, y: 5 });
  const next = moveFrames(frames, new Set([frames[1]!.id, frames[2]!.id]), -1);
  expect(next.slice(0, 3).map((f) => f.id)).toEqual([frames[1]!.id, frames[2]!.id, frames[0]!.id]);
});
it("exports generation context without blobs or credentials", () => {
  const p = newSpriteProject();
  expect(spriteContext(p)).toMatchObject({ action: "idle", frameCount: 8, fps: 12 });
  expect(safeFilename("../a:b")).toBe("___a_b");
});

it("splits a multi-row sheet into named actions and preserves edited animations", async () => {
  const { groupSpriteSheetRows, adoptSpriteSheetRows } = await import("./spriteModel");
  const p = newSpriteProject();
  const sheet = { id: "sheet", name: "sheet.webp", width: 32, height: 24, blob: new Blob() };
  p.sources = [sheet];
  p.actions[0]!.frames = [
    { id: "whole", sourceId: sheet.id, x: 0, y: 0, width: 32, height: 24, offsetX: 0, offsetY: 0 },
  ];
  const grid = sliceFrames(sheet, {
    mode: "grid",
    columns: 4,
    rows: 3,
    width: 8,
    height: 8,
    margin: 0,
    gap: 0,
  });
  const rows = groupSpriteSheetRows(
    grid,
    new Set([grid[0]!.id, grid[1]!.id, grid[4]!.id, grid[5]!.id, grid[6]!.id]),
  );
  expect(rows.map((row) => row.frames.length)).toEqual([2, 3, 0]);
  rows[0]!.name = "idle";
  rows[1]!.name = "walk";
  const next = adoptSpriteSheetRows(p, sheet.id, rows);
  expect(next.actions.map((a) => [a.name, a.frames.length])).toEqual([
    ["idle", 2],
    ["walk", 3],
  ]);
  expect(next).toMatchObject({ width: 8, height: 8, selectedActionId: next.actions[0]!.id });
  expect(p.actions[0]!.frames[0]!.id).toBe("whole");
  expect(next.actions[1]!.frames[0]).toMatchObject({ x: 0, y: 8 });
  expect(next.actions[1]!.frames[0]!.id).not.toBe(grid[4]!.id);
  expect(() => adoptSpriteSheetRows(next, sheet.id, rows)).toThrow(/different action names/);
  rows[0]!.name = "new-idle";
  rows[1]!.name = "new-walk";
  const more = adoptSpriteSheetRows(next, sheet.id, rows);
  expect(more.actions.slice(0, 2)).toEqual(next.actions);
  expect(more.actions).toHaveLength(4);
  rows[0]!.enabled = false;
  rows[1]!.enabled = false;
  expect(() => adoptSpriteSheetRows(p, sheet.id, rows)).toThrow(/at least one/);
});

it("selects continuous ranges, copies five of fifty frames and preserves original order/parameters", () => {
  const p = newSpriteProject();
  p.sources = [{ ...source, width: 400, height: 8 }];
  const frames = sliceFrames(p.sources[0]!, {
    mode: "grid",
    columns: 50,
    rows: 1,
    width: 8,
    height: 8,
    margin: 0,
    gap: 0,
  });
  p.actions[0] = { ...p.actions[0]!, fps: 9, loop: false, frames };
  let selected = selectSpriteFrame(frames, new Set(), null, frames[5]!.id, false, false);
  selected = selectSpriteFrame(frames, selected, frames[5]!.id, frames[9]!.id, true, false);
  expect([...selected]).toEqual(frames.slice(5, 10).map((f) => f.id));
  const copied = actionFromSelectedFrames(p, selected, "walk");
  expect(copied.actions[0]!.frames).toHaveLength(50);
  expect(copied.actions[1]).toMatchObject({ name: "walk", fps: 9, loop: false });
  expect(copied.actions[1]!.frames.map((f) => f.x)).toEqual(frames.slice(5, 10).map((f) => f.x));
  expect(copied.actions[1]!.frames.every((f) => !selected.has(f.id))).toBe(true);
  const moved = reorderSelectedFrames(frames, selected, frames[0]!.id);
  expect(moved.slice(0, 5)).toEqual(frames.slice(5, 10));
  const more = selectSpriteFrame(frames, selected, frames[5]!.id, frames[14]!.id, true, true);
  expect(more.size).toBe(10);
  expect(selectSpriteFrame(frames, selected, frames[5]!.id, frames[5]!.id, false, true).size).toBe(
    4,
  );
  const removed = removeSpriteSource(copied, source.id);
  expect(removed.sources).toEqual([]);
  expect(removed.actions.map((a) => a.frames.length)).toEqual([0, 0]);
  expect(copied.sources).toHaveLength(1);
  expect(copied.actions[1]!.frames).toHaveLength(5);
});
