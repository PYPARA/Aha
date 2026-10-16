import { expect, it } from "vitest";
import { SpriteProjectDataSchema } from "./spriteLibrarySchema";
import { SpriteGenerationInput } from "./spriteAnimation";
import { Schema } from "effect";
const base = {
  version: 1,
  id: "project",
  name: "Fox",
  updatedAt: new Date().toISOString(),
  width: 16,
  height: 16,
  sources: [],
  actions: [{ id: "idle", name: "idle", fps: 12, loop: true, frames: [] }],
  selectedActionId: "idle",
  threadId: "old-chat",
  providerId: "",
  model: "",
  referenceSourceId: null,
  background: "chroma",
  chromaKey: "#00ff00",
  generationFrameCount: 8,
  adoptedCandidateIds: [],
  provenance: [],
};
it("normalizes a legacy single-chat document without changing artwork", () => {
  const p = SpriteProjectDataSchema.parse(base);
  expect(p).toMatchObject({
    threadIds: ["old-chat"],
    activeThreadId: "old-chat",
    actions: base.actions,
  });
  expect(p).not.toHaveProperty("threadId");
});
it("validates unique conversation ids and the selected conversation", () => {
  expect(() =>
    SpriteProjectDataSchema.parse({ ...base, threadIds: ["a", "a"], activeThreadId: "a" }),
  ).toThrow("conversation");
  expect(() =>
    SpriteProjectDataSchema.parse({ ...base, threadIds: ["a"], activeThreadId: "b" }),
  ).toThrow("conversation");
  expect(
    SpriteProjectDataSchema.parse({ ...base, threadIds: ["a", "b"], activeThreadId: "b" })
      .activeThreadId,
  ).toBe("b");
});
it("accepts explicit attachment/candidate reference ids in generation requests", () => {
  for (const referenceId of ["attachment:att_v2_sent", "candidate:run:asset"]) {
    expect(
      Schema.decodeUnknownSync(SpriteGenerationInput)({
        kind: "animation",
        prompt: "walk",
        requestId: "request",
        referenceId,
      }).referenceId,
    ).toBe(referenceId);
  }
});

it("persists per-action adoption keys and provenance alongside legacy candidates", () => {
  const p = SpriteProjectDataSchema.parse({
    ...base,
    adoptedCandidateIds: ["legacy-run", "new-run:walk"],
    provenance: [
      {
        runId: "new-run",
        actionId: "walk",
        planId: "plan",
        prompt: "walk",
        action: "walk",
        model: "image",
        providerId: "drawing",
      },
    ],
  });
  expect(p.adoptedCandidateIds).toEqual(["legacy-run", "new-run:walk"]);
  expect(p.provenance[0]).toMatchObject({ actionId: "walk", planId: "plan" });
});
