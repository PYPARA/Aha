import type { ImageAsset, SpriteCandidate, SpriteRun } from "@synara/contracts";
/** What "View original image" shows: the generated GIF when there is one, plus its expanded frames. */
export type SpriteOriginalImage = { asset: ImageAsset; frames?: ImageAsset | undefined };
export function spriteOriginalImage(
  candidate: SpriteCandidate | undefined,
  fallback?: ImageAsset | null,
): SpriteOriginalImage | null {
  const source = candidate?.source ?? fallback;
  if (!source) return null;
  const gif = candidate?.animationSource;
  // A GIF that could not be expanded yet is its own source.
  return gif
    ? { asset: gif, frames: gif.id === source.id ? undefined : source }
    : { asset: source };
}
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
