import type {
  SpritePlanAction,
  SpritePlanConfiguration,
  SpriteSizing,
  SpriteTaskLayout,
} from "./spriteAnimation";
import { spriteOutputSize } from "./spriteWorkflow";
import { IMAGE_REQUEST_MIN_PIXELS } from "./imageSize";
export const DEFAULT_SPRITE_SIZING: SpriteSizing = {
  version: 1,
  mode: "linked",
  sourceScale: 1,
  arrangement: "auto",
  margin: 0,
  gap: 0,
};
export const SPRITE_REQUEST_MAX_PIXELS = 8_294_400;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const hash = (text: string) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(36);
};
/** Stable within a source/processing branch; unrelated to physical row or column. */
export const spriteCellId = (actionId: string, index: number) => `cell-${hash(actionId)}-${index}`;
export function calculateSpriteLayout(
  c: SpritePlanConfiguration,
  action: SpritePlanAction,
  start: number,
  count: number,
): SpriteTaskLayout {
  const sizing = c.sizing ?? DEFAULT_SPRITE_SIZING;
  const output = c.renderSpec
    ? spriteOutputSize(c.renderSpec)
    : { width: c.width, height: c.height };
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw new Error("A generation segment must contain 1–8 frames.");
  if (output.width * output.height * count > 64_000_000)
    throw new Error("Frame processing capacity exceeded.");
  const aspect = gcd(output.width, output.height),
    rw = output.width / aspect,
    rh = output.height / aspect;
  const requested = sizing.mode === "model" ? "1024x1024" : c.parameters.size;
  const match = /^(\d+)x(\d+)$/.exec(requested ?? "");
  if (sizing.mode === "manual" && !match) throw new Error("Specify a valid whole image size.");
  type Choice = {
    width: number;
    height: number;
    columns: number;
    rows: number;
    cw: number;
    ch: number;
    score: number[];
  };
  const choices: Choice[] = [];
  const columnsList =
    sizing.arrangement === "fixed"
      ? [sizing.columns ?? 1]
      : Array.from({ length: count }, (_, i) => i + 1);
  for (const columns of columnsList) {
    const rows =
      sizing.arrangement === "fixed"
        ? (sizing.rows ?? Math.ceil(count / columns))
        : Math.ceil(count / columns);
    if (
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 1 ||
      rows < 1 ||
      columns * rows < count ||
      columns * rows > 1024
    )
      continue;
    let cw = output.width * sizing.sourceScale,
      ch = output.height * sizing.sourceScale;
    let width = columns * cw + (columns - 1) * sizing.gap + 2 * sizing.margin,
      height = rows * ch + (rows - 1) * sizing.gap + 2 * sizing.margin;
    if (sizing.mode === "linked" && width * height < IMAGE_REQUEST_MIN_PIXELS) {
      // Below the GPT Image pixel budget the request is rejected (2.6) or resized to another
      // ratio (2.x), breaking the layout. Enlarge source cells to the smallest size that fits,
      // keeping the frame ratio, whole logical pixels for pixel art and 16-pixel request edges.
      const step =
          c.renderSpec?.mode === "pixel"
            ? gcd(c.renderSpec.logicalWidth, c.renderSpec.logicalHeight)
            : 1,
        base = cw / rw;
      const sized = (unit: number) => ({
        w: columns * rw * unit + (columns - 1) * sizing.gap + 2 * sizing.margin,
        h: rows * rh * unit + (rows - 1) * sizing.gap + 2 * sizing.margin,
      });
      let fallback: number | null = null,
        chosen: number | null = null;
      for (
        let unit = Math.ceil(base / step) * step;
        unit <= base * 4 && chosen === null;
        unit += step
      ) {
        const { w, h } = sized(unit);
        if (w * h < IMAGE_REQUEST_MIN_PIXELS) continue;
        fallback ??= unit;
        if (w % 16 === 0 && h % 16 === 0) chosen = unit;
      }
      const unit = chosen ?? fallback;
      if (unit !== null) {
        cw = rw * unit;
        ch = rh * unit;
        ({ w: width, h: height } = sized(unit));
      }
    }
    if (sizing.mode !== "linked") {
      width = match ? Number(match[1]) : 1024;
      height = match ? Number(match[2]) : 1024;
      const unit = Math.floor(
        Math.min(
          (width - 2 * sizing.margin - (columns - 1) * sizing.gap) / (columns * rw),
          (height - 2 * sizing.margin - (rows - 1) * sizing.gap) / (rows * rh),
        ),
      );
      cw = rw * unit;
      ch = rh * unit;
    }
    if (
      cw < 1 ||
      ch < 1 ||
      width > 4096 ||
      height > 4096 ||
      width * height > SPRITE_REQUEST_MAX_PIXELS
    )
      continue;
    const ratio = Math.log2(width / height),
      empty = columns * rows - count;
    const score =
      sizing.mode === "linked"
        ? [Math.max(0, Math.abs(ratio) - 1), empty, Math.abs(ratio), width < height ? 1 : 0]
        : [(-count * cw * ch) / (width * height), empty, Math.abs(ratio), width < height ? 1 : 0];
    choices.push({ width, height, columns, rows, cw, ch, score });
  }
  choices.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      const diff = a.score[i]! - b.score[i]!;
      if (Math.abs(diff) > 1e-10) return diff;
    }
    return 0;
  });
  const selected = choices[0];
  if (!selected)
    throw new Error(
      "This frame size and layout exceed image or processing limits. Adjust the frame size, sampling or layout.",
    );
  const { width, height, columns, rows, cw, ch } = selected;
  const left = Math.floor((width - columns * cw - (columns - 1) * sizing.gap) / 2),
    top = Math.floor((height - rows * ch - (rows - 1) * sizing.gap) / 2);
  return {
    width,
    height,
    columns,
    rows,
    cells: Array.from({ length: columns * rows }, (_, i) => ({
      id: spriteCellId(action.id, start + i),
      actionId: i < count ? action.id : null,
      frameIndex: i < count ? start + i : null,
      x: left + (i % columns) * (cw + sizing.gap),
      y: top + Math.floor(i / columns) * (ch + sizing.gap),
      width: cw,
      height: ch,
    })),
  };
}
