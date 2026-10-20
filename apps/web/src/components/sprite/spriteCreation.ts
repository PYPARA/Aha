import {
  spritePlanTarget,
  type SpriteGenerationPlan,
  type SpritePlanReference,
} from "@synara/contracts";
import { uuid } from "./spriteModel";
export type SpriteCreationTarget = { kind: "character" | "animation"; actionIds: string[] };
export const spriteCreationKey = (target: SpriteCreationTarget) =>
  target.kind === "character" ? "character" : `animation:${target.actionIds.toSorted().join(",")}`;
export const spriteCreationDraftKey = (projectId: string, target: SpriteCreationTarget) =>
  `aha-sprite-creation:v1:${projectId}:${spriteCreationKey(target)}`;
export function spriteTargetDrafts(
  plans: readonly SpriteGenerationPlan[],
  target: SpriteCreationTarget,
) {
  return plans.filter(
    (p) =>
      p.status === "draft" &&
      (p.targetKey ?? spritePlanTarget(p.configuration)) === spriteCreationKey(target),
  );
}
export type SpriteCreationDraft = {
  prompt: string;
  references: SpritePlanReference[];
  requestId: string;
};
export function readSpriteCreationDraft(
  projectId: string,
  target: SpriteCreationTarget,
  fallbackPrompt = "",
): SpriteCreationDraft {
  try {
    const saved = JSON.parse(
      localStorage.getItem(spriteCreationDraftKey(projectId, target)) ?? "null",
    );
    if (
      saved &&
      typeof saved.prompt === "string" &&
      typeof saved.requestId === "string" &&
      Array.isArray(saved.references)
    )
      return saved;
  } catch {
    /* A malformed editing buffer never affects project data. */
  }
  return { prompt: fallbackPrompt, references: [], requestId: uuid() };
}
