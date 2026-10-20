import { calculateSpriteLayout } from "./spriteSizing";
import type {
  SpritePlanAction,
  SpritePlanConfiguration,
  SpriteRenderSpec,
  SpriteSliceConfiguration,
  SpriteTaskLayout,
  SpriteCanonicalReference,
} from "./spriteAnimation";

export const DEFAULT_SPRITE_RENDER_SPEC: SpriteRenderSpec = {
  mode: "pixel",
  logicalWidth: 64,
  logicalHeight: 64,
  outputScale: 4,
};
/** Defaults for creation are separate from the pixel fallback used to read old projects. */
export const NEW_SPRITE_RENDER_SPEC: SpriteRenderSpec = {
  mode: "illustration",
  logicalWidth: 256,
  logicalHeight: 256,
  outputScale: 1,
};
export function spriteGenerationReference(reference: SpriteCanonicalReference) {
  return reference.generationReference ?? reference.asset;
}
export function spritePlanTarget(c: SpritePlanConfiguration): string {
  return c.kind === "character"
    ? "character"
    : `animation:${c.actions
        .filter((a) => a.enabled)
        .map((a) => a.id)
        .toSorted()
        .join(",")}`;
}
export function spriteOutputSize(spec: SpriteRenderSpec) {
  if (
    ![spec.logicalWidth, spec.logicalHeight, spec.outputScale].every(
      (n) => Number.isInteger(n) && n > 0,
    ) ||
    (spec.mode === "illustration" && spec.outputScale !== 1) ||
    spec.logicalWidth * spec.outputScale > 4096 ||
    spec.logicalHeight * spec.outputScale > 4096
  )
    throw new Error("Invalid sprite render specification.");
  return {
    width: spec.logicalWidth * spec.outputScale,
    height: spec.logicalHeight * spec.outputScale,
  };
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Layout is independent of action grouping. Fixed sizes keep square/equal-ratio cells inside the image. */
export function spriteSegmentLayout(
  c: SpritePlanConfiguration,
  action: SpritePlanAction,
  start: number,
  count: number,
): SpriteTaskLayout {
  if (c.sizing) return calculateSpriteLayout(c, action, start, count);
  const spec = c.renderSpec;
  const fw = spec?.logicalWidth ?? c.width,
    fh = spec?.logicalHeight ?? c.height;
  const divisor = gcd(fw, fh),
    rw = fw / divisor,
    rh = fh / divisor;
  // Capability declarations are legacy data. The user configures this request's size.
  const requested =
    c.parameters.size && c.parameters.size !== "auto" ? c.parameters.size : "1024x1024";
  const fixed = [requested];
  type Choice = {
    width: number;
    height: number;
    columns: number;
    rows: number;
    cw: number;
    ch: number;
    score: number;
  };
  const choices: Choice[] = [];
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    {
      for (const size of fixed) {
        const match = /^(\d+)x(\d+)$/.exec(size ?? "");
        if (!match) continue;
        const width = Number(match[1]),
          height = Number(match[2]);
        if (width > 4096 || height > 4096 || width * height > 8294400) continue;
        const unit = Math.floor(Math.min(width / (columns * rw), height / (rows * rh)) / 16) * 16;
        if (unit < 1) continue;
        const cw = rw * unit,
          ch = rh * unit;
        choices.push({
          width,
          height,
          columns,
          rows,
          cw,
          ch,
          score:
            -((count * cw * ch) / (width * height)) * 1000 +
            (columns * rows - count) +
            (columns < rows ? 0.01 : 0),
        });
      }
    }
  }
  const selected = choices.toSorted((a, b) => a.score - b.score)[0];
  if (!selected) throw new Error("No supported image size can contain this sprite layout.");
  const { width, height, columns, rows, cw, ch } = selected;
  const left = Math.floor((width - columns * cw) / 2),
    top = Math.floor((height - rows * ch) / 2);
  return {
    width,
    height,
    columns,
    rows,
    cells: Array.from({ length: columns * rows }, (_, i) => ({
      actionId: i < count ? action.id : null,
      frameIndex: i < count ? start + i : null,
      x: left + (i % columns) * cw,
      y: top + Math.floor(i / columns) * ch,
      width: cw,
      height: ch,
    })),
  };
}

export function spriteWorkflowTasks(c: SpritePlanConfiguration): SpritePlanConfiguration[] {
  const result: SpritePlanConfiguration[] = [];
  for (const action of c.actions.filter((a) => a.enabled)) {
    const count = Math.ceil(action.frameCount / 8);
    for (let index = 0; index < count; index++) {
      const frameStart = index * 8,
        frameCount = Math.min(8, action.frameCount - frameStart);
      const layout = spriteSegmentLayout(c, action, frameStart, frameCount);
      result.push({
        ...c,
        mode: "separate",
        actions: [{ ...action, frameCount }],
        segment: {
          actionId: action.id,
          frameStart,
          frameCount,
          totalFrames: action.frameCount,
          index,
          count,
        },
        layout,
        parameters: {
          ...c.parameters,
          n: 1,
          size:
            c.sizing?.mode === "model" || (!c.sizing && c.sizeSource === "auto")
              ? "auto"
              : `${layout.width}x${layout.height}`,
        },
        references: c.references.filter((r) => !r.actionId || r.actionId === action.id),
      });
    }
  }
  return result;
}

export function spriteTaskSlice(
  layout: SpriteTaskLayout,
  actions: readonly SpritePlanAction[],
  width = layout.width,
  height = layout.height,
): SpriteSliceConfiguration {
  const sx = width / layout.width,
    sy = height / layout.height;
  const cells = layout.cells.map((c) => {
    const x = Math.round(c.x * sx),
      y = Math.round(c.y * sy);
    return {
      ...c,
      x,
      y,
      width: Math.max(1, Math.round((c.x + c.width) * sx) - x),
      height: Math.max(1, Math.round((c.y + c.height) * sy) - y),
      originX: x,
      originY: y,
      enabled: c.actionId !== null,
    };
  });
  return {
    rows: actions.map((action) => ({
      action,
      cells: cells.filter(
        (c) => c.actionId === action.id || (c.actionId === null && action === actions[0]),
      ),
    })),
    canvasWidth: Math.max(...cells.map((c) => c.width)),
    canvasHeight: Math.max(...cells.map((c) => c.height)),
    anchorX: 0,
    anchorY: 0,
    reviewedActionIds: [],
    registration: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}

export function spriteTaskGuideSvg(layout: SpriteTaskLayout, pivotY = 0.9) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}"><rect width="100%" height="100%" fill="#ffffff"/>${layout.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" fill="${c.actionId ? "#ffffff" : "#d1d5db"}" stroke="#888888"/><rect x="${c.x + c.width * 0.1}" y="${c.y + c.height * 0.1}" width="${c.width * 0.8}" height="${c.height * 0.8}" fill="none" stroke="#bbbbbb" stroke-dasharray="8 8"/><path d="M${c.x + c.width * 0.1},${c.y + c.height * pivotY}H${c.x + c.width * 0.9}" stroke="#aaaaaa"/>`).join("")}</svg>`;
}
