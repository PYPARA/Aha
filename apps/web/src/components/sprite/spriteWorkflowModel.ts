/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import {
  spriteStructuralBlockedActions,
  type SpriteRun,
  type SpriteActionOutput,
  type SpriteProcessingSnapshot,
  type SpriteTaskSnapshot,
} from "@synara/contracts";
import { spriteLatestAttempts } from "./spriteGenerationAttempts";

export function spriteTaskSnapshots(
  run: SpriteRun,
  all: readonly SpriteRun[],
): SpriteTaskSnapshot[] {
  const parts = run.assembledRunIds
    ? run.assembledRunIds.flatMap((id) => all.find((part) => part.id === id) ?? [])
    : [run];
  return parts.flatMap((part) => {
    const c = part.configuration;
    if (!c?.renderSpec || !c.segment || !c.layout) return [];
    const candidate = part.candidates?.find(
      (candidate) => candidate.id === part.selectedCandidateId,
    );
    return [
      {
        runId: part.id,
        canonicalRevision: c.canonical?.revision,
        renderSpec: c.renderSpec,
        segment: c.segment,
        layout: c.layout,
        sourceAssetId: candidate?.source.id ?? part.source?.id,
        processingVersionId: candidate?.processingVersionId,
      },
    ];
  });
}

export function spriteProcessingSnapshots(
  run: SpriteRun,
  all: readonly SpriteRun[],
): SpriteProcessingSnapshot[] {
  const parts = run.assembledRunIds
    ? run.assembledRunIds.flatMap((id) => all.find((p) => p.id === id) ?? [])
    : [run];
  return parts.flatMap((part) => {
    const candidate = part.candidates?.find((c) => c.id === part.selectedCandidateId);
    return candidate?.slice
      ? [
          {
            version: 1 as const,
            runId: part.id,
            sourceAssetId: candidate.source.id,
            processingVersionId: candidate.processingVersionId,
            renderSpec: part.context.renderSpec,
            configuration: candidate.slice,
          },
        ]
      : [];
  });
}
/** A complete action is assembled by global frame index, never by completion order. */
export function spriteCombinedActionRun(
  run: SpriteRun,
  all: readonly SpriteRun[],
): SpriteRun | undefined {
  const segment = run.configuration?.segment;
  if (!segment || segment.count === 1) return run;
  const byStart = new Map<number, SpriteRun>();
  for (const part of spriteLatestAttempts(all).filter(
    (r) =>
      !r.removedAt &&
      (run.configuration?.sequenceId
        ? r.configuration?.sequenceId === run.configuration.sequenceId
        : r.planId === run.planId) &&
      r.configuration?.segment?.actionId === segment.actionId &&
      r.configuration?.canonical?.revision === run.configuration?.canonical?.revision,
  ))
    byStart.set(part.configuration!.segment!.frameStart, part);
  const parts = [...byStart.values()].toSorted(
    (a, b) => a.configuration!.segment!.frameStart - b.configuration!.segment!.frameStart,
  );
  if (parts.length !== segment.count) return;
  let expected = 0;
  const records = parts.map((part) =>
    part.candidates?.find((c) => c.id === part.selectedCandidateId),
  );
  for (const [i, part] of parts.entries()) {
    const piece = part.configuration!.segment!,
      candidate = records[i];
    if (
      piece.frameStart !== expected ||
      !candidate ||
      !["ready", "needs-adjustment"].includes(candidate.status) ||
      spriteStructuralBlockedActions(candidate).size ||
      (!candidate.slice?.edit && candidate.frames.length !== piece.frameCount)
    )
      return;
    expected += piece.frameCount;
  }
  if (expected !== segment.totalFrames) return;
  const first = parts[0]!,
    candidate = records[0]!;
  const grouped = new Map<string, SpriteActionOutput[]>();
  for (const [index, record] of records.entries())
    for (const output of record!.actions) {
      const current = grouped.get(output.action.id) ?? [];
      grouped.set(output.action.id, [
        ...current,
        {
          ...output,
          frameMetadata: output.frameMetadata?.map((f) => ({
            ...f,
            id: `${parts[index]!.id}-${f.id}`.slice(0, 128),
          })),
        },
      ]);
    }
  const actions: SpriteActionOutput[] = [...grouped.values()].map((outputs) => {
    const frames = outputs.flatMap((o) => o.frames),
      masters = outputs.flatMap((o) => o.masters ?? []),
      metadata = outputs.flatMap((o) => o.frameMetadata ?? []);
    return {
      action: { ...outputs[0]!.action, frameCount: frames.length },
      frames,
      warnings: outputs.flatMap((o) => o.warnings),
      ...(masters.length === frames.length ? { masters } : {}),
      ...(metadata.length === frames.length ? { frameMetadata: metadata } : {}),
    };
  });
  const frames = actions.flatMap((o) => o.frames),
    warnings = parts.flatMap((p) => p.warnings);
  const signature = records
    .map((c) => `${c!.processingVersionId ?? c!.id}:${c!.analysisRevision ?? 0}`)
    .join("|");
  let hash = 2166136261;
  for (let i = 0; i < signature.length; i++)
    hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  const processingVersionId = `segments-${(hash >>> 0).toString(16)}`;
  const combined = {
    ...candidate,
    frames,
    actions,
    warnings,
    processingVersionId,
    reviews: actions.flatMap(({ action }) =>
      records.every(
        (c) =>
          !c!.actions.some((a) => a.action.id === action.id) ||
          c!.slice?.reviewedActionIds.includes(action.id) ||
          c!.reviews?.some(
            (r) =>
              r.actionId === action.id &&
              r.processingVersionId === c!.processingVersionId &&
              r.analysisRevision === (c!.analysisRevision ?? 0),
          ),
      )
        ? [
            {
              actionId: action.id,
              processingVersionId,
              analysisRevision: candidate.analysisRevision ?? 0,
              createdAt: records[0]!.reviews?.[0]?.createdAt ?? "",
            },
          ]
        : [],
    ),
    slice: undefined,
    issues: parts.flatMap((p, i) =>
      (records[i]!.issues ?? []).map((issue) =>
        Object.assign({}, issue, {
          frameIndex:
            issue.frameIndex === null
              ? null
              : issue.frameIndex + p.configuration!.segment!.frameStart,
        }),
      ),
    ),
    status: "ready" as const,
  };
  return {
    ...first,
    assembledRunIds: parts.map((p) => p.id),
    frames,
    actions,
    warnings,
    status: "ready",
    candidates: [combined],
    selectedCandidateId: combined.id,
  };
}

/** Resolve by immutable asset identity, including a repaired later segment. */
export function spriteFrameRun(
  run: SpriteRun,
  all: readonly SpriteRun[],
  assetId: string | undefined,
) {
  if (assetId) {
    const ids = new Set(run.assembledRunIds ?? [run.id]);
    for (const part of all.filter((r) => ids.has(r.id))) {
      const record = part.candidates?.find((c) => c.id === part.selectedCandidateId);
      const index = (record?.frames ?? part.frames).findIndex((f) => f.id === assetId);
      if (index >= 0) return { run: part, index };
    }
  }
  return { run, index: 0 };
}
