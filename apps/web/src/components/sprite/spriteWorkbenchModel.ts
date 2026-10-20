import {
  spriteStructuralBlockedActions,
  type SpriteRun,
  type SpriteState,
} from "@synara/contracts";
import { spriteAdoption } from "./spriteAdoption";
import { spriteCombinedActionRun } from "./spriteWorkflowModel";
import { spriteLatestAttempts } from "./spriteGenerationAttempts";
import { spriteCandidate } from "./spriteCandidate";
import { spriteExportLayout } from "./spriteExportLayout";
import {
  uuid,
  type SpriteAction,
  type SpriteProject,
  type SpriteActionVersion,
} from "./spriteModel";

export type SpriteWorkbenchSelection =
  | { phase: "character" }
  | { phase: "export" }
  | { phase: "actions"; actionId: string; mode: "current" }
  | {
      phase: "actions";
      actionId: string;
      mode: "candidate" | "slicing";
      runId: string;
      candidateId: string;
      processingVersionId?: string | undefined;
    };

export interface SpriteWorkbenchView {
  version: 1;
  selection: SpriteWorkbenchSelection;
  frameIndex: number;
  inspector: "properties" | "assistant";
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
  onion: boolean;
  reference: boolean;
  zoom: "fit" | "native" | "logical";
}
export function readSpriteWorkbenchView(project: SpriteProject): SpriteWorkbenchView {
  const fallback: SpriteWorkbenchView = {
    version: 1,
    selection:
      project.version === 2 && !project.canonical
        ? { phase: "character" }
        : { phase: "actions", actionId: project.selectedActionId, mode: "current" },
    frameIndex: 0,
    inspector: "properties",
    leftWidth: 224,
    rightWidth: 280,
    timelineHeight: 168,
    onion: false,
    reference: false,
    zoom: "fit",
  };
  try {
    const raw = JSON.parse(localStorage.getItem(`aha-sprite-workbench:${project.id}`) ?? "null");
    if (raw?.version !== 1) return fallback;
    const selection = raw.selection;
    if (!selection || !["character", "actions", "export"].includes(selection.phase))
      return fallback;
    if (
      selection.phase === "actions" &&
      (!project.actions.some((a) => a.id === selection.actionId) ||
        !["current", "candidate", "slicing"].includes(selection.mode) ||
        (selection.mode !== "current" &&
          (typeof selection.runId !== "string" || typeof selection.candidateId !== "string")))
    )
      return fallback;
    return {
      ...fallback,
      selection,
      frameIndex: Number.isInteger(raw.frameIndex) && raw.frameIndex >= 0 ? raw.frameIndex : 0,
      inspector: raw.inspector === "assistant" ? "assistant" : "properties",
      leftWidth: Math.min(320, Math.max(180, Number(raw.leftWidth) || 224)),
      rightWidth: Math.min(420, Math.max(260, Number(raw.rightWidth) || 280)),
      timelineHeight: Math.min(320, Math.max(120, Number(raw.timelineHeight) || 168)),
      onion: raw.onion === true,
      reference: raw.reference === true,
      zoom: ["fit", "native", "logical"].includes(raw.zoom) ? raw.zoom : "fit",
    };
  } catch {
    return fallback;
  }
}
export interface SpriteActionCandidate {
  key: string;
  actionId: string;
  localActionId?: string | undefined;
  run: SpriteRun;
}
/** Associate by provenance or stable IDs. Names never identify a target action. */
export function spriteActionCandidates(
  project: SpriteProject,
  state: SpriteState,
): SpriteActionCandidate[] {
  const results: SpriteActionCandidate[] = [];
  const seen = new Set<string>();
  for (const original of spriteLatestAttempts(state.runs).filter(
    (r) => !r.removedAt && r.input.kind === "animation",
  )) {
    const run = spriteCombinedActionRun(original, state.runs);
    if (!run) continue;
    const candidate = spriteCandidate(run);
    if (!candidate || !["ready", "needs-adjustment"].includes(candidate.status)) continue;
    for (const output of candidate.actions) {
      const key = `${run.id}:${candidate.id}:${output.action.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const origin = spriteAdoption(run, output.action.id, project);
      const localActionId =
        origin.status === "unknown"
          ? undefined
          : (origin.localActionId ?? project.actions.find((a) => a.id === output.action.id)?.id);
      results.push({ key, run, actionId: output.action.id, localActionId });
    }
  }
  return results.toReversed();
}
export function spriteActionProgress(
  project: SpriteProject,
  state: SpriteState,
  action: SpriteAction,
  candidates = spriteActionCandidates(project, state),
) {
  const candidate = candidates.find(
    (c) =>
      c.localActionId === action.id &&
      spriteAdoption(c.run, c.actionId, project).status !== "current",
  );
  const runs = spriteLatestAttempts(state.runs).filter(
    (r) =>
      !r.removedAt &&
      (r.configuration?.actions.some((a) => a.id === action.id) ||
        project.provenance.some(
          (p) =>
            p.localActionId === action.id && (p.runId === r.id || p.segmentRunIds?.includes(r.id)),
        )),
  );
  if (runs.some((r) => ["queued", "running", "processing"].includes(r.status)))
    return { label: "Generating", candidate };
  if (candidate)
    return { label: action.frames.length ? "New version available" : "Awaiting review", candidate };
  if (spriteActionRepairRun(project, state, action.id))
    return { label: "Needs frame correction", candidate };
  if (runs.at(-1)?.status === "failed") return { label: "Generation failed", candidate };
  return { label: action.frames.length ? "Adopted" : "Not generated", candidate };
}
export function spriteActionRepairRun(
  project: SpriteProject,
  state: SpriteState,
  actionId: string,
) {
  return spriteLatestAttempts(state.runs)
    .toReversed()
    .find((run) => {
      if (run.removedAt || !run.source || !["failed", "needs-adjustment"].includes(run.status))
        return false;
      const linked =
        run.configuration?.actions.some((a) => a.id === actionId) ||
        project.provenance.some(
          (p) =>
            p.localActionId === actionId &&
            (p.runId === run.id || p.segmentRunIds?.includes(run.id)),
        );
      if (!linked) return false;
      const candidate = spriteCandidate(run);
      return (
        !candidate ||
        candidate.status === "failed" ||
        !candidate.frames.length ||
        candidate.actions.some((a) => spriteCandidateStructuralErrors(run, a.action.id)) ||
        !spriteCombinedActionRun(run, state.runs)
      );
    });
}
export function spriteCandidateStructuralErrors(run: SpriteRun, actionId: string) {
  const candidate = spriteCandidate(run);
  if (!candidate) return true;
  return spriteStructuralBlockedActions(candidate).has(actionId);
}
export function snapshotSpriteActions(
  project: SpriteProject,
  ids: readonly string[],
): SpriteActionVersion[] {
  const versions = [...(project.actionVersions ?? [])];
  for (const action of project.actions.filter((a) => ids.includes(a.id) && a.frames.length)) {
    const provenance = project.provenance.filter((p) => p.localActionId === action.id);
    const prior = versions.findLast((v) => v.action.id === action.id);
    if (
      prior &&
      JSON.stringify([prior.action, prior.renderSpec, prior.canonical, prior.provenance]) ===
        JSON.stringify([action, project.renderSpec, project.canonical, provenance])
    )
      continue;
    versions.push({
      id: uuid(),
      createdAt: new Date().toISOString(),
      action: structuredClone(action),
      width: project.width,
      height: project.height,
      renderSpec: project.renderSpec,
      canonical: project.canonical,
      provenance,
    });
  }
  if (versions.length > 1024)
    throw new Error(
      "Project exceeds 1024 saved action versions. Remove older versions before continuing.",
    );
  return versions;
}
export function restoreSpriteActionVersion(
  project: SpriteProject,
  id: string,
  restoreCanvas = false,
): SpriteProject {
  const version = project.actionVersions?.find((v) => v.id === id);
  if (!version) throw new Error("Action version not found.");
  if (
    !restoreCanvas &&
    (JSON.stringify(version.renderSpec) !== JSON.stringify(project.renderSpec) ||
      version.width !== project.width ||
      version.height !== project.height)
  )
    throw new Error("Restore the recorded canvas settings before restoring this action version.");
  const versions = snapshotSpriteActions(
    project,
    restoreCanvas ? project.actions.map((a) => a.id) : [version.action.id],
  );
  return {
    ...project,
    ...(restoreCanvas
      ? { width: version.width, height: version.height, renderSpec: version.renderSpec }
      : {}),
    actionVersions: versions,
    actions: project.actions.some((a) => a.id === version.action.id)
      ? project.actions.map((a) =>
          a.id === version.action.id ? structuredClone(version.action) : a,
        )
      : [...project.actions, structuredClone(version.action)],
    selectedActionId: version.action.id,
    provenance: [
      ...project.provenance.filter((p) => p.localActionId !== version.action.id),
      ...version.provenance,
    ],
  };
}
export function spriteExportFileList(
  project: SpriteProject,
  ids: readonly string[],
  mode: "combined" | "atlas" | "sequence",
) {
  return spriteExportLayout(project, ids, mode, 8, 0)?.files ?? [];
}
const blobDigests = new WeakMap<Blob, Promise<string>>();
async function digestBytes(bytes: BufferSource) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
function digestBlob(blob: Blob) {
  let value = blobDigests.get(blob);
  if (!value) {
    value = blob.arrayBuffer().then(digestBytes);
    blobDigests.set(blob, value);
  }
  return value;
}
export async function spriteExportFingerprint(project: SpriteProject, ids: readonly string[]) {
  const actions = project.actions.filter((a) => ids.includes(a.id));
  const sourceIds = new Set(actions.flatMap((a) => a.frames.map((f) => f.sourceId)));
  for (const s of project.sources)
    if (sourceIds.has(s.id) && s.masterSourceId) sourceIds.add(s.masterSourceId);
  const sources = await Promise.all(
    project.sources
      .filter((s) => sourceIds.has(s.id))
      .map(async ({ blob, ...source }) =>
        Object.assign({}, source, { digest: await digestBlob(blob) }),
      ),
  );
  const value = JSON.stringify({
    width: project.width,
    height: project.height,
    renderSpec: project.renderSpec,
    canonical: project.canonical,
    actions,
    sources,
  });
  return digestBytes(new TextEncoder().encode(value));
}
