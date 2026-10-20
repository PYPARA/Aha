/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import { expect, it } from "vitest";
import { Schema } from "effect";
import {
  SpriteSliceConfiguration,
  spriteEditFromSlice,
  spriteSliceFromEdit,
  spriteTaskSlice,
  spriteEditGrid,
  spriteStationarySuggestions,
  validateSpriteSlice,
  spriteSupportAnchor,
  type SpriteTaskLayout,
} from "./index";
const action = {
  id: "idle",
  name: "idle",
  description: "",
  enabled: true,
  frameCount: 8,
  fps: 12,
  loop: true,
};
const layout: SpriteTaskLayout = {
  width: 64,
  height: 32,
  columns: 4,
  rows: 2,
  cells: Array.from({ length: 8 }, (_, i) => ({
    id: `cell-${i}`,
    actionId: "idle",
    frameIndex: i,
    x: (i % 4) * 16,
    y: Math.floor(i / 4) * 16,
    width: 16,
    height: 16,
  })),
};
it("adapts cross-row cells to one ordered action without deriving grouping from y", () => {
  const slice = spriteTaskSlice(layout, [action]);
  const edit = spriteEditFromSlice(slice);
  expect(edit.actions).toHaveLength(1);
  expect(edit.actions[0]!.frames).toHaveLength(8);
  expect(new Set(edit.cells.map((c) => c.y)).size).toBe(2);
  const restored = Schema.decodeUnknownSync(SpriteSliceConfiguration)(spriteSliceFromEdit(edit));
  validateSpriteSlice(restored, 64, 32);
  expect(spriteEditFromSlice(restored)).toEqual(edit);
});
it("creates independent instances that can reuse the same cell without mutating geometry", () => {
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action])),
    first = edit.actions[0]!.frames[0]!;
  const next = {
    ...edit,
    actions: [
      ...edit.actions,
      {
        action: { ...action, id: "second" },
        frames: [{ ...first, id: "another-instance", offsetX: 3, durationMs: 125 }],
      },
    ],
  };
  validateSpriteSlice(spriteSliceFromEdit(next), 64, 32);
  expect(next.cells).toEqual(edit.cells);
  expect(next.actions[0]!.frames[0]!.offsetX).toBe(0);
  expect(spriteSliceFromEdit(next).rows[1]!.cells[0]).toMatchObject({
    offsetX: 3,
    durationMs: 125,
  });
});
it("retains stable frame identities and timing when layout geometry changes", () => {
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action]));
  const timed = {
    ...edit,
    actions: edit.actions.map((g) => ({
      ...g,
      frames: g.frames.map((f) => ({ ...f, durationMs: 120 })),
    })),
  };
  const next = spriteEditGrid(timed, {
    ...layout,
    cells: layout.cells.map((c) => ({ ...c, x: c.x + 1, width: 15 })),
  });
  expect(next.removed).toEqual([]);
  expect(next.edit.actions).toEqual(timed.actions);
  const fewer = spriteEditGrid(timed, { ...layout, cells: layout.cells.slice(0, 4) });
  expect(fewer.removed).toHaveLength(4);
  expect(fewer.edit.actions[0]!.frames).toHaveLength(4);
});
it("keeps crop origins independent and validates missing identities, durations and manual 33-frame actions", () => {
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action]));
  const c = edit.cells[0]!;
  const crop = { ...edit, cells: edit.cells.map((g) => (g === c ? { ...g, x: 2, width: 14 } : g)) };
  expect(crop.cells[0]!.originX).toBe(0);
  validateSpriteSlice(spriteSliceFromEdit(crop), 64, 32);
  expect(() =>
    validateSpriteSlice(
      spriteSliceFromEdit({
        ...edit,
        actions: [{ action, frames: [{ ...edit.actions[0]!.frames[0]!, durationMs: -1 }] }],
      }),
      64,
      32,
    ),
  ).toThrow();
  const many = {
    ...edit,
    actions: [
      {
        action: { ...action, frameCount: 33 },
        frames: Array.from({ length: 33 }, (_, i) => ({
          ...edit.actions[0]!.frames[0]!,
          id: `instance-${i}`,
        })),
      },
    ],
  };
  Schema.decodeUnknownSync(SpriteSliceConfiguration)(spriteSliceFromEdit(many));
  validateSpriteSlice(spriteSliceFromEdit(many), 64, 32);
});
it("never centers jump frames until confirmed anchors are explicitly applied", () => {
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action]));
  const group = edit.actions[0]!;
  const frames = group.frames.map((f, i) => ({
    ...f,
    offsetY: i,
    anchor: { x: 8, y: i === 1 ? 7 : 13, confirmed: true },
  }));
  const before = { ...edit, actions: [{ ...group, frames }] };
  const original = JSON.stringify(before);
  expect(spriteStationarySuggestions(before, "idle", frames[0]!.id)[1]).toMatchObject({
    offsetY: 6,
  });
  expect(JSON.stringify(before)).toBe(original);
  expect(() => spriteStationarySuggestions(edit, "idle", group.frames[0]!.id)).toThrow("anchor");
});
it("provides transparent support suggestions and flags touching edges", () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 4; y < 14; y++) for (let x = 6; x < 10; x++) rgba[(y * 16 + x) * 4 + 3] = 255;
  expect(spriteSupportAnchor(rgba, 16, 16)).toMatchObject({
    x: 8,
    y: 13,
    confirmed: false,
    reliable: true,
  });
  rgba[(15 * 16 + 8) * 4 + 3] = 255;
  expect(spriteSupportAnchor(rgba, 16, 16)?.reliable).toBe(false);
});
