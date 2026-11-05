import type {
  SpritePlanAction,
  SpritePlanConfiguration,
  SpriteSizing,
  SpriteTaskLayout,
} from "./spriteAnimation";
import { spriteOutputSize } from "./spriteWorkflow";
import { IMAGE_REQUEST_MIN_PIXELS } from "./imageSize";
import { IMAGE_GIF_FRAME_COUNT, IMAGE_GIF_FRAME_DURATION_MS } from "./imageGeneration";

/**
 * Actions are generated as GIFs. `sourceScale` is the per-frame request size relative to the
 * output frame: 2× lets illustration downscaling turn GIF's 1-bit alpha into soft edges.
 * `arrangement`, `margin`, `gap`, `columns` and `rows` belong to retired sprite-sheet requests
 * and are ignored.
 */
export const DEFAULT_SPRITE_SIZING: SpriteSizing = {
  version: 1,
  mode: "linked",
  sourceScale: 2,
  arrangement: "auto",
  margin: 0,
  gap: 0,
};
/** GPT Image renders GIF frames on one combined sheet with the still-image limits. */
export const SPRITE_REQUEST_MAX_PIXELS = 8_294_400;
export const SPRITE_GIF_MAX_EDGE = 3840;
/** Accepted by every provider tested so far; the official guide allows up to 64. */
export const SPRITE_GIF_SEGMENT_FRAMES = IMAGE_GIF_FRAME_COUNT.commonMax;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const hash = (text: string) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(36);
};
/** Stable within a source/processing branch; unrelated to physical row or column. */
export const spriteCellId = (actionId: string, index: number) => `cell-${hash(actionId)}-${index}`;

export function spriteGifFrameDuration(fps: number) {
  const { min, max, step } = IMAGE_GIF_FRAME_DURATION_MS;
  return Math.min(max, Math.max(min, Math.round(1000 / fps / step) * step));
}
/** Smallest edge of a near-square sheet holding `count` frames, as the model arranges them. */
export function spriteGifSheetEdge(count: number, width: number, height: number) {
  let edge = Infinity;
  for (let columns = 1; columns <= count; columns++)
    edge = Math.min(edge, Math.max(columns * width, Math.ceil(count / columns) * height));
  return edge;
}
function sizingOf(c: SpritePlanConfiguration): SpriteSizing {
  if (c.sizing) return c.sizing;
  return { ...DEFAULT_SPRITE_SIZING, mode: c.sizeSource === "auto" ? "model" : "linked" };
}
/**
 * Per-frame GIF request size. `auto` means `size: auto` is sent and this is only an estimate.
 * Before `generation` existed, manual sizes described a whole sheet, so they are re-derived.
 */
export function spriteGifFrameSize(
  c: SpritePlanConfiguration,
  count: number,
): { width: number; height: number; auto: boolean } {
  const sizing = sizingOf(c);
  const auto = sizing.mode === "model";
  if (sizing.mode === "manual" && c.generation) {
    const match = /^(\d+)x(\d+)$/.exec(c.parameters.size ?? "");
    if (!match) throw new Error("Specify a valid frame size.");
    return { width: Number(match[1]), height: Number(match[2]), auto };
  }
  const output = c.renderSpec
    ? spriteOutputSize(c.renderSpec)
    : { width: c.width, height: c.height };
  const divisor = gcd(output.width, output.height),
    rw = output.width / divisor,
    rh = output.height / divisor;
  // Pixel art keeps whole logical pixels; every request edge is a multiple of 16.
  const step =
    c.renderSpec?.mode === "pixel" ? gcd(c.renderSpec.logicalWidth, c.renderSpec.logicalHeight) : 1;
  const base = (output.width * sizing.sourceScale) / rw;
  let fallback: { width: number; height: number } | null = null;
  for (let unit = Math.ceil(base / step) * step; ; unit += step) {
    const width = rw * unit,
      height = rh * unit;
    if (width > SPRITE_GIF_MAX_EDGE || height > SPRITE_GIF_MAX_EDGE) break;
    if (count * width * height < IMAGE_REQUEST_MIN_PIXELS) continue;
    fallback ??= { width, height };
    if (width % 16 === 0 && height % 16 === 0) return { width, height, auto };
  }
  if (fallback) return { ...fallback, auto };
  throw new Error(
    "This frame size exceeds GIF limits. Reduce the output frame size or source sampling.",
  );
}
/** Frames per GIF request, reduced until the combined sheet fits the pixel and edge limits. */
export function spriteGifSegmentFrames(c: SpritePlanConfiguration) {
  let frames = Math.min(
    IMAGE_GIF_FRAME_COUNT.max,
    Math.max(IMAGE_GIF_FRAME_COUNT.min, c.generation?.segmentFrames ?? SPRITE_GIF_SEGMENT_FRAMES),
  );
  for (; frames > IMAGE_GIF_FRAME_COUNT.min; frames--) {
    const { width, height } = spriteGifFrameSize(c, frames);
    if (
      frames * width * height <= SPRITE_REQUEST_MAX_PIXELS &&
      spriteGifSheetEdge(frames, width, height) <= SPRITE_GIF_MAX_EDGE
    )
      break;
  }
  return frames;
}
/** Even split without single-frame segments: 17 frames at 16 per request become 9 + 8. */
export function spriteGifSegments(total: number, max: number) {
  const count = Math.ceil(total / max),
    size = Math.floor(total / count),
    extra = total % count;
  let start = 0;
  return Array.from({ length: count }, (_, index) => {
    const frameCount = size + (index < extra ? 1 : 0);
    const segment = { frameStart: start, frameCount };
    start += frameCount;
    return segment;
  });
}
/** At most 8 frames per row keeps expanded GIF sheets within browser canvas limits. */
export function spriteGifGrid(frames: number) {
  const rows = Math.ceil(frames / 8);
  return { columns: Math.ceil(frames / rows), rows };
}
/**
 * Frames of one GIF laid out row by row. Returned frames beyond the planned count stay
 * available as unassigned cells.
 */
export function spriteGifLayout(
  actionId: string,
  start: number,
  planned: number,
  frames: number,
  frameWidth: number,
  frameHeight: number,
): SpriteTaskLayout {
  const { columns, rows } = spriteGifGrid(frames);
  return {
    width: frameWidth * columns,
    height: frameHeight * rows,
    columns,
    rows,
    cells: Array.from({ length: frames }, (_, i) => ({
      id: spriteCellId(actionId, start + i),
      actionId: i < planned ? actionId : null,
      frameIndex: i < planned ? start + i : null,
      x: (i % columns) * frameWidth,
      y: Math.floor(i / columns) * frameHeight,
      width: frameWidth,
      height: frameHeight,
    })),
  };
}
export function calculateSpriteLayout(
  c: SpritePlanConfiguration,
  action: SpritePlanAction,
  start: number,
  count: number,
): SpriteTaskLayout {
  if (!Number.isInteger(count) || count < 1 || count > IMAGE_GIF_FRAME_COUNT.max)
    throw new Error("A generation segment must contain 1–64 frames.");
  const output = c.renderSpec
    ? spriteOutputSize(c.renderSpec)
    : { width: c.width, height: c.height };
  if (output.width * output.height * count > 64_000_000)
    throw new Error("Frame processing capacity exceeded.");
  const { width, height } = spriteGifFrameSize(c, count);
  return spriteGifLayout(action.id, start, count, count, width, height);
}
