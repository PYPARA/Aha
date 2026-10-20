import { expect, it } from "vitest";
import type { SpriteRun } from "@synara/contracts";
import { spriteAdoption } from "./spriteAdoption";
import { newSpriteProject } from "./spriteModel";
const run = {
  id: "run",
  selectedCandidateId: "candidate",
  source: { id: "candidate" },
  candidates: [
    {
      id: "candidate",
      processingVersionId: "v2",
      actions: [{ action: { id: "idle" }, frames: [{ id: "new-frame" }] }],
    },
  ],
} as unknown as SpriteRun;
it("distinguishes old and current processing versions while retaining the local action mapping", () => {
  const project = newSpriteProject();
  project.provenance = [
    {
      runId: "run",
      candidateId: "candidate",
      actionId: "idle",
      localActionId: project.actions[0]!.id,
      processingVersionId: "v1",
      prompt: "",
      action: "idle",
      model: "",
      providerId: "",
    },
  ];
  project.adoptedCandidateIds = ["run:candidate:idle"];
  expect(spriteAdoption(run, "idle", project)).toEqual({
    status: "update",
    localActionId: project.actions[0]!.id,
  });
  project.provenance[0]!.processingVersionId = "v2";
  expect(spriteAdoption(run, "idle", project).status).toBe("current");
  expect(spriteAdoption(run, "walk", project).status).toBe("new");
});
it("does not guess a local replacement from an old adoption key", () => {
  const project = newSpriteProject();
  project.adoptedCandidateIds = ["run:candidate:idle"];
  expect(spriteAdoption(run, "idle", project)).toEqual({ status: "unknown" });
});
