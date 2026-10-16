import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { type TimelineEntry } from "../../session-logic";
import type { WorktreeSetupSnapshot } from "../../types";
import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";
describe("deriveMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<
    MessagesTimelineRow,
    {
      kind: "message";
    }
  >;
  const baseInput = {
    isWorking: false,
    worktreeSetup: null as WorktreeSetupSnapshot | null,
    worktreeSetupOpen: false,
    activeTurnStartedAt: null as string | null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };
  const userEntry = (id: string, createdAt: string, turnId?: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text: "ask",
      createdAt,
      streaming: false,
      ...(turnId ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
    },
  });
  const assistantEntry = (
    id: string,
    createdAt: string,
    opts: {
      turnId?: string;
      text?: string;
      streaming?: boolean;
      completedAt?: string;
    },
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: opts.text ?? "reply",
      createdAt,
      streaming: opts.streaming ?? false,
      ...(opts.turnId ? { turnId: TurnId.makeUnsafe(opts.turnId) } : {}),
      ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    },
  });
  const workEntry = (
    id: string,
    createdAt: string,
    label: string,
    tone: "thinking" | "tool" | "info" | "error" = "tool",
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label, tone },
  });
  const messageRow = (rows: MessagesTimelineRow[], id: string): MessageTimelineRow | undefined =>
    rows.find(
      (row): row is MessageTimelineRow =>
        row.kind === "message" && row.message.id === MessageId.makeUnsafe(id),
    );
  const collapsedSignature = (row: MessageTimelineRow): string[] =>
    (row.collapsedTurnItems ?? []).map((item) => `${item.kind}:${String(item.id)}`);
  it.each([false, true])(
    "keeps sprite generation plans outside settled turn disclosures (conversationOnly=%s)",
    (conversationOnly) => {
      const proposal = workEntry(
        "sprite-plan",
        "2026-01-01T00:00:03Z",
        "Prepare sprite retry plan",
      );
      if (proposal.kind !== "work") throw new Error("Expected work entry");
      proposal.entry.spritePlan = { projectId: "project", planId: "plan", threadId: "thread" };
      const rows = deriveMessagesTimelineRows({
        ...baseInput,
        conversationOnly,
        timelineEntries: [
          userEntry("u1", "2026-01-01T00:00:00Z"),
          assistantEntry("preamble", "2026-01-01T00:00:01Z", {
            turnId: "t1",
            text: "Preparing the plan",
          }),
          workEntry("w1", "2026-01-01T00:00:02Z", "Read sprite context"),
          proposal,
          workEntry("w2", "2026-01-01T00:00:04Z", "Check sprite generation"),
          assistantEntry("final", "2026-01-01T00:00:05Z", {
            turnId: "t1",
            text: "Confirm the plan card.",
            completedAt: "2026-01-01T00:00:06Z",
          }),
        ],
      });
      expect(
        rows
          .filter((row) => row.kind === "work")
          .map((row) => row.groupedEntries.map((entry) => entry.id)),
      ).toEqual([["sprite-plan"]]);
      expect(rows.indexOf(messageRow(rows, "final")!)).toBeLessThan(
        rows.findIndex((row) => row.kind === "work" && row.groupedEntries[0]?.spritePlan),
      );
      if (!conversationOnly)
        expect(collapsedSignature(messageRow(rows, "final")!)).toEqual([
          "narration:preamble",
          "work:w1",
          "work:w2",
        ]);
    },
  );
  it.each([false, true])(
    "keeps sprite plans and inline visuals interactive together (conversationOnly=%s)",
    (conversationOnly) => {
      const plan = workEntry("sprite-plan", "2026-01-01T00:00:02Z", "Confirm sprite plan");
      const visual = workEntry("visual", "2026-01-01T00:00:03Z", "Preview");
      if (plan.kind !== "work" || visual.kind !== "work") throw new Error("Expected work entries");
      plan.entry.spritePlan = { projectId: "project", planId: "plan", threadId: "thread" };
      visual.entry.turnId = TurnId.makeUnsafe("t1");
      visual.entry.inlineVisual = {
        visualId: `vis_${"a".repeat(32)}`,
        format: "components",
        title: "Comparison",
        height: 320,
        byteLength: 100,
        sha256: "a".repeat(64),
      };
      const rows = deriveMessagesTimelineRows({
        ...baseInput,
        conversationOnly,
        timelineEntries: [
          userEntry("u1", "2026-01-01T00:00:00Z"),
          plan,
          visual,
          assistantEntry("final", "2026-01-01T00:00:04Z", {
            turnId: "t1",
            text: "Review the preview and confirm the sprite plan.",
            completedAt: "2026-01-01T00:00:05Z",
          }),
          userEntry("u2", "2026-01-01T00:00:06Z"),
        ],
      });
      expect(rows.filter((row) => row.kind === "inline-visual")).toHaveLength(1);
      const planIndex = rows.findIndex(
        (row) =>
          row.kind === "work" &&
          row.groupedEntries.some((entry) => entry.spritePlan?.planId === "plan"),
      );
      expect(planIndex).toBeGreaterThan(rows.indexOf(messageRow(rows, "final")!));
      expect(planIndex).toBeLessThan(rows.indexOf(messageRow(rows, "u2")!));
    },
  );
  it("places multiple sprite plans after their response without crossing the next user request", () => {
    const plan = (id: string): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: "2026-01-01T00:00:02Z",
      entry: {
        id,
        createdAt: "2026-01-01T00:00:02Z",
        label: "Plan",
        tone: "tool",
        spritePlan: { projectId: "project", planId: id, threadId: "thread" },
      },
    });
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        plan("plan-1"),
        plan("plan-2"),
        assistantEntry("a1", "2026-01-01T00:00:03Z", { turnId: "t1", text: "Confirm below." }),
        userEntry("u2", "2026-01-01T00:00:04Z"),
        assistantEntry("a2", "2026-01-01T00:00:05Z", { turnId: "t2", text: "Next answer." }),
      ],
    });
    expect(rows.map((row) => (row.kind === "message" ? row.message.id : row.id))).toEqual([
      "u1",
      "a1",
      "plan-1",
      "plan-2",
      "u2",
      "a2",
    ]);
  });
  it("groups adjacent abandoned sprite plans without crossing a user message", () => {
    const plan = (id: string): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: "2026-01-01T00:00:02Z",
      entry: {
        id,
        createdAt: "2026-01-01T00:00:02Z",
        label: "Plan",
        tone: "tool",
        spritePlan: { projectId: "p", planId: id, threadId: "t", historical: true },
      },
    });
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        plan("p1"),
        plan("p2"),
        userEntry("u2", "2026-01-01T00:00:03Z"),
        plan("p3"),
      ],
    });
    const work = rows.filter((row) => row.kind === "work");
    expect(work).toHaveLength(2);
    expect(work[0]!.groupedEntries[0]!.spritePlan?.history?.map((p) => p.planId)).toEqual([
      "p1",
      "p2",
    ]);
    expect(work[1]!.groupedEntries[0]!.spritePlan?.planId).toBe("p3");
  });
});
