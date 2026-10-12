import { expect, it } from "vitest";
import {
  sliceFrames,
  framePlacement,
  moveFrames,
  newSpriteProject,
  spriteContext,
  safeFilename,
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
  expect(() =>
    sliceFrames(source, {
      mode: "grid",
      width: 8,
      height: 8,
      margin: 0,
      gap: 0,
      columns: 3,
      rows: 1,
    }),
  ).toThrow(/whole pixels/);
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
