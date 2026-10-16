import { TurnId, type SpriteGenerationPlan } from "@synara/contracts";
import type { WorkLogEntry } from "~/workLog";

export function spriteConversationPlanEntries(
  plans: readonly SpriteGenerationPlan[],
  threadId: string,
): WorkLogEntry[] {
  return plans
    .filter((p) => p.threadId === threadId)
    .map((p) => ({
      id: `sprite-plan:${p.id}`,
      createdAt: p.displayAfter ?? p.createdAt,
      turnId: !p.displayAfter && p.turnId ? TurnId.makeUnsafe(p.turnId) : null,
      label: "Sprite generation plan",
      tone: "tool",
      spritePlan: {
        projectId: p.projectId,
        planId: p.id,
        threadId: p.threadId,
        historical: p.status === "dismissed" && !p.confirmedAt,
      },
    }));
}
export function mergeSpritePlanEntries(
  work: readonly WorkLogEntry[],
  plans: readonly WorkLogEntry[],
): WorkLogEntry[] {
  const ids = new Set(plans.map((p) => p.spritePlan?.planId));
  return [
    ...work.filter((entry) => !entry.spritePlan || !ids.has(entry.spritePlan.planId)),
    ...plans,
  ];
}
