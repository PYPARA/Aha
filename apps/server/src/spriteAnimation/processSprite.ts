/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import { spriteSliceFromEdit } from "@synara/contracts";
import sharp from "sharp";
import {
  spriteLayoutGuideSvg,
  spriteGridSlice,
  validateSpriteSlice,
  spriteIssue,
  SPRITE_ANALYSIS_VERSION,
  spriteTaskSlice,
  spriteOutputSize,
} from "@synara/contracts";
import type {
  SpriteContext,
  SpritePlanAction,
  SpriteSliceConfiguration,
  SpriteLayoutAnalysis,
  SpriteTaskLayout,
  SpriteRenderSpec,
  SpriteRegistration,
} from "@synara/contracts";

async function foreground(bytes: Uint8Array, context: SpriteContext) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 64_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const key = [1, 3, 5].map((i) => parseInt(context.chromaKey.slice(i, i + 2), 16));
  const transparent = data.some((value, i) => i % 4 === 3 && value < 255);
  if (context.background === "chroma")
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.sqrt(
        key.reduce((sum, channel, j) => sum + (data[i + j]! - channel) ** 2, 0),
      );
      const alpha = Math.max(0, Math.min(1, (distance - 36) / 64));
      data[i + 3] = Math.round(alpha * data[i + 3]!);
      for (let j = 0; j < 3; j++)
        data[i + j] = alpha
          ? Math.round(Math.max(0, Math.min(255, (data[i + j]! - (1 - alpha) * key[j]!) / alpha)))
          : 0;
    }
  for (let i = 0; i < data.length; i += 4) if (!data[i + 3]) data.fill(0, i, i + 4);
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
  layout?: SpriteTaskLayout,
  requestedSize?: string,
  manual = false,
): Promise<SpriteLayoutAnalysis> {
  const { data, info, opaque } = await foreground(bytes, context);
  if (layout) {
    const suggestion = spriteTaskSlice(layout, actions, info.width, info.height);
    let nonEmptyCells = 0;
    for (const c of suggestion.rows.flatMap((row) => row.cells).filter((c) => c.enabled)) {
      let occupied = false;
      for (let y = c.y; y < c.y + c.height && !occupied; y++)
        for (let x = c.x; x < c.x + c.width; x++)
          if (data[(y * info.width + x) * 4 + 3]! > 24) {
            occupied = true;
            break;
          }
      if (occupied) nonEmptyCells++;
    }
    const reliable =
      Math.abs(info.width / info.height / (layout.width / layout.height) - 1) <= 0.01;
    const issues = [];
    if (!reliable)
      issues.push(
        spriteIssue(
          "aspect-ratio",
          "The returned image does not match the planned aspect ratio. Review the frame regions.",
          undefined,
          undefined,
          "warning",
        ),
      );
    if (requestedSize !== "auto" && (info.width !== layout.width || info.height !== layout.height))
      issues.push(
        spriteIssue(
          "returned-size",
          `Requested ${layout.width}×${layout.height}; returned ${info.width}×${info.height}.`,
          undefined,
          undefined,
          "warning",
        ),
      );
    if (opaque)
      issues.push(
        spriteIssue(
          "transparency",
          "Expected transparency was not present; adjust background processing.",
        ),
      );
    return {
      algorithmVersion: SPRITE_ANALYSIS_VERSION,
      sourceId,
      width: info.width,
      height: info.height,
      plannedFrames: actions.reduce((n, a) => n + a.frameCount, 0),
      cells: layout.cells.length,
      nonEmptyCells,
      suspectedSubjects: null,
      reliable,
      issues,
      suggestion,
      cellGeometries: layout,
    };
  }
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
  if (
    manual &&
    !opaque &&
    yBands.length &&
    xBands.every((b) => b.length > 0) &&
    yBands.length * Math.max(...xBands.map((b) => b.length)) <= 1024
  ) {
    const columns = Math.max(...xBands.map((b) => b.length)),
      rows = yBands.length;
    const sourceCells = Array.from({ length: columns * rows }, (_, i) => {
      const x = Math.floor(((i % columns) * info.width) / columns),
        y = Math.floor((Math.floor(i / columns) * info.height) / rows);
      return {
        id: `cell-${i}`,
        x,
        y,
        width: Math.floor((((i % columns) + 1) * info.width) / columns) - x,
        height: Math.floor(((Math.floor(i / columns) + 1) * info.height) / rows) - y,
        originX: x,
        originY: y,
        enabled: true,
      };
    });
    const action = actions[0] ?? {
      id: "imported",
      name: context.action,
      description: "",
      enabled: true,
      frameCount: sourceCells.length,
      fps: context.fps,
      loop: context.loop ?? true,
    };
    const edit = {
      version: 1 as const,
      cells: sourceCells,
      actions: [
        {
          action: { ...action, frameCount: sourceCells.length },
          frames: sourceCells.map((c, i) => ({
            id: `frame-${i}`,
            cellId: c.id,
            offsetX: 0,
            offsetY: 0,
          })),
        },
      ],
      common: {
        canvasWidth: Math.max(...sourceCells.map((c) => c.width)),
        canvasHeight: Math.max(...sourceCells.map((c) => c.height)),
        anchorX: 0,
        anchorY: 0,
        registration: { scale: 1, offsetX: 0, offsetY: 0 },
      },
    };
    const suggestion = spriteSliceFromEdit(edit);
    return {
      algorithmVersion: SPRITE_ANALYSIS_VERSION,
      sourceId,
      width: info.width,
      height: info.height,
      plannedFrames: sourceCells.length,
      cells: sourceCells.length,
      nonEmptyCells: xBands.reduce((n, b) => n + b.length, 0),
      suspectedSubjects: xBands.reduce((n, b) => n + b.length, 0),
      reliable: false,
      issues: [
        spriteIssue(
          "uncertain-layout",
          "Detected a possible grid. Confirm the layout and intentional blank frames before adopting.",
        ),
      ],
      suggestion,
    };
  }
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
  layout?: SpriteTaskLayout,
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
      loop: context.loop ?? true,
    },
  ];
  const configuration =
    (slice?.edit ? spriteSliceFromEdit(slice.edit, slice) : slice) ??
    (layout
      ? spriteTaskSlice(layout, descriptors, info.width, info.height)
      : spriteGridSlice(info.width, info.height, descriptors));
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
    masters: Uint8Array[] = [],
    outputs = [];
  const spec = context.renderSpec;
  if (spec) spriteOutputSize(spec);
  const width = spec?.logicalWidth ?? context.width,
    height = spec?.logicalHeight ?? context.height;
  const scale = Math.min(width / configuration.canvasWidth, height / configuration.canvasHeight);
  if (!spec && Math.abs(scale - Math.round(scale)) > 0.001)
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
      if (!occupied && !c.allowEmpty) warn("empty", `Frame ${index + 1} is empty.`);
      if (edge > 2)
        warn(
          "boundary",
          `Frame ${index + 1} touches its cell boundary; check clipping or overlapping poses.`,
          context.workflowVersion === 2 ? "warning" : "error",
        );
      if (occupied > c.width * c.height * 0.95)
        warn(
          "background",
          `Frame ${index + 1} may contain an unremoved background.`,
          context.workflowVersion === 2 ? "warning" : "error",
        );
      const localX = Math.floor(
        configuration.anchorX + (c.originX === undefined ? 0 : c.x - c.originX),
      );
      const localY = Math.floor(
        configuration.anchorY + (c.originY === undefined ? 0 : c.y - c.originY),
      );
      let master: Buffer;
      if (spec) {
        const shared = Buffer.alloc(configuration.canvasWidth * configuration.canvasHeight * 4);
        for (let y = 0; y < c.height; y++)
          raw.copy(
            shared,
            ((localY + y) * configuration.canvasWidth + localX) * 4,
            y * c.width * 4,
            (y + 1) * c.width * 4,
          );
        const resized = await sharp(shared, {
          raw: {
            width: configuration.canvasWidth,
            height: configuration.canvasHeight,
            channels: 4,
          },
        })
          .resize(targetW, targetH, {
            kernel: spec.mode === "illustration" ? "lanczos3" : "nearest",
          })
          .png()
          .toBuffer();
        master = await sharp(resized)
          .extend({
            left: Math.floor((width - targetW) / 2),
            right: Math.ceil((width - targetW) / 2),
            top: Math.floor((height - targetH) / 2),
            bottom: Math.ceil((height - targetH) / 2),
            background: "#00000000",
          })
          .png()
          .toBuffer();
      } else
        master = await sharp(raw, { raw: { width: c.width, height: c.height, channels: 4 } })
          .extend({
            left: localX,
            top: localY,
            right: configuration.canvasWidth - c.width - localX,
            bottom: configuration.canvasHeight - c.height - localY,
            background: "#00000000",
          })
          .resize(targetW, targetH, { kernel: "nearest" })
          .extend({
            left: Math.floor((width - targetW) / 2),
            right: Math.ceil((width - targetW) / 2),
            top: Math.floor((height - targetH) / 2),
            bottom: Math.ceil((height - targetH) / 2),
            background: "#00000000",
          })
          .png()
          .toBuffer();
      if (configuration.registration)
        master = await registerSprite(
          master,
          width,
          height,
          configuration.registration,
          spec?.mode === "illustration",
          context.canonical
            ? {
                x: (context.canonical.pivotX / context.canonical.renderSpec.logicalWidth) * width,
                y: (context.canonical.pivotY / context.canonical.renderSpec.logicalHeight) * height,
              }
            : undefined,
        );
      if (c.offsetX || c.offsetY)
        master = await registerSprite(
          master,
          width,
          height,
          {
            scale: 1,
            offsetX: (c.offsetX ?? 0) / (spec?.outputScale ?? 1),
            offsetY: (c.offsetY ?? 0) / (spec?.outputScale ?? 1),
          },
          spec?.mode === "illustration",
        );
      if (spec?.mode === "pixel") master = await hardAlpha(master);
      if (spec && occupied && (await sharp(master).ensureAlpha().stats()).channels[3]?.max === 0)
        warn("empty", `Frame ${index + 1} is empty after rendering.`);
      const canvas =
        spec?.mode === "pixel" && spec.outputScale !== 1
          ? await sharp(master)
              .resize(width * spec.outputScale, height * spec.outputScale, { kernel: "nearest" })
              .png()
              .toBuffer()
          : master;
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
      masters.push(master);
      index++;
    }
    warnings.push(...rowWarnings);
    outputs.push({
      action: { ...row.action, frameCount: rowFrames.length },
      frames: rowFrames,
      frameMetadata: row.cells
        .filter((c) => c.enabled)
        .map((c, i) => ({
          id: c.frameId ?? `frame-${configuration.rows.indexOf(row)}-${i}`,
          cellId: c.id ?? `cell-${configuration.rows.indexOf(row)}-${i}`,
          ...(c.durationMs ? { durationMs: c.durationMs } : {}),
        })),
      warnings: rowWarnings,
    });
  }
  return {
    frames,
    masters,
    warnings,
    issues,
    configuration,
    actions: actions || slice ? outputs : [],
  };
}

