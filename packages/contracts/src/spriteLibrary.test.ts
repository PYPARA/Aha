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
it.each([1, 2])(
  "preserves optional frame timing and history in v%i while rejecting invalid durations",
  (version) => {
    const source = {
      id: "image",
      name: "image.png",
      width: 16,
      height: 16,
      mimeType: "image/png",
      file: `images/${"a".repeat(64)}.png`,
    };
    const action = {
      ...base.actions[0]!,
      frames: [
        {
          id: "frame",
          sourceId: "image",
          x: 0,
          y: 0,
          width: 16,
          height: 16,
          offsetX: 0,
          offsetY: 0,
          durationMs: 250,
        },
      ],
    };
    const data = {
      ...base,
      version,
      ...(version === 2
        ? { renderSpec: { mode: "pixel", logicalWidth: 16, logicalHeight: 16, outputScale: 1 } }
        : {}),
      sources: [source],
      actions: [action],
      actionVersions: [
        {
          id: "history",
          createdAt: new Date().toISOString(),
          action,
          width: 16,
          height: 16,
          provenance: [],
        },
      ],
    };
    expect(
      SpriteProjectDataSchema.parse(data).actionVersions![0]!.action.frames[0]!.durationMs,
    ).toBe(250);
    for (const durationMs of [0, -1, Infinity, NaN])
      expect(() =>
        SpriteProjectDataSchema.parse({
          ...data,
          actions: [{ ...action, frames: [{ ...action.frames[0], durationMs }] }],
        }),
      ).toThrow();
    expect(() =>
      SpriteProjectDataSchema.parse({
        ...data,
        actionVersions: [
          {
            ...data.actionVersions[0],
            action: { ...action, frames: [{ ...action.frames[0], sourceId: "missing" }] },
          },
        ],
      }),
    ).toThrow();
  },
);

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
