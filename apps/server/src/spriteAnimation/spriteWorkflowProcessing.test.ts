/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processSprite } from "./processSprite";
const testContext = {
  projectId: "test",
  threadId: "thread",
  name: "Fox",
  providerId: "test",
  model: "test",
  referenceAssetId: null,
  action: "jump",
  frameCount: 2,
  fps: 24,
  width: 16,
  height: 16,
  background: "chroma" as const,
  chromaKey: "#00ff00",
};
import { spriteTaskSlice, type SpriteTaskLayout } from "@synara/contracts";
const action = {
  id: "jump",
  name: "jump",
  description: "jump",
  enabled: true,
  frameCount: 2,
  fps: 24,
  loop: false,
};
const layout: SpriteTaskLayout = {
  width: 32,
  height: 16,
  columns: 2,
  rows: 1,
  cells: [0, 1].map((i) => ({
    actionId: "jump",
    frameIndex: i,
    x: i * 16,
    y: 0,
    width: 16,
    height: 16,
  })),
};
const context = {
  ...testContext,
  workflowVersion: 2 as const,
  renderSpec: { mode: "pixel" as const, logicalWidth: 16, logicalHeight: 16, outputScale: 4 },
  width: 64,
  height: 64,
};
async function source() {
  return sharp(
    Buffer.from(
      '<svg width="32" height="16"><rect width="32" height="16" fill="#00ff00"/><rect x="5" y="9" width="5" height="5" fill="#ff0000"/><rect x="21" y="3" width="5" height="5" fill="#ff0000"/></svg>',
    ),
  )
    .png()
    .toBuffer();
}
describe("workflow raster processing", () => {
  it("reports frames which become empty at the logical resolution as blocking errors", async () => {
    const { data, info } = await sharp(await source())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4)
      if (data[i] === 255 && data[i + 1] === 0) data[i + 3] = 100;
    const image = await sharp(data, { raw: info }).png().toBuffer();
    const result = await processSprite(image, context, [action], undefined, layout);
    expect(
      result.issues.filter((issue) => issue.code === "empty").map((issue) => issue.severity),
    ).toEqual(["error", "error"]);
  });
  it("exports uniform 4×4 RGBA blocks from logical masters and preserves jump height", async () => {
    const result = await processSprite(await source(), context, [action], undefined, layout);
    expect(result.actions[0]!.action).toMatchObject({ fps: 24, loop: false });
    const first = await sharp(result.frames[0]).ensureAlpha().raw().toBuffer();
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        expect([...first.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)]).toEqual([
          ...first.subarray(
            (Math.floor(y / 4) * 4 * 64 + Math.floor(x / 4) * 4) * 4,
            (Math.floor(y / 4) * 4 * 64 + Math.floor(x / 4) * 4) * 4 + 4,
          ),
        ]);
    const a = await sharp(result.masters[0]).raw().toBuffer(),
      b = await sharp(result.masters[1]).raw().toBuffer();
    expect(a[(9 * 16 + 5) * 4 + 3]).toBe(255);
    expect(b[(3 * 16 + 5) * 4 + 3]).toBe(255);
    expect(b[(9 * 16 + 5) * 4 + 3]).toBe(0);
  });
  it("keeps sprite position when only empty pixels are trimmed from a crop", async () => {
    const bytes = await source(),
      slice = spriteTaskSlice(layout, [action]);
    const rows = slice.rows.map((row) => ({
      ...row,
      cells: row.cells.map((c) => ({ ...c, x: c.x + 2, width: c.width - 2 })),
    }));
    const before = await processSprite(bytes, context, [action], slice, layout);
    const after = await processSprite(bytes, context, [action], { ...slice, rows }, layout);
    expect(after.frames.map(Buffer.from)).toEqual(before.frames.map(Buffer.from));
  });
  it("keys a chroma background even when one source pixel already has alpha", async () => {
    const { data, info } = await sharp(await source())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data[3] = 254;
    const result = await processSprite(
      await sharp(data, { raw: info }).png().toBuffer(),
      context,
      [action],
      undefined,
      layout,
    );
    const raw = await sharp(result.frames[0]).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
    expect(raw[(36 * 64 + 20) * 4 + 3]).toBe(255);
  });
  it("reprocesses from original bytes reproducibly and retains illustration alpha", async () => {
    const bytes = await source();
    const a = await processSprite(bytes, context, [action], undefined, layout),
      b = await processSprite(bytes, context, [action], undefined, layout);
    expect(a.frames.map(Buffer.from)).toEqual(b.frames.map(Buffer.from));
    const image = await sharp(
      Buffer.from(
        '<svg width="16" height="16"><rect x="4" y="4" width="8" height="8" fill="green" fill-opacity=".5"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const illustration = await processSprite(image, {
      ...context,
      frameCount: 1,
      background: "transparent",
      width: 16,
      height: 16,
      renderSpec: { mode: "illustration", logicalWidth: 16, logicalHeight: 16, outputScale: 1 },
    });
    const raw = await sharp(illustration.frames[0]).raw().toBuffer();
    expect(raw[(5 * 16 + 5) * 4 + 3]).toBeGreaterThan(120);
    expect(raw[(5 * 16 + 5) * 4 + 3]).toBeLessThan(140);
  });
});