async function hardAlpha(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = data[i + 3]! >= 128 ? 255 : 0;
    if (!data[i + 3]) data.fill(0, i, i + 4);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function registerSprite(
  bytes: Uint8Array,
  width: number,
  height: number,
  registration: SpriteRegistration,
  smooth = false,
  pivot = { x: width * 0.5, y: height * 0.9 },
) {
  const { scale, offsetX, offsetY } = registration;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    scale > 16 ||
    ![offsetX, offsetY].every(Number.isFinite)
  )
    throw new Error("Invalid sprite alignment.");
  const rw = Math.max(1, Math.round(width * scale)),
    rh = Math.max(1, Math.round(height * scale));
  const x = Math.round(pivot.x * (1 - scale) + offsetX),
    y = Math.round(pivot.y * (1 - scale) + offsetY);
  const left = Math.max(0, x),
    top = Math.max(0, y),
    right = Math.min(width, x + rw),
    bottom = Math.min(height, y + rh);
  if (right <= left || bottom <= top) throw new Error("The character falls outside the canvas.");
  const resized = await sharp(bytes)
    .resize(rw, rh, { kernel: smooth ? "lanczos3" : "nearest" })
    .png()
    .toBuffer();
  if (x < 0 || y < 0 || x + rw > width || y + rh > height) {
    const { data, info } = await sharp(resized)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let py = 0; py < rh; py++)
      for (let px = 0; px < rw; px++)
        if (
          (px + x < 0 || py + y < 0 || px + x >= width || py + y >= height) &&
          data[(py * info.width + px) * 4 + 3]! > 24
        )
          throw new Error(
            "Alignment would crop the character. Enlarge the canvas or reduce the shared scale.",
          );
  }
  const crop = await sharp(resized)
    .extract({ left: left - x, top: top - y, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: "#00000000" } })
    .composite([{ input: crop, left, top }])
    .png()
    .toBuffer();
}

