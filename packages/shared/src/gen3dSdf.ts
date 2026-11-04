// Signed-distance modeling for the 3D generation sandbox worker: primitives, booleans and
// narrow-band Surface Nets meshing. Pure computation with no DOM, network or file access.

export type Vec3 = readonly [number, number, number];
/** Axis-aligned bounds: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Bounds = readonly [number, number, number, number, number, number];
export interface SdfShape {
  readonly f: (x: number, y: number, z: number) => number;
  readonly box: Bounds;
  /** A simpler shape that is exact inside `region`, or null when the region is entirely outside. */
  readonly prune: (region: Bounds) => SdfShape | null;
}

const { hypot, max, min, abs, sqrt } = Math;
const finite = (values: readonly number[], what: string) => {
  for (const v of values) if (!Number.isFinite(v)) throw new Error(`SDF ${what} must be finite.`);
};
const positive = (value: number, what: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`SDF ${what} must be positive.`);
};
const overlaps = (a: Bounds, b: Bounds) =>
  a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
const grow = (b: Bounds, d: number): Bounds => [
  b[0] - d,
  b[1] - d,
  b[2] - d,
  b[3] + d,
  b[4] + d,
  b[5] + d,
];
const leaf = (f: SdfShape["f"], box: Bounds): SdfShape => {
  const shape: SdfShape = { f, box, prune: (region) => (overlaps(box, region) ? shape : null) };
  return shape;
};

export const sphere = (c: Vec3, r: number) => {
  finite(c, "centre");
  positive(r, "radius");
  return leaf(
    (x, y, z) => hypot(x - c[0], y - c[1], z - c[2]) - r,
    [c[0] - r, c[1] - r, c[2] - r, c[0] + r, c[1] + r, c[2] + r],
  );
};

export const capsule = (a: Vec3, b: Vec3, r: number) => {
  finite([...a, ...b], "endpoints");
  positive(r, "radius");
  const bx = b[0] - a[0],
    by = b[1] - a[1],
    bz = b[2] - a[2];
  const bb = bx * bx + by * by + bz * bz || 1e-12;
  return leaf(
    (x, y, z) => {
      const px = x - a[0],
        py = y - a[1],
        pz = z - a[2];
      const t = max(0, min(1, (px * bx + py * by + pz * bz) / bb));
      return hypot(px - bx * t, py - by * t, pz - bz * t) - r;
    },
    [
      min(a[0], b[0]) - r,
      min(a[1], b[1]) - r,
      min(a[2], b[2]) - r,
      max(a[0], b[0]) + r,
      max(a[1], b[1]) + r,
      max(a[2], b[2]) + r,
    ],
  );
};

/** Capped cone between a and b with radii ra and rb (exact distance). */
export const cappedCone = (a: Vec3, b: Vec3, ra: number, rb: number) => {
  finite([...a, ...b, ra, rb], "cone");
  if (ra < 0 || rb < 0 || ra + rb <= 0) throw new Error("SDF cone radii must be non-negative.");
  const bax = b[0] - a[0],
    bay = b[1] - a[1],
    baz = b[2] - a[2];
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba <= 0) throw new Error("SDF cone endpoints must differ.");
  const rba = rb - ra,
    k = rba * rba + baba,
    r = max(ra, rb);
  return leaf(
    (x, y, z) => {
      const px = x - a[0],
        py = y - a[1],
        pz = z - a[2];
      const papa = px * px + py * py + pz * pz;
      const paba = (px * bax + py * bay + pz * baz) / baba;
      const rx = sqrt(max(0, papa - paba * paba * baba));
      const cax = max(0, rx - (paba < 0.5 ? ra : rb)),
        cay = abs(paba - 0.5) - 0.5;
      const f = max(0, min(1, (rba * (rx - ra) + paba * baba) / k));
      const cbx = rx - ra - f * rba,
        cby = paba - f;
      const s = cbx < 0 && cay < 0 ? -1 : 1;
      return s * sqrt(min(cax * cax + cay * cay * baba, cbx * cbx + cby * cby * baba));
    },
    [
      min(a[0], b[0]) - r,
      min(a[1], b[1]) - r,
      min(a[2], b[2]) - r,
      max(a[0], b[0]) + r,
      max(a[1], b[1]) + r,
      max(a[2], b[2]) + r,
    ],
  );
};
export const cylinder = (a: Vec3, b: Vec3, r: number) => cappedCone(a, b, r, r);

