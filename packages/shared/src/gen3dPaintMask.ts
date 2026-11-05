// A repaint mask painted on a model's surface in 3D: a coarse voxel grid over the model's bounds
// (glTF coordinates, metres). The viewer paints spheres into it and shows the cells at or above
// one half; the fixed texture script samples it the same way (trilinear, threshold 0.5) at every
// surface point a view render sees, so the 2D mask matches what was painted.

/** Cells along the longest side of the bounds; other sides keep the same cell size. */
export const PAINT_GRID_CELLS = 128;
/** Upper bound on cells along any side (the longest side plus padding). */
export const PAINT_GRID_MAX = 160;

export interface PaintGrid {
  /** Corner of cell (0, 0, 0). */
  min: [number, number, number];
  /** Opposite corner: min + dims × cell. */
  max: [number, number, number];
  /** Cells along x, y and z. */
  dims: [number, number, number];
  /** x fastest, then y, then z; 0–255. */
  data: Uint8Array;
}

type Vec3 = readonly [number, number, number] | readonly number[];

/** An empty grid covering the bounds plus one cell on every side. */
export function createPaintGrid(min: Vec3, max: Vec3, cells = PAINT_GRID_CELLS): PaintGrid {
  const size = [0, 1, 2].map((i) => Math.max(max[i]! - min[i]!, 1e-6));
  const cell = Math.max(...size) / cells;
  const dims = size.map((s) => Math.min(PAINT_GRID_MAX, Math.ceil(s / cell) + 2)) as [
    number,
    number,
    number,
  ];
  const start = [0, 1, 2].map(
    (i) => (min[i]! + max[i]!) / 2 - (dims[i]! * cell) / 2,
  ) as PaintGrid["min"];
  return {
    min: start,
    max: start.map((s, i) => s + dims[i]! * cell) as PaintGrid["max"],
    dims,
    data: new Uint8Array(dims[0] * dims[1] * dims[2]),
  };
}

export function paintGridCell(grid: Pick<PaintGrid, "min" | "max" | "dims">) {
  return (grid.max[0] - grid.min[0]) / grid.dims[0];
}

/**
 * Paints (or erases) a soft sphere: full inside 70 % of the radius, fading to nothing at the
 * radius, so the visible half-threshold edge sits at about 85 %. Returns whether anything changed.
 */
export function paintSphere(grid: PaintGrid, centre: Vec3, radius: number, erase = false) {
  const cell = paintGridCell(grid),
    [dx, dy] = grid.dims;
  const lo = [0, 1, 2].map((i) =>
    Math.max(0, Math.floor((centre[i]! - radius - grid.min[i]!) / cell)),
  );
  const hi = [0, 1, 2].map((i) =>
    Math.min(grid.dims[i]! - 1, Math.floor((centre[i]! + radius - grid.min[i]!) / cell)),
  );
  const inner = radius * 0.7;
  let changed = false;
  for (let z = lo[2]!; z <= hi[2]!; z++) {
    const pz = grid.min[2] + (z + 0.5) * cell - centre[2]!;
    for (let y = lo[1]!; y <= hi[1]!; y++) {
      const py = grid.min[1] + (y + 0.5) * cell - centre[1]!;
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        const px = grid.min[0] + (x + 0.5) * cell - centre[0]!;
        const d = Math.sqrt(px * px + py * py + pz * pz);
        if (d >= radius) continue;
        const t = d <= inner ? 1 : 1 - (d - inner) / (radius - inner);
        const value = Math.round(t * 255);
        const index = x + dx * (y + dy * z);
        const before = grid.data[index]!;
        const next = erase ? Math.min(before, 255 - value) : Math.max(before, value);
        if (next !== before) {
          grid.data[index] = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Trilinear value (0–1) at a point, with cell centres at min + (i + 0.5) × cell. */
export function samplePaintGrid(grid: PaintGrid, point: Vec3) {
  const cell = paintGridCell(grid),
    [dx, dy] = grid.dims;
  const f = [0, 1, 2].map((i) =>
    Math.min(Math.max((point[i]! - grid.min[i]!) / cell - 0.5, 0), grid.dims[i]! - 1),
  );
  const i0 = f.map(Math.floor),
    t = f.map((v, i) => v - i0[i]!);
  const i1 = i0.map((v, i) => Math.min(v + 1, grid.dims[i]! - 1));
  const at = (x: number, y: number, z: number) => grid.data[x + dx * (y + dy * z)]! / 255;
  let value = 0;
  for (const [cx, wx] of [
    [i0[0]!, 1 - t[0]!],
    [i1[0]!, t[0]!],
  ] as const)
    for (const [cy, wy] of [
      [i0[1]!, 1 - t[1]!],
      [i1[1]!, t[1]!],
    ] as const)
      for (const [cz, wz] of [
        [i0[2]!, 1 - t[2]!],
        [i1[2]!, t[2]!],
      ] as const)
        value += at(cx, cy, cz) * wx * wy * wz;
  return value;
}

/** Cells at or above the half threshold. */
export function paintedCells(grid: PaintGrid) {
  let count = 0;
  for (const value of grid.data) if (value >= 128) count++;
  return count;
}

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Run-length pairs (count 1–255, value), base64; a mostly empty grid becomes a few KB. */
export function encodePaintGrid(grid: PaintGrid) {
  const out: number[] = [];
  const { data } = grid;
  for (let i = 0; i < data.length; ) {
    const value = data[i]!;
    let run = 1;
    while (run < 255 && i + run < data.length && data[i + run] === value) run++;
    out.push(run, value);
    i += run;
  }
  return {
    min: [...grid.min] as PaintGrid["min"],
    max: [...grid.max] as PaintGrid["max"],
    dims: [...grid.dims] as PaintGrid["dims"],
    data: toBase64(Uint8Array.from(out)),
  };
}

export type EncodedPaintGrid = ReturnType<typeof encodePaintGrid>;

/** Decodes and checks an encoded grid; throws on anything malformed. */
export function decodePaintGrid(encoded: {
  min: readonly number[];
  max: readonly number[];
  dims: readonly number[];
  data: string;
}): PaintGrid {
  const dims = encoded.dims;
  if (
    dims.length !== 3 ||
    dims.some((d) => !Number.isInteger(d) || d < 1 || d > PAINT_GRID_MAX) ||
    encoded.min.length !== 3 ||
    encoded.max.length !== 3 ||
    [...encoded.min, ...encoded.max].some((v) => !Number.isFinite(v))
  )
    throw new Error("Invalid paint mask grid.");
  const cells = [0, 1, 2].map((i) => (encoded.max[i]! - encoded.min[i]!) / dims[i]!);
  if (cells.some((c) => !(c > 0)) || cells.some((c) => Math.abs(c - cells[0]!) > cells[0]! * 1e-3))
    throw new Error("The paint mask cells must be cubes.");
  const total = dims[0]! * dims[1]! * dims[2]!;
  const pairs = fromBase64(encoded.data);
  if (pairs.length % 2) throw new Error("Invalid paint mask data.");
  const data = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const run = pairs[i]!,
      value = pairs[i + 1]!;
    if (!run || offset + run > total) throw new Error("Invalid paint mask data.");
    if (value) data.fill(value, offset, offset + run);
    offset += run;
  }
  if (offset !== total) throw new Error("Invalid paint mask data.");
  return {
    min: [encoded.min[0]!, encoded.min[1]!, encoded.min[2]!],
    max: [encoded.max[0]!, encoded.max[1]!, encoded.max[2]!],
    dims: [dims[0]!, dims[1]!, dims[2]!],
    data,
  };
}
