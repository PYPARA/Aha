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
export function spriteRetryableRuns(runs: readonly SpriteRun[], all: readonly SpriteRun[]) {
  const latest = new Set(spriteLatestAttempts(all).map((r) => r.id));
  return runs.filter(
    (r) =>
      r.status === "failed" &&
      !!r.context.threadId &&
      !r.source &&
      !r.frames.length &&
      !r.candidates?.length &&
      !r.removedAt &&
      latest.has(r.id),
  );
}
