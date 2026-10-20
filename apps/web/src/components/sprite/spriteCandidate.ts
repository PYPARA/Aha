import type { SpriteRun } from "@synara/contracts";
export const SPRITE_TASK_OPEN = "aha-sprite-task-open";
export const spriteCandidate = (
  run: SpriteRun,
): import("@synara/contracts").SpriteCandidate | undefined =>
  run.candidates?.find((c) => c.id === (run.selectedCandidateId ?? run.source?.id)) ??
  (!run.candidates?.length && run.source
    ? {
        id: run.source.id,
        source: run.source,
        status:
          run.status === "ready"
            ? "ready"
            : run.status === "failed"
              ? "failed"
              : "needs-adjustment",
        frames: run.frames,
        actions: run.actions ?? [],
        warnings: run.warnings,
        error: run.error,
      }
    : undefined);
