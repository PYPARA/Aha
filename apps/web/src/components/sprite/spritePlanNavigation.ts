import type { SpriteGenerationPlan, SpriteCommand, SpriteState } from "@synara/contracts";
import { drawingApi } from "../drawing/useDrawing";

export const SPRITE_PLAN_FOCUS = "aha-sprite-plan-focus";
export function focusSpritePlan(planId: string) {
  sessionStorage.setItem("aha-sprite-plan-focus", planId);
  window.dispatchEvent(new CustomEvent(SPRITE_PLAN_FOCUS, { detail: planId }));
}
export function focusedSpritePlan() {
  return sessionStorage.getItem("aha-sprite-plan-focus");
}
export async function reviseSpritePlan(input: SpriteCommand): Promise<SpriteState> {
  const state = await drawingApi().spriteCommand({ operation: "get", projectId: input.projectId });
  const source = state.plans?.find((p) => p.id === input.planId);
  const run = state.runs.find((r) => r.id === input.runId);
  const threadId = source?.threadId ?? run?.context.threadId ?? input.context?.threadId;
  const current = state.plans?.find((p) => p.threadId === threadId && p.status === "draft");
  const sourceKey = `${run ? `run:${run.id}` : `plan:${source?.id}`}:${input.actionId ?? "all"}`;
  if (current && (current.id === input.planId || current.sourceKey === sourceKey))
    return { ...state, resultPlanId: current.id };
  if (current) throw Object.assign(new Error("A draft already exists."), { currentPlan: current });
  try {
    return await drawingApi().spriteCommand({ ...input, displayAfter: new Date().toISOString() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("draft already exists")) {
      const refreshed = await drawingApi().spriteCommand({
        operation: "get",
        projectId: input.projectId,
      });
      const currentPlan = refreshed.plans?.find(
        (p) => p.threadId === threadId && p.status === "draft",
      );
      if (currentPlan) throw Object.assign(error, { currentPlan });
    }
    throw error;
  }
}
export type SpriteDraftConflict = Error & { currentPlan?: SpriteGenerationPlan };