/** Axis-aligned box with rounded edges; `half` is the half size, `r` the edge radius. */
export const roundBox = (c: Vec3, half: Vec3, r = 0) => {
  finite([...c, ...half, r], "box");
  for (const h of half) positive(h, "box size");
  const radius = max(0, min(r, half[0], half[1], half[2]));
  return leaf(
    (x, y, z) => {
      const qx = abs(x - c[0]) - half[0] + radius,
        qy = abs(y - c[1]) - half[1] + radius,
        qz = abs(z - c[2]) - half[2] + radius;
      return hypot(max(qx, 0), max(qy, 0), max(qz, 0)) + min(max(qx, max(qy, qz)), 0) - radius;
    },
    [
      c[0] - half[0],
      c[1] - half[1],
      c[2] - half[2],
      c[0] + half[0],
      c[1] + half[1],
      c[2] + half[2],
    ],
  );
};

export const ellipsoid = (c: Vec3, radii: Vec3) => {
  finite(c, "centre");
  for (const r of radii) positive(r, "radius");
  return leaf(
    (x, y, z) => {
      const px = x - c[0],
        py = y - c[1],
        pz = z - c[2];
      const k0 = hypot(px / radii[0], py / radii[1], pz / radii[2]);
      const k1 = hypot(
        px / (radii[0] * radii[0]),
        py / (radii[1] * radii[1]),
        pz / (radii[2] * radii[2]),
      );
      return k1 === 0 ? -min(radii[0], radii[1], radii[2]) : (k0 * (k0 - 1)) / k1;
    },
    [
      c[0] - radii[0],
      c[1] - radii[1],
      c[2] - radii[2],
      c[0] + radii[0],
      c[1] + radii[1],
      c[2] + radii[2],
    ],
  );
};

/** Torus around the Y axis: ring radius R, tube radius r. */
export const torus = (c: Vec3, ringRadius: number, tubeRadius: number) => {
  finite(c, "centre");
  positive(ringRadius, "ring radius");
  positive(tubeRadius, "tube radius");
  const e = ringRadius + tubeRadius;
  return leaf(
    (x, y, z) => hypot(hypot(x - c[0], z - c[2]) - ringRadius, y - c[1]) - tubeRadius,
    [c[0] - e, c[1] - tubeRadius, c[2] - e, c[0] + e, c[1] + tubeRadius, c[2] + e],
  );
};

const smin = (a: number, b: number, k: number) => {
  const h = max(k - abs(a - b), 0) / k;
  return min(a, b) - h * h * k * 0.25;
};

