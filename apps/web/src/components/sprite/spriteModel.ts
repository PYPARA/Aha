import type { SpriteContext } from "@synara/contracts";
export interface SpriteSource {
  id: string;
  name: string;
  width: number;
  height: number;
  blob: Blob;
  assetId?: string;
}
export interface SpriteFrame {
  id: string;
  sourceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}
export interface SpriteAction {
  id: string;
  name: string;
  fps: number;
  loop: boolean;
  frames: SpriteFrame[];
}
export interface SpriteProject {
  version: 1;
  id: string;
  name: string;
  updatedAt: string;
  width: number;
  height: number;
  sources: SpriteSource[];
  actions: SpriteAction[];
  selectedActionId: string;
  threadId: string | null;
  providerId: string;
  model: string;
  referenceSourceId: string | null;
  background: "chroma" | "transparent";
  chromaKey: string;
  generationFrameCount: number;
  adoptedCandidateIds: string[];
  provenance: {
    runId: string;
    prompt: string;
    action: string;
    model: string;
    providerId: string;
  }[];
}
export const uuid = () => crypto.randomUUID();
export function newSpriteProject(): SpriteProject {
  const action: SpriteAction = { id: uuid(), name: "idle", fps: 12, loop: true, frames: [] };
  return {
    version: 1,
    id: uuid(),
    name: "Untitled sprite",
    updatedAt: new Date().toISOString(),
    width: 256,
    height: 256,
    sources: [],
    actions: [action],
    selectedActionId: action.id,
    threadId: null,
    providerId: "",
    model: "",
    referenceSourceId: null,
    background: "chroma",
    chromaKey: "#00ff00",
    generationFrameCount: 8,
    adoptedCandidateIds: [],
    provenance: [],
  };
}
export interface SliceSettings {
  mode: "grid" | "size";
  columns: number;
  rows: number;
  width: number;
  height: number;
  margin: number;
  gap: number;
}
export function sliceFrames(source: SpriteSource, settings: SliceSettings): SpriteFrame[] {
  const { margin, gap } = settings;
  if (![margin, gap].every((n) => Number.isInteger(n) && n >= 0))
    throw new Error("Margins and spacing must be non-negative integers.");
  const usableW = source.width - 2 * margin,
    usableH = source.height - 2 * margin;
  const width =
    settings.mode === "grid"
      ? (usableW - (settings.columns - 1) * gap) / settings.columns
      : settings.width;
  const height =
    settings.mode === "grid"
      ? (usableH - (settings.rows - 1) * gap) / settings.rows
      : settings.height;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0))
    throw new Error("The grid must divide into whole pixels. Adjust rows, columns or margins.");
  const columns = Math.floor((usableW + gap) / (width + gap)),
    rows = Math.floor((usableH + gap) / (height + gap));
  if (columns * rows < 1 || columns * rows > 1024)
    throw new Error("Choose a layout with 1–1024 complete frames.");
  return Array.from({ length: columns * rows }, (_, index) => ({
    id: uuid(),
    sourceId: source.id,
    x: margin + (index % columns) * (width + gap),
    y: margin + Math.floor(index / columns) * (height + gap),
    width,
    height,
    offsetX: 0,
    offsetY: 0,
  }));
}
export function framePlacement(frame: SpriteFrame, width: number, height: number) {
  return {
    x: Math.floor((width - frame.width) / 2) + frame.offsetX,
    y: height - frame.height + frame.offsetY,
  };
}
export function spriteContext(project: SpriteProject): SpriteContext {
  const action =
    project.actions.find((a) => a.id === project.selectedActionId) ?? project.actions[0]!;
  return {
    projectId: project.id,
    threadId: project.threadId,
    name: project.name,
    providerId: project.providerId,
    model: project.model,
    referenceAssetId:
      project.sources.find((s) => s.id === project.referenceSourceId)?.assetId ?? null,
    action: action.name,
    frameCount: project.generationFrameCount,
    fps: action.fps,
    existingFrameCount: action.frames.length,
    width: project.width,
    height: project.height,
    background: project.background,
    chromaKey: project.chromaKey,
  };
}
export function safeFilename(value: string) {
  return (
    value
      .normalize("NFKC")
      // eslint-disable-next-line no-control-regex -- archive filenames exclude control characters.
      .replace(/[\u0000-\u001f/\\:*?"<>|.]/g, "_")
      .slice(0, 80) || "sprite"
  );
}
export function moveFrames(frames: SpriteFrame[], ids: Set<string>, delta: number) {
  const result = [...frames];
  const indexes = result.map((_, i) => i);
  if (delta > 0) indexes.reverse();
  for (const index of indexes) {
    const target = index + delta;
    if (
      target >= 0 &&
      target < result.length &&
      ids.has(result[index]!.id) &&
      !ids.has(result[target]!.id)
    )
      [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
