import { zip, unzip, strToU8, strFromU8 } from "fflate";
import {
  spriteFrameGeometry,
  spriteFrameDuration,
  uuid,
  type SpriteProject,
  type SpriteSource,
  type SpriteFrame,
} from "./spriteModel";
import {
  SpriteActionVersionsSchema,
  SpriteExportRecordSchema,
} from "@synara/contracts/spriteLibrarySchema";
import { Schema } from "effect";
import { spriteExportLayout } from "./spriteExportLayout";
export type { SpriteExportMode } from "./spriteExportLayout";
import type { SpriteExportMode } from "./spriteExportLayout";
import {
  SpriteRenderSpec,
  SpriteCanonicalReference,
  SpriteTaskSnapshot,
  SpriteProcessingSnapshot,
  spriteOutputSize,
} from "@synara/contracts";
const positive = (n: unknown, max = 4096) =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max;
const MAX_BYTES = 80 * 1024 * 1024;
export async function decodeSpriteSource(blob: Blob, name: string): Promise<SpriteSource> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(blob.type) ||
    blob.size > 20 * 1024 * 1024
  )
    throw new Error("Use a still PNG, JPEG or WebP up to 20 MiB.");
  if (blob.type !== "image/jpeg") {
    const data = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(data.buffer);
    for (let offset = blob.type === "image/png" ? 8 : 12; offset + 8 <= data.length; ) {
      const png = blob.type === "image/png";
      const length = view.getUint32(offset + (png ? 0 : 4), !png);
      const type = String.fromCharCode(
        ...data.slice(offset + (png ? 4 : 0), offset + (png ? 8 : 4)),
      );
      if (type === "acTL" || type === "ANIM")
        throw new Error(
          "Animated images are not supported. Import a sprite sheet or separate frames.",
        );
      offset += length + (png ? 12 : 8 + (length % 2));
    }
  }
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 16_777_216) throw new Error("Image exceeds 16 megapixels.");
    return { id: uuid(), name, blob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
export async function renderSpriteFrame(
  project: SpriteProject,
  frame: SpriteFrame,
): Promise<HTMLCanvasElement> {
  const source = project.sources.find((s) => s.id === frame.sourceId);
  if (!source) throw new Error("Missing source image.");
  const geometry = spriteFrameGeometry(project, frame);
  const image = await createImageBitmap(geometry.source.blob);
  const canvas = document.createElement("canvas");
  canvas.width = project.width;
  canvas.height = project.height;
  try {
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = project.renderSpec?.mode === "illustration";
    ctx.drawImage(
      image,
      geometry.sx,
      geometry.sy,
      geometry.sw,
      geometry.sh,
      geometry.x,
      geometry.y,
      geometry.width,
      geometry.height,
    );
    return canvas;
  } finally {
    image.close();
  }
}
const png = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
      "image/png",
    ),
  );
const pack = (files: Record<string, Uint8Array>) =>
  new Promise<Blob>((resolve, reject) =>
    zip(files, { level: 1 }, (e, data) =>
      e ? reject(e) : resolve(new Blob([new Uint8Array(data)], { type: "application/zip" })),
    ),
  );