export function smoothUnion(k: number, ...parts: SdfShape[]): SdfShape {
  if (!Number.isFinite(k) || k < 0) throw new Error("SDF smoothing radius must be non-negative.");
  if (!parts.length) throw new Error("SDF union needs at least one shape.");
  if (parts.length === 1) return parts[0]!;
  const box = parts.reduce<Bounds>(
    (b, p) => [
      min(b[0], p.box[0]),
      min(b[1], p.box[1]),
      min(b[2], p.box[2]),
      max(b[3], p.box[3]),
      max(b[4], p.box[4]),
      max(b[5], p.box[5]),
    ],
    [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
  );
  return {
    f: (x, y, z) => {
      let d = parts[0]!.f(x, y, z);
      for (let i = 1; i < parts.length; i++)
        d = k > 0 ? smin(d, parts[i]!.f(x, y, z), k) : min(d, parts[i]!.f(x, y, z));
      return d;
    },
    box,
    // Smoothing only blends shapes closer than k, so children further than k can be dropped.
    prune: (region) => {
      const kept = parts.map((p) => p.prune(grow(region, k))).filter((p): p is SdfShape => !!p);
      return kept.length ? smoothUnion(k, ...kept) : null;
    },
  };
}
export const union = (...parts: SdfShape[]) => smoothUnion(0, ...parts);

export function subtract(a: SdfShape, b: SdfShape): SdfShape {
  return {
    f: (x, y, z) => max(a.f(x, y, z), -b.f(x, y, z)),
    box: a.box,
    prune: (region) => {
      const pa = a.prune(region);
      if (!pa) return null;
      const pb = b.prune(region);
      return pb ? subtract(pa, pb) : pa;
    },
  };
}

export function intersect(a: SdfShape, b: SdfShape): SdfShape {
  const box: Bounds = [
    max(a.box[0], b.box[0]),
    max(a.box[1], b.box[1]),
    max(a.box[2], b.box[2]),
    min(a.box[3], b.box[3]),
    min(a.box[4], b.box[4]),
    min(a.box[5], b.box[5]),
  ];
  return {
    f: (x, y, z) => max(a.f(x, y, z), b.f(x, y, z)),
    box,
    prune: (region) => {
      const pa = a.prune(region),
        pb = b.prune(region);
      return pa && pb ? intersect(pa, pb) : null;
    },
  };
}

export const SDF_MAX_RESOLUTION = 256;
export interface SdfMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  grid: [number, number, number];
  cellSize: number;
}

