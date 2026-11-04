// Reference blueprints and silhouette scoring for 3D generation. Pure pixel math shared by the
// desktop host (which decodes and encodes PNGs) and tests; no image codecs or file access here.

export const BLUEPRINT_SIZE = 256;
const W = BLUEPRINT_SIZE,
  H = BLUEPRINT_SIZE;
/** Ground line row in the blueprint frame. */
export const BLUEPRINT_GROUND = Math.round(H * 0.95);
export type BlueprintView = "front" | "side" | "back";
export const BLUEPRINT_VIEWS: readonly BlueprintView[] = ["front", "side", "back"];
export type Mask = Uint8Array;
export interface ColumnBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Splits a three-view sheet (front, side, back from left to right) into blueprint masks.
 * Background = near-white pixels connected to the border; enclosed light areas stay solid.
 */
export function extractBlueprint(rgb: Uint8Array, width: number, height: number) {
  if (rgb.length !== width * height * 3) throw new Error("Reference pixels do not match the size.");
  const light = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++)
    light[i] = Math.min(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!) > 236 ? 1 : 0;
  const background = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) stack.push(x, x + (height - 1) * width);
  for (let y = 0; y < height; y++) stack.push(y * width, width - 1 + y * width);
  while (stack.length) {
    const i = stack.pop()!;
    if (background[i] || !light[i]) continue;
    background[i] = 1;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) columns[x]! += background[x + y * width] ? 0 : 1;
  // Thin ground lines some sheets draw stay under this per-column threshold.
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    const on = x < width && columns[x]! > 6;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run[0] - last[1] < width * 0.02) last[1] = run[1];
    else merged.push([...run]);
  }
  const views = merged
    .toSorted((a, b) => b[1] - b[0] - (a[1] - a[0]))
    .slice(0, 3)
    .toSorted((a, b) => a[0] - b[0]);
  if (views.length !== 3)
    throw new Error(
      `The reference must show front, side and back views side by side; found ${views.length}.`,
    );
  const boxes = views.map(([x0, x1]) => {
    let y0 = height,
      y1 = 0;
    for (let y = 0; y < height; y++)
      for (let x = x0; x <= x1; x++)
        if (!background[x + y * width]) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    return { x0, x1, y0, y1 };
  }) as [ColumnBox, ColumnBox, ColumnBox];
  const widest = Math.max(...boxes.map((b) => b.x1 - b.x0 + 1));
  const tallest = Math.max(...boxes.map((b) => b.y1 - b.y0 + 1));
  // One scale for all views, fitting both the tallest and the widest view.
  const scale = Math.min((H * 0.9) / tallest, (W * 0.92) / widest);
  const masks = boxes.map((b) => {
    const mask = new Uint8Array(W * H);
    const cx = (b.x0 + b.x1) / 2;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const sx = Math.round(cx + (x - W / 2) / scale),
          sy = Math.round(b.y1 - (BLUEPRINT_GROUND - y) / scale);
        if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1 && !background[sx + sy * width])
          mask[x + y * W] = 1;
      }
    return mask;
  });
  const frontHeightPx = (boxes[0].y1 - boxes[0].y0 + 1) * scale;
  return {
    masks: { front: masks[0]!, side: masks[1]!, back: masks[2]! },
    boxes: { front: boxes[0], side: boxes[1], back: boxes[2] },
    /** Front view height in blueprint pixels; divide by the target height for px/m. */
    frontHeightPx,
  };
}

/**
 * Rasterizes an orthographic silhouette of world-space triangles (Y up, front facing +Z) at a
 * shared physical scale, bottom on the ground line and horizontally centred.
 */
