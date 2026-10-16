import { spriteBoundaries } from "@synara/contracts";
import type { SpriteContext } from "@synara/contracts";
export interface SpriteSource {
  id: string;
  name: string;
  width: number;
  height: number;
  blob: Blob;
  assetId?: string | undefined;
  usage?: "material" | "generated-frame" | undefined;
  origin?:
    | { runId: string; candidateId: string; processingVersionId?: string | undefined }
    | undefined;
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
  threadIds: string[];
  activeThreadId: string | null;
  providerId: string;
  model: string;
  referenceSourceId: string | null;
  background: "chroma" | "transparent";
  chromaKey: string;
  generationFrameCount: number;
  adoptedCandidateIds: string[];
  provenance: {
    runId: string;
    candidateId?: string | undefined;
    localActionId?: string | undefined;
    processingVersionId?: string | undefined;
    actionId?: string | undefined;
    planId?: string | undefined;
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
    threadIds: [],
    activeThreadId: null,
    providerId: "",
    model: "",
    referenceSourceId: null,
    background: "transparent",
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
  if (settings.mode === "grid") {
    const xs = spriteBoundaries(usableW - (settings.columns - 1) * gap, settings.columns, margin);
    const ys = spriteBoundaries(usableH - (settings.rows - 1) * gap, settings.rows, margin);
    if (settings.columns * settings.rows > 1024)
      throw new Error("Choose a layout with 1–1024 complete frames.");
    return Array.from({ length: settings.columns * settings.rows }, (_, i) => {
      const col = i % settings.columns,
        row = Math.floor(i / settings.columns);
      return {
        id: uuid(),
        sourceId: source.id,
        x: xs[col]! + col * gap,
        y: ys[row]! + row * gap,
        width: xs[col + 1]! - xs[col]!,
        height: ys[row + 1]! - ys[row]!,
        offsetX: 0,
        offsetY: 0,
      };
    });
  }
  const width = settings.width,
    height = settings.height;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0))
    throw new Error("Frame dimensions must be positive integers.");
  const columns = Math.floor((usableW + gap) / (width + gap)),
    rows = Math.floor((usableH + gap) / (height + gap));
  if (columns * rows < 1 || columns * rows > 1024)
    throw new Error("Choose a layout with 1–1024 complete frames.");
  return Array.from({ length: columns * rows }, (_, i) => ({
    id: uuid(),
    sourceId: source.id,
    x: margin + (i % columns) * (width + gap),
    y: margin + Math.floor(i / columns) * (height + gap),
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
    threadId: project.activeThreadId,
    name: project.name,
    providerId: project.providerId,
    model: project.model,
    referenceAssetId: null,
    action: action.name,
    frameCount: project.generationFrameCount,
    fps: action.fps,
    loop: action.loop,
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

export interface SpriteSheetRow {
  row: number;
  name: string;
  enabled: boolean;
  frames: SpriteFrame[];
}
/** A sheet's rows are structural groups; action names must be chosen by the user. */
export function groupSpriteSheetRows(
  frames: SpriteFrame[],
  visibleFrameIds?: Set<string>,
): SpriteSheetRow[] {
  const rows = new Map<number, SpriteFrame[]>();
  for (const frame of frames) {
    const group = rows.get(frame.y) ?? [];
    group.push(frame);
    rows.set(frame.y, group);
  }
  return [...rows.values()].map((group, i) => {
    const included = visibleFrameIds ? group.filter((f) => visibleFrameIds.has(f.id)) : group;
    return { row: i + 1, name: `action-${i + 1}`, enabled: included.length > 0, frames: included };
  });
}
export function adoptSpriteSheetRows(
  project: SpriteProject,
  sourceId: string,
  rows: SpriteSheetRow[],
): SpriteProject {
  const chosen = rows.filter((row) => row.enabled && row.frames.length > 0);
  if (!chosen.length) throw new Error("Select at least one non-empty row.");
  if (chosen.some((row) => !row.name.trim()))
    throw new Error("Enter a name for each selected action.");
  const source = project.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error("Missing source image.");
  // Discard the import's whole-sheet placeholder only. Keep edited animations intact.
  const existing = project.actions
    .map((a) => ({
      ...a,
      frames: a.frames.filter(
        (f) =>
          !(
            f.sourceId === sourceId &&
            f.x === 0 &&
            f.y === 0 &&
            f.width === source.width &&
            f.height === source.height
          ),
      ),
    }))
    .filter((a) => a.frames.length > 0 || a.id !== project.selectedActionId);
  if (existing.length + chosen.length > 1024)
    throw new Error("A project can have at most 1024 actions.");
  const existingNames = new Set(existing.map((a) => a.name));
  const names = new Set<string>();
  for (const row of chosen) {
    const name = row.name.trim();
    if (names.has(name) || existingNames.has(name))
      throw new Error("Choose different action names; existing actions are preserved.");
    names.add(name);
  }
  const actions = chosen.map((row) => ({
    id: uuid(),
    name: row.name.trim(),
    fps: 12,
    loop: true,
    frames: row.frames.map((f) => ({ ...f, id: uuid() })),
  }));
  return {
    ...project,
    width: actions[0]!.frames[0]!.width,
    height: actions[0]!.frames[0]!.height,
    actions: [...existing, ...actions],
    selectedActionId: actions[0]!.id,
  };
}

export function removeSpriteSource(project: SpriteProject, id: string): SpriteProject {
  return {
    ...project,
    sources: project.sources.filter((s) => s.id !== id),
    referenceSourceId: project.referenceSourceId === id ? null : project.referenceSourceId,
    actions: project.actions.map((a) => ({
      ...a,
      frames: a.frames.filter((f) => f.sourceId !== id),
    })),
  };
}
export function actionFromSelectedFrames(
  project: SpriteProject,
  selected: Set<string>,
  name: string,
): SpriteProject {
  const action = project.actions.find((a) => a.id === project.selectedActionId)!;
  const frames = action.frames.filter((f) => selected.has(f.id));
  if (!frames.length || !name.trim()) throw new Error("Select frames and enter an action name.");
  if (project.actions.length >= 1024) throw new Error("A project can have at most 1024 actions.");
  const next = {
    ...action,
    id: uuid(),
    name: name.trim(),
    frames: frames.map((f) => Object.assign({}, f, { id: uuid() })),
  };
  return { ...project, actions: [...project.actions, next], selectedActionId: next.id };
}
export function reorderSelectedFrames(
  frames: SpriteFrame[],
  ids: Set<string>,
  beforeId: string,
): SpriteFrame[] {
  if (ids.has(beforeId)) return frames;
  const moved = frames.filter((f) => ids.has(f.id));
  const rest = frames.filter((f) => !ids.has(f.id));
  const at = rest.findIndex((f) => f.id === beforeId);
  if (at < 0) return frames;
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}
export function selectSpriteFrame(
  frames: SpriteFrame[],
  selected: Set<string>,
  anchor: string | null,
  target: string,
  range: boolean,
  additive: boolean,
): Set<string> {
  if (range) {
    const start = frames.findIndex((f) => f.id === anchor),
      end = frames.findIndex((f) => f.id === target);
    const ids = frames
      .slice(Math.min(start < 0 ? end : start, end), Math.max(start < 0 ? end : start, end) + 1)
      .map((f) => f.id);
    return new Set([...(additive ? selected : []), ...ids]);
  }
  if (!additive) return new Set([target]);
  const next = new Set(selected);
  if (next.has(target)) next.delete(target);
  else next.add(target);
  return next;
}