/** Narrow-band Surface Nets. `resolution` is the cell count along the longest axis. */
export function meshSdf(shape: SdfShape, resolution = 128): SdfMesh {
  if (!Number.isInteger(resolution) || resolution < 16 || resolution > SDF_MAX_RESOLUTION)
    throw new Error(`SDF resolution must be an integer from 16 to ${SDF_MAX_RESOLUTION}.`);
  const b = shape.box;
  if (b.some((v) => !Number.isFinite(v)) || b[3] <= b[0] || b[4] <= b[1] || b[5] <= b[2])
    throw new Error("SDF shape has empty or invalid bounds.");
  const extent = max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  if (extent > 1000) throw new Error("SDF shape exceeds 1000 m.");
  const pad = 0.04 * extent;
  const lo = [b[0] - pad, b[1] - pad, b[2] - pad];
  const h = (extent + 2 * pad) / resolution;
  const nx = Math.ceil((b[3] - b[0] + 2 * pad) / h) + 1,
    ny = Math.ceil((b[4] - b[1] + 2 * pad) / h) + 1,
    nz = Math.ceil((b[5] - b[2] + 2 * pad) / h) + 1;
  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const block = 4,
    halfDiag = (block * h * sqrt(3)) / 2;
  for (let bk = 0; bk < nz; bk += block)
    for (let bj = 0; bj < ny; bj += block)
      for (let bi = 0; bi < nx; bi += block) {
        const ie = min(bi + block, nx - 1),
          je = min(bj + block, ny - 1),
          ke = min(bk + block, nz - 1);
        const region: Bounds = [
          lo[0]! + bi * h - h,
          lo[1]! + bj * h - h,
          lo[2]! + bk * h - h,
          lo[0]! + ie * h + h,
          lo[1]! + je * h + h,
          lo[2]! + ke * h + h,
        ];
        const local = shape.prune(region);
        const cx = lo[0]! + ((bi + ie) / 2) * h,
          cy = lo[1]! + ((bj + je) / 2) * h,
          cz = lo[2]! + ((bk + ke) / 2) * h;
        // Nothing reaches this block: it is outside every primitive.
        const dc = local ? local.f(cx, cy, cz) : halfDiag + 2 * h;
        // An SDF is 1-Lipschitz: a centre this far from the surface has no sign change in the block.
        const far = !local || abs(dc) > halfDiag + h;
        for (let k = bk; k <= ke; k++)
          for (let j = bj; j <= je; j++)
            for (let i = bi; i <= ie; i++)
              field[at(i, j, k)] = far
                ? dc
                : local!.f(lo[0]! + i * h, lo[1]! + j * h, lo[2]! + k * h);
      }
  const cells = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cat = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos: number[] = [];
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ] as const;
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const corner = corners[c]!;
          v[c] = field[at(i + corner[0], j + corner[1], k + corner[2])]!;
          if (v[c]! < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          count = 0;
        for (const [a, e] of edges) {
          if (v[a]! < 0 === v[e]! < 0) continue;
          const t = v[a]! / (v[a]! - v[e]!);
          const ca = corners[a],
            ce = corners[e];
          sx += ca[0] + t * (ce[0] - ca[0]);
          sy += ca[1] + t * (ce[1] - ca[1]);
          sz += ca[2] + t * (ce[2] - ca[2]);
          count++;
        }
        cells[cat(i, j, k)] = pos.length / 3;
        pos.push(
          lo[0]! + (i + sx / count) * h,
          lo[1]! + (j + sy / count) * h,
          lo[2]! + (k + sz / count) * h,
        );
        if (pos.length / 3 > 4_000_000) throw new Error("SDF mesh exceeds 4 million vertices.");
      }
  const idx: number[] = [];
  const quad = (a: number, b2: number, c: number, d: number, flip: boolean) => {
    if (flip) idx.push(a, c, b2, a, d, c);
    else idx.push(a, b2, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const inside = field[at(i, j, k)]! < 0;
        if (inside !== field[at(i + 1, j, k)]! < 0)
          quad(
            cells[cat(i, j - 1, k - 1)]!,
            cells[cat(i, j, k - 1)]!,
            cells[cat(i, j, k)]!,
            cells[cat(i, j - 1, k)]!,
            !inside,
          );
        if (inside !== field[at(i, j + 1, k)]! < 0)
          quad(
            cells[cat(i - 1, j, k - 1)]!,
            cells[cat(i - 1, j, k)]!,
            cells[cat(i, j, k)]!,
            cells[cat(i, j, k - 1)]!,
            !inside,
          );
        if (inside !== field[at(i, j, k + 1)]! < 0)
          quad(
            cells[cat(i - 1, j - 1, k)]!,
            cells[cat(i, j - 1, k)]!,
            cells[cat(i, j, k)]!,
            cells[cat(i - 1, j, k)]!,
            !inside,
          );
      }
  if (!idx.length) throw new Error("SDF shape produced no surface.");
  const positions = new Float32Array(pos);
  const normals = new Float32Array(positions.length);
  const e = h * 0.5;
  for (let p = 0; p < positions.length; p += 3) {
    const x = positions[p]!,
      y = positions[p + 1]!,
      z = positions[p + 2]!;
    const local = shape.prune([x - e, y - e, z - e, x + e, y + e, z + e]) ?? shape;
    const gx = local.f(x + e, y, z) - local.f(x - e, y, z),
      gy = local.f(x, y + e, z) - local.f(x, y - e, z),
      gz = local.f(x, y, z + e) - local.f(x, y, z - e);
    const l = hypot(gx, gy, gz) || 1;
    normals[p] = gx / l;
    normals[p + 1] = gy / l;
    normals[p + 2] = gz / l;
  }
  return { positions, normals, indices: new Uint32Array(idx), grid: [nx, ny, nz], cellSize: h };
}

/** Edges used by one face are open, by more than two are non-manifold. */
export function meshTopology(indices: ArrayLike<number>) {
  const count = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!,
        b = indices[t + ((e + 1) % 3)]!;
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  let boundaryEdges = 0,
    nonManifoldEdges = 0;
  for (const c of count.values()) {
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  return { boundaryEdges, nonManifoldEdges };
}

/** The library injected into generated source as `SDF`. */
export const SDF_LIBRARY = {
  sphere,
  capsule,
  cylinder,
  cappedCone,
  roundBox,
  ellipsoid,
  torus,
  smoothUnion,
  union,
  subtract,
  intersect,
} as const;
