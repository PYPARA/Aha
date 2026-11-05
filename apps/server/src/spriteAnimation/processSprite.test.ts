import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { expandGifFrames, processSprite } from "./processSprite";
import type { SpriteContext } from "@synara/contracts";
export const testContext: SpriteContext = {
  projectId: "sprite-test",
  threadId: "thread-test",
  name: "Fox",
  providerId: "test",
  model: "test",
  referenceAssetId: null,
  action: "jump",
  frameCount: 2,
  fps: 12,
  width: 16,
  height: 16,
  background: "chroma",
  chromaKey: "#00ff00",
};
async function sheet(background: string) {
  return sharp(
    Buffer.from(
      `<svg width="32" height="16"><rect width="32" height="16" fill="${background}"/><rect x="5" y="9" width="5" height="5" fill="red"/><rect x="21" y="3" width="5" height="5" fill="red"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}
describe("sprite deterministic processing", () => {
  it("removes the key while preserving intentional jump displacement", async () => {
    const result = await processSprite(await sheet("#00ff00"), testContext);
    expect(result.frames).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    const first = await sharp(result.frames[0]).raw().toBuffer(),
      second = await sharp(result.frames[1]).raw().toBuffer();
    expect(first[3]).toBe(0);
    expect(first[(9 * 16 + 5) * 4 + 3]).toBe(255);
    expect(second[(3 * 16 + 5) * 4 + 3]).toBe(255);
    expect(second[(9 * 16 + 5) * 4 + 3]).toBe(0);
  });
  it("preserves native alpha and green character pixels", async () => {
    const bytes = await sharp(
      Buffer.from(
        '<svg width="16" height="16"><rect x="4" y="4" width="8" height="8" fill="#00ff00" fill-opacity="0.5"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const result = await processSprite(bytes, {
      ...testContext,
      frameCount: 1,
      background: "transparent",
    });
    const raw = await sharp(result.frames[0]).raw().toBuffer();
    expect(raw[(5 * 16 + 5) * 4 + 1]).toBe(255);
    expect(raw[(5 * 16 + 5) * 4 + 3]).toBeGreaterThan(120);
  });
  it("flags empty, clipped and duplicate frames", async () => {
    const blank = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    const result = await processSprite(blank, testContext);
    expect(result.warnings.join(" ")).toMatch(/empty/);
    expect(result.warnings.join(" ")).toMatch(/identical/);
    const clipped = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();
    expect((await processSprite(clipped, testContext)).warnings.join(" ")).toMatch(/boundary/);
  });
});

it("expands GIF frames onto full canvases in rows of at most eight", async () => {
  // Static background plus one moving square: encoders store later frames as partial updates.
  const pages = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      sharp(
        Buffer.from(
          `<svg width="40" height="20"><rect width="40" height="20" fill="blue"/><rect x="${i * 3}" y="5" width="6" height="6" fill="red"/></svg>`,
        ),
      )
        .png()
        .toBuffer(),
    ),
  );
  const gif = await sharp(pages, { join: { animated: true } })
    .gif()
    .toBuffer();
  const expanded = await expandGifFrames(gif);
  expect(expanded).toMatchObject({ frames: 10, width: 40, height: 20 });
  const { data, info } = await sharp(expanded.bytes).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([200, 40]);
  const pixel = (x: number, y: number) => [
    ...data.subarray(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    ),
  ];
  for (let frame = 0; frame < 10; frame++) {
    const left = (frame % 5) * 40,
      top = Math.floor(frame / 5) * 20;
    expect(pixel(left + frame * 3 + 3, top + 8)[0]).toBeGreaterThan(200);
    expect(pixel(left + 39, top + 1)[2]).toBeGreaterThan(200);
  }
});
