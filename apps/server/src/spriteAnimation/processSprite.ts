import sharp from "sharp";
import {
  spriteLayoutGuideSvg,
  spriteGridSlice,
  validateSpriteSlice,
  spriteIssue,
  SPRITE_ANALYSIS_VERSION,
} from "@synara/contracts";
import type {
  SpriteContext,
  SpritePlanAction,
  SpriteSliceConfiguration,
  SpriteLayoutAnalysis,
} from "@synara/contracts";

async function foreground(bytes: Uint8Array, context: SpriteContext) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 64_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const key = [1, 3, 5].map((i) => parseInt(context.chromaKey.slice(i, i + 2), 16));
  const transparent = data.some((value, i) => i % 4 === 3 && value < 255);
  if (!transparent && context.background === "chroma")
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.sqrt(
        key.reduce((sum, channel, j) => sum + (data[i + j]! - channel) ** 2, 0),
      );
      const alpha = Math.max(0, Math.min(1, (distance - 36) / 64));
      data[i + 3] = Math.round(alpha * 255);
      for (let j = 0; j < 3; j++)
        data[i + j] = alpha
          ? Math.round(Math.max(0, Math.min(255, (data[i + j]! - (1 - alpha) * key[j]!) / alpha)))
          : 0;
    }
  return { data, info, opaque: !transparent && context.background === "transparent" };
}
function bands(values: number[], min: number): [number, number][] {
  const groups: [number, number][] = [];
  let start = -1,
    last = -1;
  for (let i = 0; i <= values.length + 3; i++) {
    if ((values[i] ?? 0) > 0) {
      if (start < 0) start = i;
      last = i;
    }
    if (start >= 0 && i - last > 3) {
      if (last - start + 1 >= min) groups.push([start, last + 1]);
      start = -1;
    }
  }
  return groups;
}
const median = (v: number[]) => v.toSorted((a, b) => a - b)[Math.floor(v.length / 2)] ?? 1;
/** Detection suggests boundaries only; the original plan remains authoritative until reviewed. */
export async function analyzeSprite(
  bytes: Uint8Array,
  context: SpriteContext,
  actions: readonly SpritePlanAction[],
  sourceId: string,
): Promise<SpriteLayoutAnalysis> {
  const { data, info, opaque } = await foreground(bytes, context);
  const ys = Array.from({ length: info.height }, () => 0);
  let minX = info.width,
    maxX = -1,
    minY = info.height,
    maxY = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3]! > 24) {
        ys[y]!++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const yBands = bands(ys, Math.max(4, Math.floor(info.height / 300)));
  const xBands = yBands.map(([top, bottom]) => {
    const xs = Array.from({ length: info.width }, () => 0);
    for (let y = top; y < bottom; y++)
      for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3]! > 24) xs[x]!++;
    return bands(xs, Math.max(3, Math.floor(info.width / 400)));
  });
  const reliable =
    !opaque &&
    yBands.length === actions.length &&
    xBands.every((b) => b.length >= 1 && b.length <= 32);
  let suggestion = spriteGridSlice(info.width, info.height, actions);
  const issues = [];
  if (opaque)
    issues.push(
      spriteIssue(
        "transparency",
        "Expected transparency was not present; adjust background processing.",
      ),
    );
  if (
    maxX >= 0 &&
    (info.width - 1 - maxX > info.width * 0.18 ||
      minX > info.width * 0.18 ||
      minY > info.height * 0.18 ||
      info.height - 1 - maxY > info.height * 0.18)
  )
    issues.push(
      spriteIssue("outer-space", "Large transparent margins do not match the planned grid."),
    );
  if (reliable) {
    const centers = yBands.map(([a, b]) => (a + b) / 2),
      pitchY = median(centers.slice(1).map((c, i) => c - centers[i]!));
    const yEdges = [
      Math.max(0, Math.floor(Math.min(yBands[0]![0], centers[0]! - pitchY / 2))),
      ...centers.slice(1).map((c, i) => Math.floor((yBands[i]![1] + yBands[i + 1]![0]) / 2)),
      Math.min(info.height, Math.ceil(Math.max(yBands.at(-1)![1], centers.at(-1)! + pitchY / 2))),
    ];
    const pitches = xBands.flatMap((row) =>
      row.slice(1).map((b, i) => (b[0] + b[1] - row[i]![0] - row[i]![1]) / 2),
    );
    const pitchX = median(pitches.length ? pitches : [Math.max(1, maxX - minX + 1)]);
    const rows = actions.map((action, row) => {
      const b = xBands[row]!;
      const edges = [
        Math.max(0, Math.floor(b[0]![0] - (pitchX - (b[0]![1] - b[0]![0])) / 2)),
        ...b.slice(1).map((v, i) => Math.floor((b[i]![1] + v[0]) / 2)),
        Math.min(
          info.width,
          Math.ceil(b.at(-1)![1] + (pitchX - (b.at(-1)![1] - b.at(-1)![0])) / 2),
        ),
      ];
      if (b.length !== action.frameCount)
        issues.push(
          spriteIssue(
            "frame-count",
            `Detected ${b.length} possible subjects; the plan requests ${action.frameCount} frames.`,
            action.id,
          ),
        );
      return {
        action: { ...action, frameCount: b.length },
        cells: b.map((_, i) => ({
          x: edges[i]!,
          y: yEdges[row]!,
          width: edges[i + 1]! - edges[i]!,
          height: yEdges[row + 1]! - yEdges[row]!,
          enabled: true,
        })),
      };
    });
    suggestion = {
      rows,
      canvasWidth: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.width))),
      canvasHeight: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.height))),
      anchorX: 0,
      anchorY: 0,
      reviewedActionIds: [],
    };
  } else
    issues.push(
      spriteIssue(
        "uncertain-layout",
        "The content layout could not be reliably identified. Review frame boundaries manually.",
      ),
    );
  const grid = spriteGridSlice(info.width, info.height, actions);
  let nonEmptyCells = 0;
  for (const row of grid.rows)
    for (const c of row.cells.filter((c) => c.enabled)) {
      let occupied = false;
      for (let y = c.y; y < c.y + c.height && !occupied; y++)
        for (let x = c.x; x < c.x + c.width; x++)
          if (data[(y * info.width + x) * 4 + 3]! > 24) {
            occupied = true;
            break;
          }
      if (occupied) nonEmptyCells++;
    }
  return {
    algorithmVersion: SPRITE_ANALYSIS_VERSION,
    sourceId,
    width: info.width,
    height: info.height,
    plannedFrames: actions.reduce((n, a) => n + a.frameCount, 0),
    cells: grid.rows.reduce((n, r) => n + r.cells.length, 0),
    nonEmptyCells,
    suspectedSubjects: reliable ? xBands.reduce((n, r) => n + r.length, 0) : null,
    reliable,
    issues,
    suggestion,
  };
}
/** Every frame uses the same canvas transform. No per-frame content cropping or centering. */
export async function processSprite(
  bytes: Uint8Array,
  context: SpriteContext,
  actions?: readonly SpritePlanAction[],
  slice?: SpriteSliceConfiguration,
) {
  const { data, info, opaque } = await foreground(bytes, context);
  const descriptors = actions ?? [
    {
      id: "legacy",
      name: context.action,
      description: "",
      enabled: true,
      frameCount: context.frameCount,
      fps: context.fps,
      loop: true,
    },
  ];
  const configuration = slice ?? spriteGridSlice(info.width, info.height, descriptors);
  validateSpriteSlice(configuration, info.width, info.height);
  if (
    context.width *
      context.height *
      configuration.rows.reduce((n, r) => n + r.cells.filter((c) => c.enabled).length, 0) >
    64_000_000
  )
    throw new Error("Generated frames exceed 64 megapixels.");
  const warnings: string[] = [],
    issues = [];
  if (opaque) {
    warnings.push("Expected transparency was not present; adjust background processing.");
    issues.push(spriteIssue("transparency", warnings[0]!));
  }
  const frames: Uint8Array[] = [],
    outputs = [];
  const scale = Math.min(
    context.width / configuration.canvasWidth,
    context.height / configuration.canvasHeight,
  );
  if (Math.abs(scale - Math.round(scale)) > 0.001)
    issues.push(
      spriteIssue(
        "fractional-scale",
        "Frames use a non-integer pixel scaling factor.",
        null,
        null,
        "warning",
      ),
    );
  const targetW = Math.max(1, Math.round(configuration.canvasWidth * scale)),
    targetH = Math.max(1, Math.round(configuration.canvasHeight * scale));
  for (const row of configuration.rows) {
    const rowWarnings: string[] = [];
    const rowFrames: Uint8Array[] = [];
    let previous: Buffer | undefined;
    let index = 0;
    for (const c of row.cells) {
      const raw = await sharp(data, { raw: info })
        .extract({ left: c.x, top: c.y, width: c.width, height: c.height })
        .raw()
        .toBuffer();
      let occupied = 0,
        edge = 0;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          if (raw[(y * c.width + x) * 4 + 3]! > 24) {
            occupied++;
            if (x === 0 || y === 0 || x === c.width - 1 || y === c.height - 1) edge++;
          }
      if (!c.enabled) {
        if (occupied) {
          const message = `Row ${configuration.rows.indexOf(row) + 1}, unused cell ${index + 1} contains artwork.`;
          rowWarnings.push(message);
          issues.push(spriteIssue("unused-content", message, row.action.id, index));
        }
        continue;
      }
      const warn = (code: string, message: string, severity: "error" | "warning" = "error") => {
        rowWarnings.push(message);
        issues.push(spriteIssue(code, message, row.action.id, index, severity));
      };
      if (!occupied) warn("empty", `Frame ${index + 1} is empty.`);
      if (edge > 2)
        warn(
          "boundary",
          `Frame ${index + 1} touches its cell boundary; check clipping or overlapping poses.`,
        );
      if (occupied > c.width * c.height * 0.95)
        warn("background", `Frame ${index + 1} may contain an unremoved background.`);
      const canvas = await sharp(raw, { raw: { width: c.width, height: c.height, channels: 4 } })
        .extend({
          left: Math.floor(configuration.anchorX),
          top: Math.floor(configuration.anchorY),
          right: configuration.canvasWidth - c.width - Math.floor(configuration.anchorX),
          bottom: configuration.canvasHeight - c.height - Math.floor(configuration.anchorY),
          background: "#00000000",
        })
        .resize(targetW, targetH, { kernel: "nearest" })
        .extend({
          left: Math.floor((context.width - targetW) / 2),
          right: Math.ceil((context.width - targetW) / 2),
          top: Math.floor((context.height - targetH) / 2),
          bottom: Math.ceil((context.height - targetH) / 2),
          background: "#00000000",
        })
        .png()
        .toBuffer();
      const thumbnail = await sharp(canvas).resize(24, 24, { kernel: "nearest" }).raw().toBuffer();
      if (previous && previous.length === thumbnail.length) {
        let delta = 0;
        for (let i = 0; i < thumbnail.length; i++) delta += Math.abs(thumbnail[i]! - previous[i]!);
        if (delta / thumbnail.length < 1.5)
          warn("duplicate", `Frames ${index} and ${index + 1} are almost identical.`, "warning");
      }
      previous = thumbnail;
      rowFrames.push(canvas);
      frames.push(canvas);
      index++;
    }
    warnings.push(...rowWarnings);
    outputs.push({
      action: { ...row.action, frameCount: rowFrames.length },
      frames: rowFrames,
      warnings: rowWarnings,
    });
  }
  return { frames, warnings, issues, configuration, actions: actions || slice ? outputs : [] };
}
export async function spriteLayoutGuide(
  count: number,
  rows = 1,
  size?: string,
  frameWidth = 1,
  frameHeight = 1,
  counts?: readonly number[],
) {
  return sharp(
    Buffer.from(spriteLayoutGuideSvg(count, rows, size, frameWidth, frameHeight, counts)),
  )
    .png()
    .toBuffer();
}
