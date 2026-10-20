import type { SpriteRun } from "@synara/contracts";
import type { SpriteProject } from "./spriteModel";
export type SpriteAdoptionStatus = "new" | "current" | "update" | "unknown";
export function spriteAdoption(
  run: SpriteRun,
  actionId: string,
  project: Pick<SpriteProject, "provenance" | "actions" | "sources" | "adoptedCandidateIds">,
): { status: SpriteAdoptionStatus; localActionId?: string } {
  const candidateId = run.selectedCandidateId ?? run.source?.id;
  const candidate = run.candidates?.find((c) => c.id === candidateId);
  const output = (candidate?.actions ?? run.actions)?.find((a) => a.action.id === actionId);
  const source = project.provenance.findLast(
    (p) =>
      p.runId === run.id &&
      p.actionId === actionId &&
      (p.candidateId ?? run.candidates?.[0]?.id ?? run.source?.id) === candidateId,
  );
  const legacy =
    project.adoptedCandidateIds.includes(`${run.id}:${candidateId}:${actionId}`) ||
    ((run.candidates?.[0]?.id ?? candidateId) === candidateId &&
      (project.adoptedCandidateIds.includes(run.id) ||
        project.adoptedCandidateIds.includes(`${run.id}:${actionId}`)));
  if (!source && !legacy) return { status: "new" };
  const matches = (action: SpriteProject["actions"][number]) =>
    !!output &&
    action.frames.length === output.frames.length &&
    action.frames.every(
      (frame, i) =>
        project.sources.find((s) => s.id === frame.sourceId)?.assetId === output.frames[i]?.id,
    );
  const mapped = source?.localActionId
    ? project.actions.find((a) => a.id === source.localActionId)
    : undefined;
  const historical =
    candidate?.processingVersions?.flatMap((v) =>
      v.actions.filter((a) => a.action.id === actionId),
    ) ?? [];
  const inferred =
    source && !source.localActionId
      ? project.actions.filter(
          (action) =>
            matches(action) ||
            historical.some(
              (prior) =>
                action.frames.length === prior.frames.length &&
                action.frames.every(
                  (f, i) =>
                    project.sources.find((s) => s.id === f.sourceId)?.assetId ===
                    prior.frames[i]?.id,
                ),
            ),
        )
      : [];
  const local = mapped ?? (inferred.length === 1 ? inferred[0] : undefined);
  if (!local) return { status: source?.localActionId ? "new" : "unknown" };
  const current =
    source?.processingVersionId && candidate?.processingVersionId
      ? source.processingVersionId === candidate.processingVersionId
      : matches(local);
  return { status: current ? "current" : "update", localActionId: local.id };
}
