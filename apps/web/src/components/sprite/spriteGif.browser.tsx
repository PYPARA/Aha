import { expect, it } from "vitest";
import { decodeSpriteSource } from "./spriteFiles";
import { encodeSpriteGifPreview } from "./spriteGif";
import { newSpriteProject, sliceFrames } from "./spriteModel";

/** Two 16×16 frames on a transparent sheet: a red pose, then a blue one. */
async function project(loop: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "red";
  ctx.fillRect(4, 8, 6, 6);
  ctx.fillStyle = "blue";
  ctx.fillRect(20, 2, 6, 6);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  const source = await decodeSpriteSource(blob, "walk.png");
  const p = newSpriteProject();
  p.version = 1;
  p.renderSpec = undefined;
  p.width = 16;
  p.height = 16;
  p.sources = [source];
  const action = p.actions[0]!;
  action.fps = 10;
  action.loop = loop;
  action.frames = sliceFrames(source, {
    mode: "grid",
    columns: 2,
    rows: 1,
    width: 16,
    height: 16,
    margin: 0,
    gap: 0,
  });
  action.frames[1]!.durationMs = 250;
  return p;
}
async function decode(bytes: Uint8Array) {
  const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack!;
  const frames = [];
  for (let i = 0; i < track.frameCount; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    frames.push({ duration: (image.duration ?? 0) / 1000, pixel, width: image.displayWidth });
    image.close();
  }
  return { frames, repetition: track.repetitionCount };
}
it("encodes each exported frame with its own duration and transparency", async () => {
  const p = await project(true);
  const bytes = await encodeSpriteGifPreview(p, p.actions[0]!.id);
  expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
  const gif = await decode(bytes);
  expect(gif.frames).toHaveLength(2);
  expect(gif.frames.map((f) => f.duration)).toEqual([100, 250]);
  expect(gif.frames[0]!.width).toBe(16);
  expect(gif.frames[0]!.pixel(6, 10)[0]).toBeGreaterThan(200);
  expect(gif.frames[0]!.pixel(1, 1)[3]).toBe(0);
  // The previous pose is cleared rather than showing through transparent pixels.
  expect(gif.frames[1]!.pixel(6, 10)[3]).toBe(0);
  expect(gif.frames[1]!.pixel(6, 4)[2]).toBeGreaterThan(200);
  expect(gif.repetition).toBe(Infinity);
});
it("plays non-looping actions once and rejects empty actions", async () => {
  const once = await project(false);
  expect((await decode(await encodeSpriteGifPreview(once, once.actions[0]!.id))).repetition).toBe(
    0,
  );
  once.actions[0]!.frames = [];
  await expect(encodeSpriteGifPreview(once, once.actions[0]!.id)).rejects.toThrow(
    "No frames to export.",
  );
});