it("bakes per-frame corrections once into logical masters and output, keeping stable order and duration", async () => {
  const { spriteEditFromSlice, spriteSliceFromEdit } = await import("@synara/contracts");
  const bytes = await sharp(
    Buffer.from(
      '<svg width="32" height="16"><rect x="4" y="9" width="4" height="4" fill="red"/><rect x="21" y="6" width="4" height="4" fill="blue"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const spec = { mode: "pixel" as const, logicalWidth: 16, logicalHeight: 16, outputScale: 2 };
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action]));
  const group = edit.actions[0]!;
  const corrected = {
    ...edit,
    actions: [
      {
        ...group,
        frames: [
          { ...group.frames[1]!, offsetX: -2, offsetY: 6, durationMs: 175 },
          group.frames[0]!,
        ],
      },
    ],
  };
  const processed = await processSprite(
    bytes,
    { ...context, renderSpec: spec, width: 32, height: 32, background: "transparent" },
    [action],
    spriteSliceFromEdit(corrected),
  );
  const { data, info } = await sharp(processed.masters[0]!)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([...data.subarray((9 * info.width + 4) * 4, (9 * info.width + 4) * 4 + 4)]).toEqual([
    0, 0, 255, 255,
  ]);
  expect(data[(6 * info.width + 5) * 4 + 3]).toBe(0);
  expect(processed.actions[0]!.frameMetadata[0]).toMatchObject({
    id: group.frames[1]!.id,
    durationMs: 175,
  });
  const output = await sharp(processed.frames[0]!)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([...output.data.subarray((18 * 32 + 8) * 4, (18 * 32 + 8) * 4 + 4)]).toEqual([
    0, 0, 255, 255,
  ]);
  const again = await processSprite(
    bytes,
    { ...context, renderSpec: spec, width: 32, height: 32, background: "transparent" },
    [action],
    processed.configuration,
  );
  expect(Buffer.from(again.frames[0]!)).toEqual(Buffer.from(processed.frames[0]!));
});
it("keeps intentional empty frames only when explicitly marked", async () => {
  const { spriteEditFromSlice, spriteSliceFromEdit } = await import("@synara/contracts");
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 4, background: "#00000000" },
  })
    .png()
    .toBuffer();
  const edit = spriteEditFromSlice(spriteTaskSlice(layout, [action]));
  const normal = await processSprite(
    bytes,
    { ...context, background: "transparent" },
    [action],
    spriteSliceFromEdit(edit),
  );
  expect(normal.issues.some((i) => i.code === "empty")).toBe(true);
  const allowed = {
    ...edit,
    actions: edit.actions.map((g) => ({
      ...g,
      frames: g.frames.map((f) => ({ ...f, allowEmpty: true })),
    })),
  };
  const corrected = await processSprite(
    bytes,
    { ...context, background: "transparent" },
    [action],
    spriteSliceFromEdit(allowed),
  );
  expect(corrected.issues.some((i) => i.code === "empty")).toBe(false);
  expect(corrected.frames).toHaveLength(2);
});