export async function exportSpriteProject(project: SpriteProject) {
  const files: Record<string, Uint8Array> = {};
  const sources = [];
  for (const source of project.sources) {
    const file = `sources/${source.id}`;
    files[file] = new Uint8Array(await source.blob.arrayBuffer());
    sources.push({
      id: source.id,
      name: source.name,
      width: source.width,
      height: source.height,
      file,
      mimeType: source.blob.type,
      usage: source.usage,
      origin: source.origin,
      assetId: source.assetId,
      masterSourceId: source.masterSourceId,
    });
  }
  const { threadIds: _threads, activeThreadId: _active, sources: _sources, ...portable } = project;
  files["project.json"] = strToU8(
    JSON.stringify({ ...portable, sources, threadIds: [], activeThreadId: null }, null, 2),
  );
  return pack(files);
}
export async function importSpriteProject(file: File): Promise<SpriteProject> {
  if (file.size > MAX_BYTES) throw new Error("Project archive exceeds 80 MiB.");
  let total = 0;
  let oversized = false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      bytes,
      {
        filter: (entry) => {
          total += entry.originalSize;
          if (total > MAX_BYTES || entry.name.includes("..") || entry.name.startsWith("/")) {
            oversized = true;
            return false;
          }
          return true;
        },
      },
      (e, result) => (e ? reject(e) : resolve(result)),
    ),
  );
  if (oversized || !files["project.json"]) throw new Error("Invalid or oversized project archive.");
  const data = JSON.parse(strFromU8(files["project.json"]));
  data.actionVersions = SpriteActionVersionsSchema.parse(data.actionVersions);
  data.lastExport = SpriteExportRecordSchema.parse(data.lastExport);

  if (
    ![1, 2].includes(data.version) ||
    typeof data.name !== "string" ||
    !positive(data.width) ||
    !positive(data.height) ||
    !Array.isArray(data.sources) ||
    data.sources.length > 1024 ||
    !Array.isArray(data.actions) ||
    !data.actions.length ||
    data.actions.length > 256
  )
    throw new Error("Unsupported or invalid sprite project.");
  if (data.version === 2) {
    data.renderSpec = Schema.decodeUnknownSync(SpriteRenderSpec)(data.renderSpec);
    const size = spriteOutputSize(data.renderSpec);
    if (size.width !== data.width || size.height !== data.height)
      throw new Error("Output dimensions do not match the render specification.");
    if (data.canonical)
      data.canonical = Schema.decodeUnknownSync(SpriteCanonicalReference)(data.canonical);
    if (data.canonicalVersions)
      data.canonicalVersions = data.canonicalVersions.map((v: unknown) =>
        Schema.decodeUnknownSync(SpriteCanonicalReference)(v),
      );
    if (Array.isArray(data.provenance))
      for (const p of data.provenance) {
        if (p?.processingSnapshots)
          p.processingSnapshots = Schema.decodeUnknownSync(Schema.Array(SpriteProcessingSnapshot))(
            p.processingSnapshots,
          );
        if (p?.taskSnapshots)
          p.taskSnapshots = Schema.decodeUnknownSync(Schema.Array(SpriteTaskSnapshot))(
            p.taskSnapshots,
          );
      }
  }
  const sources: SpriteSource[] = [];
  for (const source of data.sources) {
    if (
      typeof source.id !== "string" ||
      !/^[\w-]{1,128}$/.test(source.id) ||
      sources.some((s) => s.id === source.id) ||
      typeof source.name !== "string" ||
      typeof source.file !== "string" ||
      !files[source.file]
    )
      throw new Error("Missing or duplicate source image.");
    const decoded = await decodeSpriteSource(
      new Blob([new Uint8Array(files[source.file]!)], { type: source.mimeType }),
      source.name,
    );
    if (decoded.width !== source.width || decoded.height !== source.height)
      throw new Error("Source dimensions do not match.");
    sources.push({
      ...decoded,
      id: source.id,
      usage: ["generated-frame", "generated-master"].includes(source.usage)
        ? source.usage
        : "material",
      ...(typeof source.masterSourceId === "string"
        ? { masterSourceId: source.masterSourceId }
        : {}),
      ...(source.assetId && /^[\w-]{1,128}$/.test(source.assetId)
        ? { assetId: source.assetId }
        : {}),
      ...(source.origin &&
      typeof source.origin.runId === "string" &&
      typeof source.origin.candidateId === "string"
        ? { origin: source.origin }
        : {}),
    });
  }
  const actionIds = new Set<string>();
  if (
    sources.some(
      (source) =>
        source.masterSourceId &&
        !sources.some(
          (master) => master.id === source.masterSourceId && master.usage === "generated-master",
        ),
    )
  )
    throw new Error("Missing sprite logical master.");
  for (const [actionIndex, action] of [
    ...data.actions,
    ...(data.actionVersions ?? []).map((v: { action: unknown }) => v.action),
  ].entries()) {
    if (
      typeof action.id !== "string" ||
      !/^[\w-]{1,128}$/.test(action.id) ||
      (actionIndex < data.actions.length && actionIds.has(action.id)) ||
      typeof action.name !== "string" ||
      !Number.isFinite(action.fps) ||
      action.fps < 1 ||
      action.fps > 60 ||
      typeof action.loop !== "boolean" ||
      !Array.isArray(action.frames) ||
      action.frames.length > 1024
    )
      throw new Error("Invalid animation action.");
    if (actionIndex < data.actions.length) actionIds.add(action.id);
    const frameIds = new Set<string>();
    for (const frame of action.frames) {
      const source = sources.find((s) => s.id === frame.sourceId);
      if (
        !source ||
        typeof frame.id !== "string" ||
        !/^[\w-]{1,128}$/.test(frame.id) ||
        frameIds.has(frame.id) ||
        !positive(frame.width, 16384) ||
        !positive(frame.height, 16384) ||
        ![frame.x, frame.y, frame.offsetX, frame.offsetY].every(
          (n) => Number.isInteger(n) && Math.abs(n) <= 32768,
        ) ||
        frame.x < 0 ||
        frame.y < 0 ||
        frame.x + frame.width > source.width ||
        frame.y + frame.height > source.height
      )
        throw new Error("Invalid frame rectangle or image reference.");
      if (
        frame.durationMs !== undefined &&
        (typeof frame.durationMs !== "number" ||
          !Number.isFinite(frame.durationMs) ||
          frame.durationMs <= 0)
      )
        throw new Error("Invalid frame duration.");
      frameIds.add(frame.id);
    }
  }
  const { newSpriteProject } = await import("./spriteModel");
  return {
    ...newSpriteProject(),
    version: data.version,
    renderSpec: data.version === 2 ? data.renderSpec : undefined,
    canonical: data.version === 2 ? data.canonical : undefined,
    canonicalVersions: data.version === 2 ? data.canonicalVersions : undefined,
    name: data.name,
    width: data.width,
    height: data.height,
    sources,
    actions: data.actions,
    actionVersions: data.actionVersions,
    lastExport: data.lastExport,
    selectedActionId: actionIds.has(data.selectedActionId)
      ? data.selectedActionId
      : data.actions[0].id,
    referenceSourceId: sources.some((s) => s.id === data.referenceSourceId)
      ? data.referenceSourceId
      : null,
    background: data.background === "transparent" ? "transparent" : "chroma",
    chromaKey:
      typeof data.chromaKey === "string" && /^#[0-9a-f]{6}$/i.test(data.chromaKey)
        ? data.chromaKey
        : "#00ff00",
    generationFrameCount: positive(data.generationFrameCount, 32) ? data.generationFrameCount : 8,
    adoptedCandidateIds: Array.isArray(data.adoptedCandidateIds)
      ? data.adoptedCandidateIds.filter(
          (id: unknown) =>
            typeof id === "string" && /^[\w-]{1,128}(?::[\w-]{1,128}){0,2}$/.test(id),
        )
      : [],
    provenance: Array.isArray(data.provenance)
      ? data.provenance
          .filter(
            (p: Record<string, unknown>) =>
              p &&
              [p.runId, p.prompt, p.action, p.model, p.providerId].every(
                (v) => typeof v === "string",
              ),
          )
          .slice(0, 1024)
      : [],
  };
}