export function rasterSilhouette(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  view: BlueprintView,
  pxPerMetre: number,
): Mask {
  const vertexCount = positions.length / 3;
  const u = new Float32Array(vertexCount),
    v = new Float32Array(vertexCount);
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!,
      y = positions[i * 3 + 1]!,
      z = positions[i * 3 + 2]!;
    // front: image right = +X; side: image right = -Z (the back); back: image right = -X.
    u[i] = view === "front" ? x : view === "side" ? -z : -x;
    v[i] = y;
    x0 = Math.min(x0, u[i]!);
    x1 = Math.max(x1, u[i]!);
    y0 = Math.min(y0, y);
  }
  const cx = (x0 + x1) / 2;
  for (let i = 0; i < vertexCount; i++) {
    u[i] = W / 2 + (u[i]! - cx) * pxPerMetre;
    v[i] = BLUEPRINT_GROUND - (v[i]! - y0) * pxPerMetre;
  }
  const mask = new Uint8Array(W * H);
  const triangles = indices ? indices.length / 3 : vertexCount / 3;
  for (let t = 0; t < triangles; t++) {
    const a = indices ? indices[t * 3]! : t * 3,
      b = indices ? indices[t * 3 + 1]! : t * 3 + 1,
      c = indices ? indices[t * 3 + 2]! : t * 3 + 2;
    const ax = u[a]!,
      ay = v[a]!,
      bx = u[b]!,
      by = v[b]!,
      cx2 = u[c]!,
      cy = v[c]!;
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx2 - ax) === 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2))),
      maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx2)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const w1 = (cx2 - bx) * (py - by) - (cy - by) * (px - bx);
        const w2 = (ax - cx2) * (py - cy) - (ay - cy) * (px - cx2);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) mask[x + y * W] = 1;
      }
  }
  return mask;
}

