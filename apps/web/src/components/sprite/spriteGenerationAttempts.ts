import type { SpriteRun } from "@synara/contracts";
export function spriteLatestAttempts(runs: readonly SpriteRun[]) {
  const parents = new Set(runs.map((r) => r.retryOfRunId).filter(Boolean));
  return runs.filter((r) => !parents.has(r.id));
}
export function spriteRunGroup(run: SpriteRun, runs: readonly SpriteRun[]): string {
  if (run.planId) return run.planId;
  let root = run;
  const seen = new Set([root.id]);
  while (root.retryOfRunId) {
    const parent = runs.find((r) => r.id === root.retryOfRunId);
    if (!parent || seen.has(parent.id)) break;
    root = parent;
    seen.add(root.id);
  }
  return root.id;
}
/** Actions are generated only as GIFs; an earlier sprite-sheet request cannot be resent. */
export const spriteSheetRequest = (run: SpriteRun) =>
  run.input.kind === "animation" &&
  (run.submissionParameters ?? run.configuration?.parameters)?.outputFormat !== "gif";
function failedWithoutImages(run: SpriteRun, latest: Set<string>) {
  return (
    run.status === "failed" &&
    !!run.context.threadId &&
    !run.source &&
    !run.frames.length &&
    !run.candidates?.length &&
    !run.removedAt &&
    latest.has(run.id)
  );
}
export function spriteRetryableRuns(runs: readonly SpriteRun[], all: readonly SpriteRun[]) {
  const latest = new Set(spriteLatestAttempts(all).map((r) => r.id));
  return runs.filter((r) => failedWithoutImages(r, latest) && !spriteSheetRequest(r));
}
/** Failed sprite-sheet tasks: replanning them as GIFs is the only way forward. */
export function spriteReplanRuns(runs: readonly SpriteRun[], all: readonly SpriteRun[]) {
  const latest = new Set(spriteLatestAttempts(all).map((r) => r.id));
  return runs.filter((r) => failedWithoutImages(r, latest) && spriteSheetRequest(r));
}