function createAtlas(columns: number, rows: number, project: SpriteProject, gap: number) {
  const width = columns * project.width + (columns - 1) * gap;
  const height = rows * project.height + (rows - 1) * gap;
  if (width > 16384 || height > 16384 || width * height > 64_000_000)
    throw new Error(
      "Atlas exceeds the output limit. Adjust columns, reduce canvas size, or choose another export format.",
    );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function exportSpriteAssets(
  project: SpriteProject,
  actionIds: string[],
  mode: SpriteExportMode,
  columns: number,
  gap: number,
  signal?: AbortSignal,
  progress?: (value: string) => void,
) {
  const layout = spriteExportLayout(project, actionIds, mode, columns, gap);
  if (!layout) throw new Error("No frames to export.");
  signal?.throwIfAborted();
  const combined = mode === "combined" ? createAtlas(layout.cols, layout.rows, project, gap) : null;
  const files: Record<string, Uint8Array> = {};
  const metadata: {
    version: number;
    width: number;
    height: number;
    pivot: { x: number; y: number };
    renderSpec?: SpriteProject["renderSpec"];
    actions: unknown[];
  } = {
    version: project.version,
    width: project.width,
    height: project.height,
    pivot: project.canonical
      ? {
          x: (project.canonical.pivotX / project.canonical.renderSpec.logicalWidth) * project.width,
          y:
            (project.canonical.pivotY / project.canonical.renderSpec.logicalHeight) *
            project.height,
        }
      : { x: project.width / 2, y: project.height },
    ...(project.renderSpec ? { renderSpec: project.renderSpec } : {}),
    actions: [],
  };
  for (const entry of layout.entries) {
    const { action, prefix, cols, rows } = entry;
    const atlas = combined ?? (mode === "atlas" ? createAtlas(cols, rows, project, gap) : null);
    const frames = [];
    for (const [index, placement] of entry.frames.entries()) {
      const { frame, x, y, file } = placement;
      signal?.throwIfAborted();
      progress?.(`${action.name} ${index + 1}/${action.frames.length}`);
      const canvas = await renderSpriteFrame(project, frame);
      signal?.throwIfAborted();
      if (mode === "sequence") {
        files[file] = new Uint8Array(await (await png(canvas)).arrayBuffer());
        frames.push({ file, durationMs: spriteFrameDuration(action, frame) });
      } else {
        atlas!.getContext("2d")!.drawImage(canvas, x, y);
        frames.push({
          x,
          y,
          width: project.width,
          height: project.height,
          durationMs: spriteFrameDuration(action, frame),
        });
      }
    }
    if (mode === "atlas")
      files[`${prefix}.png`] = new Uint8Array(await (await png(atlas!)).arrayBuffer());
    const taskSnapshots = project.provenance.find(
      (p) => p.localActionId === action.id,
    )?.taskSnapshots;
    metadata.actions.push({
      name: action.name,
      fps: action.fps,
      loop: action.loop,
      ...(mode === "sequence" ? {} : { image: combined ? "atlas.png" : `${prefix}.png` }),
      frames,
      ...(project.version === 2 && taskSnapshots?.length ? { source: { taskSnapshots } } : {}),
    });
  }
  signal?.throwIfAborted();
  if (combined) files["atlas.png"] = new Uint8Array(await (await png(combined)).arrayBuffer());
  files["animation.json"] = strToU8(JSON.stringify(metadata, null, 2));
  signal?.throwIfAborted();
  const archive = await pack(files);
  signal?.throwIfAborted();
  return archive;
}

/** Preview uses the same frame renderer and packing order as the resource exporter. */
export async function renderSpriteAtlasPreview(
  project: SpriteProject,
  actionIds: readonly string[],
  mode: SpriteExportMode,
  columns: number,
  gap: number,
) {
  const layout = spriteExportLayout(project, actionIds, mode, columns, gap);
  if (!layout) return null;
  if (mode === "sequence") return renderSpriteFrame(project, layout.entries[0]!.frames[0]!.frame);
  const first = layout.entries[0]!;
  const atlas = createAtlas(
    mode === "combined" ? layout.cols : first.cols,
    mode === "combined" ? layout.rows : first.rows,
    project,
    gap,
  );
  const ctx = atlas.getContext("2d")!;
  for (const entry of mode === "atlas" ? layout.entries.slice(0, 1) : layout.entries)
    for (const { frame, x, y } of entry.frames)
      ctx.drawImage(await renderSpriteFrame(project, frame), x, y);
  return atlas;
}

/** Pick a key away from the reference's visible palette; users can override it. */
export async function suggestChromaKey(blob: Blob) {
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data;
    const colors = [
      { hex: "#00ff00", rgb: [0, 255, 0] },
      { hex: "#ff00ff", rgb: [255, 0, 255] },
      { hex: "#00ffff", rgb: [0, 255, 255] },
    ];
    return colors
      .map((color) => {
        let score = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i + 3]! > 128) {
            const distance = color.rgb.reduce((n, c, j) => n + (pixels[i + j]! - c) ** 2, 0);
            score += 1 / (1 + distance);
          }
        return { hex: color.hex, score };
      })
      .toSorted((a, b) => a.score - b.score)[0]!.hex;
  } finally {
    image.close();
  }
}

/** Alpha testing excludes transparent cells without interpreting their RGB pixels. */
export async function visibleSpriteFrameIds(
  source: SpriteSource,
  frames: SpriteFrame[],
): Promise<Set<string>> {
  const image = await createImageBitmap(source.blob);
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, source.width, source.height).data;
    const ids = new Set<string>();
    for (const frame of frames) {
      let visible = false;
      for (let y = frame.y; y < frame.y + frame.height && !visible; y++)
        for (let x = frame.x; x < frame.x + frame.width; x++)
          if (pixels[(y * source.width + x) * 4 + 3]! > 0) {
            visible = true;
            break;
          }
      if (visible) ids.add(frame.id);
    }
    return ids;
  } finally {
    image.close();
  }
}
export async function cropSpriteFrameSource(
  source: SpriteSource,
  frame: SpriteFrame,
  name: string,
): Promise<SpriteSource> {
  const image = await createImageBitmap(source.blob);
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  try {
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      image,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      0,
      0,
      frame.width,
      frame.height,
    );
    return { id: uuid(), name, width: frame.width, height: frame.height, blob: await png(canvas) };
  } finally {
    image.close();
  }
}
