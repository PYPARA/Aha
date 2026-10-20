import type {
  SpriteEditDescription,
  SpriteSliceConfiguration,
  SpriteTaskLayout,
} from "./spriteAnimation";
import { spriteCellId } from "./spriteSizing";
type Edit = SpriteEditDescription;
/** The rows representation is an adapter only. New editing code exclusively changes `edit`. */
export function spriteEditFromSlice(slice: SpriteSliceConfiguration): Edit {
  if (slice.edit) return slice.edit;
  const cells: Edit["cells"][number][] = [];
  const ids = new Map<string, string>();
  const actions = slice.rows.map((row, ri) => ({
    action: { ...row.action, frameCount: Math.max(1, row.cells.filter((c) => c.enabled).length) },
    frames: row.cells.flatMap((c, ci) => {
      const key = JSON.stringify([c.x, c.y, c.width, c.height, c.originX ?? c.x, c.originY ?? c.y]);
      let cellId = ids.get(key);
      if (!cellId) {
        cellId = c.id ?? spriteCellId(`legacy-${ri}`, ci);
        ids.set(key, cellId);
        cells.push({
          id: cellId,
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          originX: c.originX ?? c.x,
          originY: c.originY ?? c.y,
          enabled: c.enabled,
        });
      }
      return c.enabled
        ? [
            {
              id: c.frameId ?? (c.id ? `frame-${c.id}` : `frame-${ri}-${ci}`),
              cellId,
              allowEmpty: c.allowEmpty,
              offsetX: c.offsetX ?? 0,
              offsetY: c.offsetY ?? 0,
              ...(c.durationMs ? { durationMs: c.durationMs } : {}),
            },
          ]
        : [];
    }),
  }));
  return {
    version: 1,
    cells,
    actions,
    common: {
      canvasWidth: slice.canvasWidth,
      canvasHeight: slice.canvasHeight,
      anchorX: slice.anchorX,
      anchorY: slice.anchorY,
      registration: slice.registration ?? { scale: 1, offsetX: 0, offsetY: 0 },
    },
  };
}
export function spriteSliceFromEdit(
  edit: Edit,
  base?: Pick<SpriteSliceConfiguration, "background" | "chromaKey">,
): SpriteSliceConfiguration {
  const cells = new Map(edit.cells.map((c) => [c.id, c]));
  const used = new Set(edit.actions.flatMap((g) => g.frames.map((f) => f.cellId)));
  return {
    ...base,
    edit,
    ...edit.common,
    reviewedActionIds: [],
    rows: edit.actions.map((group, index) => ({
      action: { ...group.action, frameCount: Math.max(1, group.frames.length) },
      cells: [
        ...group.frames.map((f) => {
          const cell = cells.get(f.cellId);
          if (!cell) throw new Error("A frame references a missing source cell.");
          return {
            ...cell,
            enabled: true,
            frameId: f.id,
            allowEmpty: f.allowEmpty,
            offsetX: f.offsetX,
            offsetY: f.offsetY,
            ...(f.durationMs ? { durationMs: f.durationMs } : {}),
          };
        }),
        ...(index === 0
          ? edit.cells
              .filter((c) => !used.has(c.id))
              .map((c) => Object.assign({}, c, { enabled: false }))
          : []),
      ],
    })),
  };
}
export function validateSpriteEdit(edit: Edit, width: number, height: number) {
  const c = edit.common;
  if (
    !edit.cells.length ||
    edit.cells.length > 1024 ||
    new Set(edit.cells.map((g) => g.id)).size !== edit.cells.length ||
    !edit.actions.length ||
    new Set(edit.actions.map((g) => g.action.id)).size !== edit.actions.length
  )
    throw new Error("Invalid source cells or action identities.");
  const ids = new Set(edit.cells.map((g) => g.id)),
    frameIds = new Set<string>();
  for (const g of edit.cells) {
    if (
      ![g.x, g.y, g.width, g.height].every(Number.isInteger) ||
      g.x < 0 ||
      g.y < 0 ||
      g.width < 1 ||
      g.height < 1 ||
      g.x + g.width > width ||
      g.y + g.height > height
    )
      throw new Error("Frame is outside its source image.");
    const x = c.anchorX + g.x - g.originX,
      y = c.anchorY + g.y - g.originY;
    if (
      ![x, y].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      x + g.width > c.canvasWidth ||
      y + g.height > c.canvasHeight
    )
      throw new Error("The shared canvas must contain every frame region.");
  }
  for (let i = 0; i < edit.cells.length; i++)
    for (let j = i + 1; j < edit.cells.length; j++) {
      const a = edit.cells[i]!,
        b = edit.cells[j]!;
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      )
        throw new Error("Source cells overlap. Reuse the same cell for repeated frames.");
    }
  for (const group of edit.actions) {
    if (!group.action.name.trim() || !group.frames.length || group.frames.length > 1024)
      throw new Error("Choose 1–1024 frames for each imported action.");
    for (const f of group.frames) {
      if (
        !ids.has(f.cellId) ||
        frameIds.has(f.id) ||
        ![f.offsetX, f.offsetY].every(Number.isFinite) ||
        (f.durationMs !== undefined && (!Number.isFinite(f.durationMs) || f.durationMs <= 0))
      )
        throw new Error("Invalid frame instance, correction or duration.");
      frameIds.add(f.id);
    }
  }
  if (edit.actions.reduce((n, a) => n + a.frames.length, 0) > 1024)
    throw new Error("At most 1024 frame instances can be processed together.");
}
/** Replace geometry while retaining surviving cell IDs and explicit frame mappings. */
export function spriteEditGrid(
  edit: Edit,
  layout: SpriteTaskLayout,
): { edit: Edit; removed: string[] } {
  const slots = layout.cells.map((g, i) => ({
    ...g,
    id: g.id ?? edit.cells[i]?.id ?? `cell-${i}`,
    originX: g.x,
    originY: g.y,
    enabled: g.actionId !== null,
  }));
  const keep = new Set(slots.map((g) => g.id)),
    removed = edit.cells.filter((g) => !keep.has(g.id)).map((g) => g.id);
  const used = new Set(edit.actions.flatMap((g) => g.frames.map((f) => f.cellId)));
  return {
    removed,
    edit: {
      ...edit,
      cells: slots,
      common: {
        ...edit.common,
        canvasWidth: Math.max(...slots.map((g) => g.width)),
        canvasHeight: Math.max(...slots.map((g) => g.height)),
        anchorX: 0,
        anchorY: 0,
      },
      actions: edit.actions.map((g, i) => ({
        ...g,
        frames: [
          ...g.frames.filter((f) => keep.has(f.cellId)),
          ...(i === 0
            ? slots
                .filter((c) => c.enabled && !used.has(c.id))
                .map((c) => ({ id: `frame-${c.id}`, cellId: c.id, offsetX: 0, offsetY: 0 }))
            : []),
        ],
      })),
    },
  };
}
export function spriteStationarySuggestions(edit: Edit, actionId: string, baselineFrameId: string) {
  const group = edit.actions.find((g) => g.action.id === actionId),
    base = group?.frames.find((f) => f.id === baselineFrameId);
  if (!base?.anchor?.confirmed) throw new Error("Confirm a baseline anchor first.");
  return group!.frames
    .filter((f) => f.anchor?.confirmed)
    .map((f) => ({
      id: f.id,
      offsetX: base.anchor!.x + base.offsetX - f.anchor!.x,
      offsetY: base.anchor!.y + base.offsetY - f.anchor!.y,
    }));
}
/** Transparent foreground heuristic only: support in the bottom body band, never pose recognition. */
export function spriteSupportAnchor(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
) {
  let bottom = -1,
    count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4 + 3]! > 24) {
        bottom = y;
        count++;
      }
  if (bottom < 0 || count > width * height * 0.9) return null;
  const xs: number[] = [];
  let touches = false;
  for (let y = Math.max(0, bottom - Math.max(1, Math.round(height * 0.03))); y <= bottom; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4 + 3]! > 24) {
        xs.push(x);
        if (x === 0 || x === width - 1 || y === height - 1) touches = true;
      }
  xs.sort((a, b) => a - b);
  if (!xs.length) return null;
  const unique = [...new Set(xs)];
  let regions = 1;
  for (let i = 1; i < unique.length; i++)
    if (unique[i]! - unique[i - 1]! > Math.max(2, width * 0.04)) regions++;
  return {
    x: xs[Math.floor(xs.length / 2)]!,
    y: bottom,
    confirmed: false,
    reliable: !touches && regions === 1,
  };
}