export async function normalizeSpriteCharacter(
  bytes: Uint8Array,
  context: SpriteContext,
  spec: SpriteRenderSpec,
  registration: SpriteRegistration,
) {
  const size = spriteOutputSize(spec),
    { data, info, opaque } = await foreground(bytes, context);
  if (opaque)
    throw new Error("Expected transparency was not present; adjust background processing.");
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3]! > 24) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
  if (right < left) throw new Error("The character reference is empty.");
  const bw = right - left + 1,
    bh = bottom - top + 1,
    w = spec.logicalWidth,
    h = spec.logicalHeight;
  // Render both derivatives from the original pixels, never from the small preview.
  const subject = await sharp(data, { raw: info })
    .extract({ left, top, width: bw, height: bh })
    .png()
    .toBuffer();
  const render = async (cw: number, ch: number, factor: number) => {
    const fit = Math.min((cw * 0.8) / bw, (ch * 0.8) / bh);
    const tw = Math.max(1, Math.floor(bw * fit)),
      th = Math.max(1, Math.floor(bh * fit));
    const body = await sharp(subject)
      .resize(tw, th, {
        kernel: spec.mode === "pixel" ? "nearest" : "lanczos3",
      })
      .png()
      .toBuffer();
    const canvas = await sharp({
      create: { width: cw, height: ch, channels: 4, background: "#00000000" },
    })
      .composite([{ input: body, left: Math.floor((cw - tw) / 2), top: Math.floor(ch * 0.9) - th }])
      .png()
      .toBuffer();
    return registerSprite(
      canvas,
      cw,
      ch,
      {
        scale: registration.scale,
        offsetX: registration.offsetX * factor,
        offsetY: registration.offsetY * factor,
      },
      spec.mode === "illustration",
    );
  };
  let master = await render(w, h, 1);
  const factor = Math.min(1024, Math.max(info.width, info.height)) / Math.max(w, h);
  const generationReference =
    spec.mode === "illustration" && factor > 1
      ? await render(
          Math.max(1, Math.round(w * factor)),
          Math.max(1, Math.round(h * factor)),
          factor,
        )
      : undefined;
  if (spec.mode === "pixel") master = await hardAlpha(master);
  const output = await sharp(master)
    .resize(size.width, size.height, { kernel: spec.mode === "pixel" ? "nearest" : "lanczos3" })
    .png()
    .toBuffer();
  return {
    bytes: output,
    generationReference,
    master,
    pivotX: w * 0.5 + registration.offsetX,
    pivotY: Math.floor(h * 0.9) + registration.offsetY,
  };
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
