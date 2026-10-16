import { expect, it } from "vitest";
import type { SpriteGenerationPlan } from "@synara/contracts";
import { spriteConversationPlanEntries, mergeSpritePlanEntries } from "./spritePlanTimeline";
import { deriveTimelineEntries } from "~/workLog";
import { MessageId } from "@synara/contracts";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
const plan = (id: string, threadId = "thread"): SpriteGenerationPlan => ({
  id,
  threadId,
  projectId: "project",
  turnId: null,
  version: 1,
  status: "draft",
  requestId: id,
  createdAt: "2026-10-14T00:00:02.000Z",
  displayAfter: "2026-10-14T00:00:04.000Z",
  confirmedAt: null,
  configuration: {
    kind: "character",
    mode: "combined",
    prompt: "fox",
    actions: [],
    references: [],
    providerId: "drawing",
    model: "image",
    width: 256,
    height: 256,
    background: "transparent",
    chromaKey: "#00ff00",
    parameters: { n: 1 },
  },
});
it("supplements client-created plans from persistence without duplicating recognized tool cards", () => {
  const entries = spriteConversationPlanEntries([plan("one"), plan("other", "foreign")], "thread");
  const merged = mergeSpritePlanEntries(
    [
      { ...entries[0]!, id: "tool-call" },
      { id: "regular", label: "Read context", tone: "tool", createdAt: "2026-10-14T00:00:01.000Z" },
    ],
    entries,
  );
  expect(merged.map((e) => e.id)).toEqual(["regular", "sprite-plan:one"]);
});
it("keeps a client-created plan after existing explanation and before later user messages", () => {
  const timeline = deriveTimelineEntries(
    [
      {
        id: MessageId.makeUnsafe("user"),
        role: "user",
        text: "A fox",
        streaming: false,
        createdAt: "2026-10-14T00:00:00.000Z",
      },
      {
        id: MessageId.makeUnsafe("answer"),
        role: "assistant",
        text: "Review the plan.",
        streaming: false,
        createdAt: "2026-10-14T00:00:03.000Z",
      },
      {
        id: MessageId.makeUnsafe("next"),
        role: "user",
        text: "Change style",
        streaming: false,
        createdAt: "2026-10-14T00:00:05.000Z",
      },
    ],
    [],
    spriteConversationPlanEntries([plan("one")], "thread"),
  );
  const rows = deriveMessagesTimelineRows({
    timelineEntries: timeline,
    isWorking: false,
    worktreeSetup: null,
    worktreeSetupOpen: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
  expect(rows.map((r) => (r.kind === "message" ? r.message.id : r.id))).toEqual([
    "user",
    "answer",
    "sprite-plan:one",
    "next",
  ]);
});