const shifted = (mask: Mask, dx: number, mirror: boolean) => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sx = x - dx;
      if (mirror) sx = W - 1 - sx;
      if (sx >= 0 && sx < W) out[x + y * W] = mask[sx + y * W]!;
    }
  return out;
};
const iouOf = (a: Mask, b: Mask) => {
  let inter = 0,
    union = 0;
  for (let i = 0; i < W * H; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 0;
};

/**
 * Horizontal registration: a local bulge must not shift the whole silhouette, so the shift with
 * the best IoU wins. Side views may face either way in references, so they also try a mirror.
 */
export function registerSilhouette(model: Mask, ref: Mask, allowMirror: boolean, range = 24) {
  let best = { dx: 0, mirrored: false, iou: -1, mask: model };
  for (const mirrored of allowMirror ? [false, true] : [false])
    for (let dx = -range; dx <= range; dx++) {
      const mask = shifted(model, dx, mirrored);
      const iou = iouOf(mask, ref);
      if (iou > best.iou) best = { dx, mirrored, iou, mask };
    }
  return best;
}

const boundary = (m: Mask) => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = x + y * W;
      if (!m[i]) continue;
      if (
        x === 0 ||
        y === 0 ||
        x === W - 1 ||
        y === H - 1 ||
        !m[i - 1] ||
        !m[i + 1] ||
        !m[i - W] ||
        !m[i + W]
      )
        out[i] = 1;
    }
  return out;
};
// Two-pass 3-4 chamfer distance transform to the nearest set pixel, in pixels.
const distanceTo = (m: Mask) => {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = m[i] ? 0 : 1e9;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = x + y * W;
      if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + 3);
      if (y > 0) d[i] = Math.min(d[i]!, d[i - W]! + 3);
      if (x > 0 && y > 0) d[i] = Math.min(d[i]!, d[i - W - 1]! + 4);
      if (x < W - 1 && y > 0) d[i] = Math.min(d[i]!, d[i - W + 1]! + 4);
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = x + y * W;
      if (x < W - 1) d[i] = Math.min(d[i]!, d[i + 1]! + 3);
      if (y < H - 1) d[i] = Math.min(d[i]!, d[i + W]! + 3);
      if (x < W - 1 && y < H - 1) d[i] = Math.min(d[i]!, d[i + W + 1]! + 4);
      if (x > 0 && y < H - 1) d[i] = Math.min(d[i]!, d[i + W - 1]! + 4);
    }
  for (let i = 0; i < W * H; i++) d[i] = d[i]! / 3;
  return d;
};
const components = (m: Mask, minPixels: number) => {
  const seen = new Uint8Array(W * H),
    out: { px: number; box: [number, number, number, number] }[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0,
      x0 = W,
      x1 = 0,
      y0 = H,
      y1 = 0;
    while (stack.length) {
      const i = stack.pop()!,
        x = i % W,
        y = (i / W) | 0;
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
        if (j >= 0 && j < W * H && m[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (n >= minPixels) out.push({ px: n, box: [x0, y0, x1, y1] });
  }
  return out.toSorted((a, b) => b.px - a.px);
};
const where = ([x0, y0, x1, y1]: readonly number[]) => {
  const cy = (y0! + y1!) / 2 / H,
    cx = (x0! + x1!) / 2 / W;
  return `${cy < 0.33 ? "top" : cy < 0.66 ? "middle" : "bottom"}-${cx < 0.4 ? "left" : cx > 0.6 ? "right" : "center"}`;
};

export interface ViewComparison {
  iou: number;
  /** Mean contour distance as a fraction of the object's blueprint height. */
  contour: number;
  regions: { kind: "extra" | "missing"; where: string; pct: number }[];
  extra: Mask;
  missing: Mask;
}
export function compareSilhouettes(model: Mask, ref: Mask): ViewComparison {
  let refPixels = 0;
  const extra = new Uint8Array(W * H),
    missing = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (ref[i]) refPixels++;
    if (model[i] && !ref[i]) extra[i] = 1;
    if (!model[i] && ref[i]) missing[i] = 1;
  }
  if (!refPixels) throw new Error("The blueprint view is empty.");
  const bm = boundary(model),
    br = boundary(ref);
  const dm = distanceTo(bm),
    dr = distanceTo(br);
  let sum = 0,
    n = 0;
  for (let i = 0; i < W * H; i++) {
    if (bm[i]) {
      sum += dr[i]!;
      n++;
    }
    if (br[i]) {
      sum += dm[i]!;
      n++;
    }
  }
  const regions = [
    ...components(extra, 12).map((c) => ({
      kind: "extra" as const,
      where: where(c.box),
      pct: +((c.px / refPixels) * 100).toFixed(1),
    })),
    ...components(missing, 12).map((c) => ({
      kind: "missing" as const,
      where: where(c.box),
      pct: +((c.px / refPixels) * 100).toFixed(1),
    })),
  ].toSorted((a, b) => b.pct - a.pct);
  return { iou: iouOf(model, ref), contour: n ? sum / n / (H * 0.9) : 1, regions, extra, missing };
}

/** Overall 0–100 score. Weak on its own; stopping uses the largest deviating region instead. */
export function silhouetteScore(views: readonly ViewComparison[]) {
  const iou = views.reduce((s, v) => s + v.iou, 0) / views.length;
  const contour = views.reduce((s, v) => s + v.contour, 0) / views.length;
  return Math.round(100 * (0.7 * iou + 0.3 * Math.max(0, 1 - contour / 0.04)));
}

/** RGB diff image: grey = match, orange = model extra, blue = model missing. */
export function diffPixels(model: Mask, ref: Mask, comparison: ViewComparison) {
  const px = new Uint8Array(W * H * 3).fill(12);
  for (let i = 0; i < W * H; i++) {
    const o = i * 3;
    if (model[i] && ref[i]) px.set([200, 200, 200], o);
    if (comparison.extra[i]) px.set([251, 146, 60], o);
    if (comparison.missing[i]) px.set([96, 165, 250], o);
  }
  for (let x = 0; x < W; x++) px.set([90, 90, 90], (x + BLUEPRINT_GROUND * W) * 3);
  return px;
}
export function maskPixels(mask: Mask) {
  const px = new Uint8Array(W * H * 3).fill(12);
  for (let i = 0; i < W * H; i++) if (mask[i]) px.set([220, 220, 220], i * 3);
  for (let x = 0; x < W; x++) px.set([90, 90, 90], (x + BLUEPRINT_GROUND * W) * 3);
  return px;
}
/** Reads a blueprint mask back from its grey/black PNG pixels. */
export function pixelsToMask(rgb: Uint8Array) {
  if (rgb.length !== W * H * 3) throw new Error("Blueprint image has the wrong size.");
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = rgb[i * 3]! > 150 ? 1 : 0;
  return mask;
}
