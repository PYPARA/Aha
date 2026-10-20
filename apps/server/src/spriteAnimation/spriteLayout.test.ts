import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  spriteBoundaries,
  spriteGridSlice,
  validateSpriteSlice,
  spriteBlockedActions,
  spriteRecommendedSize,
  spritePlanPrompt,
  type SpritePlanAction,
  type SpriteContext,
} from "@synara/contracts";
import { analyzeSprite, processSprite } from "./processSprite";
const context: SpriteContext = {
  projectId: "p",
  threadId: "t",
  name: "Test",
  providerId: "provider",
  model: "image",
  referenceAssetId: null,
  action: "idle",
  fps: 12,
  frameCount: 8,
  width: 256,
  height: 256,
  background: "transparent",
  chromaKey: "#00ff00",
};
const actions: SpritePlanAction[] = Array.from({ length: 8 }, (_, i) => ({
  id: `a-${i}`,
  name: `a-${i}`,
  description: "",
  enabled: true,
  frameCount: 8,
  fps: 12,
  loop: true,
}));
async function sheet(counts: number[], width = 1312, height = 1199) {
  const body = counts
    .flatMap((count, row) =>
      Array.from(
        { length: count },
        (_, col) =>
          `<rect x="${60 + col * 123}" y="${12 + row * 148}" width="60" height="125" fill="${col % 2 ? "#8844cc" : "#22aa88"}"/>`,
      ),
    )
    .join("");
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}
describe("layout inspection and corrected slicing", () => {
  it("covers every pixel for uneven grids and rejects overlaps", () => {
    const edges = spriteBoundaries(1199, 8);
    expect(edges[0]).toBe(0);
    expect(edges.at(-1)).toBe(1199);
    expect(new Set(edges.slice(1).map((v, i) => v - edges[i]!))).toEqual(new Set([149, 150]));
    const grid = spriteGridSlice(1312, 1199, actions);
    expect(() => validateSpriteSlice(grid, 1312, 1199)).not.toThrow();
    expect(() =>
      validateSpriteSlice(
        {
          ...grid,
          rows: [{ ...grid.rows[0]!, cells: [grid.rows[0]!.cells[0]!, grid.rows[0]!.cells[0]!] }],
        },
        1312,
        1199,
      ),
    ).toThrow("overlap");
  });
  it("detects the 8 by 7 result, retains the requested 64 and processes 56 only after explicit correction", async () => {
    const bytes = await sheet(Array(8).fill(7));
    const analysis = await analyzeSprite(bytes, context, actions, "source");
    expect(analysis).toMatchObject({ plannedFrames: 64, suspectedSubjects: 56, reliable: true });
    expect(analysis.suggestion.rows.map((r) => r.cells.length)).toEqual(Array(8).fill(7));
    expect(analysis.issues.some((i) => i.code === "outer-space")).toBe(true);
    const corrected = { ...analysis.suggestion, reviewedActionIds: actions.map((a) => a.id) };
    const processed = await processSprite(bytes, context, actions, corrected);
    expect(processed.frames).toHaveLength(56);
    expect(processed.actions.every((a) => a.frames.length === 7)).toBe(true);
    expect(
      spriteBlockedActions({
        id: "source",
        source: { width: 1312, height: 1199 } as never,
        status: "ready",
        frames: [],
        actions: processed.actions.map((a) => ({
          ...a,
          frames: a.frames.map(() => ({ id: "frame" }) as never),
        })),
        warnings: [],
        error: null,
        slice: corrected,
        issues: analysis.issues,
      }).size,
    ).toBe(0);
  });
  it("suggests per-action frame counts and retains empty temporal positions unless excluded", async () => {
    const counts = [6, 8, 8, 4, 5, 8, 6, 6];
    const analysis = await analyzeSprite(await sheet(counts), context, actions, "source");
    expect(analysis.suggestion.rows.map((r) => r.cells.length)).toEqual(counts);
    const blank = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    const descriptors = [{ ...actions[0]!, frameCount: 2 }];
    const processed = await processSprite(
      blank,
      { ...context, width: 16, height: 16 },
      descriptors,
    );
    expect(processed.frames).toHaveLength(2);
    expect(processed.issues.filter((i) => i.code === "empty")).toHaveLength(2);
  });
  it("uses a shared transform preserving intentional vertical displacement", async () => {
    const bytes = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect x="8" y="20" width="8" height="8" fill="green"/><rect x="40" y="8" width="8" height="8" fill="green"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const processed = await processSprite(bytes, { ...context, width: 32, height: 32 }, [
      { ...actions[0]!, frameCount: 2 },
    ]);
    const bounds = await Promise.all(
      processed.frames.map(async (f) => {
        const { data, info } = await sharp(f)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++)
            if (data[(y * info.width + x) * 4 + 3]! > 0) return y;
        return -1;
      }),
    );
    expect(bounds).toEqual([20, 8]);
  });
});
