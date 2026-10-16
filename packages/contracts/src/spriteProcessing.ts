import type {
  SpritePlanAction,
  SpriteSliceConfiguration,
  SpriteLayoutIssue,
  SpriteCandidate,
} from "./spriteAnimation";
export const SPRITE_ANALYSIS_VERSION = "layout-1";
export function spriteBoundaries(length: number, count: number, start = 0): number[] {
  if (![length, count, start].every(Number.isInteger) || count < 1 || length < count || start < 0)
    throw new Error("Invalid grid dimensions.");
  return Array.from({ length: count + 1 }, (_, i) => start + Math.floor((i * length) / count));
}
export function spriteGridSlice(
  width: number,
  height: number,
  actions: readonly SpritePlanAction[],
): SpriteSliceConfiguration {
  const columns = Math.max(1, ...actions.map((a) => a.frameCount));
  const xs = spriteBoundaries(width, columns),
    ys = spriteBoundaries(height, actions.length);
  return {
    rows: actions.map((action, row) => ({
      action,
      cells: xs.slice(0, -1).map((x, i) => ({
        x,
        y: ys[row]!,
        width: xs[i + 1]! - x,
        height: ys[row + 1]! - ys[row]!,
        enabled: i < action.frameCount,
      })),
    })),
    canvasWidth: Math.max(...xs.slice(1).map((x, i) => x - xs[i]!)),
    canvasHeight: Math.max(...ys.slice(1).map((y, i) => y - ys[i]!)),
    anchorX: 0,
    anchorY: 0,
    reviewedActionIds: [],
  };
}
export function validateSpriteSlice(
  slice: SpriteSliceConfiguration,
  width: number,
  height: number,
) {
  const cells = slice.rows.flatMap((r) => r.cells);
  if (
    !slice.rows.length ||
    cells.length > 1024 ||
    new Set(slice.rows.map((r) => r.action.id)).size !== slice.rows.length
  )
    throw new Error("Invalid slicing rows.");
  for (const row of slice.rows) {
    const valid = row.cells.filter((c) => c.enabled);
    if (!row.action.name.trim() || valid.length < 1 || valid.length > 32)
      throw new Error("Choose 1–32 frames for each action.");
    for (const c of row.cells)
      if (
        ![c.x, c.y, c.width, c.height].every(Number.isInteger) ||
        c.x < 0 ||
        c.y < 0 ||
        c.width < 1 ||
        c.height < 1 ||
        c.x + c.width > width ||
        c.y + c.height > height
      )
        throw new Error("Frame is outside its source image.");
  }
  const active = cells.filter((c) => c.enabled);
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!,
        b = active[j]!;
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      )
        throw new Error("Frame regions overlap. Adjust their boundaries.");
    }
  if (
    slice.canvasWidth < Math.max(...cells.map((c) => c.width)) ||
    slice.canvasHeight < Math.max(...cells.map((c) => c.height)) ||
    slice.anchorX < 0 ||
    slice.anchorY < 0
  )
    throw new Error("The shared canvas must contain every frame region.");
  if (
    slice.anchorX + Math.max(...cells.map((c) => c.width)) > slice.canvasWidth ||
    slice.anchorY + Math.max(...cells.map((c) => c.height)) > slice.canvasHeight
  )
    throw new Error("The shared anchor falls outside the canvas.");
}
export function spriteBlockedActions(candidate: SpriteCandidate): Set<string> {
  const reviewed = new Set(candidate.slice?.reviewedActionIds ?? []);
  const actionIds = new Set(candidate.actions.map((a) => a.action.id));
  return new Set(
    (candidate.issues ?? [])
      .filter(
        (i) =>
          i.severity === "error" &&
          (!i.actionId || (actionIds.has(i.actionId) && !reviewed.has(i.actionId))),
      )
      .flatMap((i) =>
        i.actionId
          ? [i.actionId]
          : (candidate.actions ?? [])
              .filter((a) => !reviewed.has(a.action.id))
              .map((a) => a.action.id),
      ),
  );
}
export function spriteIssue(
  code: string,
  message: string,
  actionId: string | null = null,
  frameIndex: number | null = null,
  severity: "error" | "warning" = "error",
): SpriteLayoutIssue {
  return { code, message, actionId, frameIndex, severity };
}
