import {
  calculateSpriteLayout,
  spriteGifFrameDuration,
  spriteGifFrameSize,
  spriteGifSegmentFrames,
  spriteGifSegments,
} from "./spriteSizing";
import type {
  SpritePlanAction,
  SpritePlanConfiguration,
  SpriteRenderSpec,
  SpriteSliceConfiguration,
  SpriteTaskLayout,
  SpriteCanonicalReference,
  SpriteTaskSegment,
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
/** One row of GIF frames; layout is independent of action grouping. */
export function spriteSegmentLayout(
  c: SpritePlanConfiguration,
  action: SpritePlanAction,
  start: number,
  count: number,
): SpriteTaskLayout {
  return calculateSpriteLayout(c, action, start, count);
}

/** The single source of a GIF task's geometry and request parameters, for plans and segments. */
export function spriteGifTask(
  c: SpritePlanConfiguration,
  action: SpritePlanAction,
  segment: SpriteTaskSegment,
): SpritePlanConfiguration {
  const layout = spriteSegmentLayout(c, action, segment.frameStart, segment.frameCount);
  const frame = spriteGifFrameSize(c, segment.frameCount);
  return {
    ...c,
    generation: c.generation ?? { version: 1 },
    mode: "separate",
    actions: [{ ...action, frameCount: segment.frameCount }],
    segment,
    layout,
    parameters: {
      ...c.parameters,
      n: 1,
      size: frame.auto ? "auto" : `${frame.width}x${frame.height}`,
      outputFormat: "gif",
      frameCount: segment.frameCount,
      frameDurationMs: spriteGifFrameDuration(action.fps),
    },
    references: c.references.filter((r) => !r.actionId || r.actionId === action.id),
  };
}

export function spriteWorkflowTasks(c: SpritePlanConfiguration): SpritePlanConfiguration[] {
  const result: SpritePlanConfiguration[] = [];
  const max = spriteGifSegmentFrames(c);
  for (const action of c.actions.filter((a) => a.enabled)) {
    const segments = spriteGifSegments(action.frameCount, max);
    segments.forEach(({ frameStart, frameCount }, index) =>
      result.push(
        spriteGifTask(c, action, {
          actionId: action.id,
          frameStart,
          frameCount,
          totalFrames: action.frameCount,
          index,
          count: segments.length,
        }),
      ),
    );
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
