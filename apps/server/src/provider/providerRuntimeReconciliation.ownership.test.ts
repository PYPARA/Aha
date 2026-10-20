// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { planProviderRuntimeReconciliation } from "./providerRuntimeReconciliation.ts";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";
const NOW = Date.parse("2026-07-23T20:00:30.000Z");
const THREAD_ID = ThreadId.makeUnsafe("thread-reconcile");
const OLD_TURN_ID = TurnId.makeUnsafe("turn-old");
function threadShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-reconcile"),
    title: "Runtime reconciliation",
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: OLD_TURN_ID,
      state: "running",
      requestedAt: "2026-07-23T20:00:00.000Z",
      startedAt: "2026-07-23T20:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
    archivedAt: null,
    handoff: null,
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: OLD_TURN_ID,
      lastError: null,
      updatedAt: "2026-07-23T20:00:00.000Z",
    },
    ...overrides,
  };
}
function binding(
  activeTurnId: string | null = OLD_TURN_ID,
  provider: ProviderRuntimeBinding["provider"] = "codex",
): ProviderRuntimeBinding {
  return {
    threadId: THREAD_ID,
    provider,
    providerInstanceId: provider,
    status: activeTurnId === null ? "stopped" : "running",
    lastSeenAt: "2026-07-23T20:00:00.000Z",
    runtimePayload: { activeTurnId },
  };
}
function liveSession(input: {
  readonly status: ProviderSession["status"];
  readonly activeTurnId?: TurnId;
  readonly provider?: ProviderSession["provider"];
  readonly lastError?: string;
}): ProviderSession {
  return {
    provider: input.provider ?? "codex",
    status: input.status,
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:25.000Z",
  };
}
describe("planProviderRuntimeReconciliation", () => {
  it("preserves a live manual turn beyond the abandonment deadline", () => {
    // Assistant messages and tool progress do not advance the thread shell's
    // updatedAt. A long turn can have an old shell while its adapter is live.
    expect(
      planProviderRuntimeReconciliation({
        threads: [threadShell()],
        bindings: [binding()],
        liveSessions: [liveSession({ status: "running", activeTurnId: OLD_TURN_ID })],
        pumpHealth: [],
        nowMs: NOW + 46 * 60000,
      }),
    ).toEqual([]);
  });
  it("realigns an aged automation startup with the still-live manual turn", () => {
    const thread = threadShell({
      latestTurn: {
        ...threadShell().latestTurn!,
        state: "interrupted",
        completedAt: "2026-07-23T20:00:10.000Z",
      },
      session: { ...threadShell().session!, status: "starting", activeTurnId: null },
    });
    expect(
      planProviderRuntimeReconciliation({
        threads: [thread],
        bindings: [binding(null)],
        liveSessions: [liveSession({ status: "running", activeTurnId: OLD_TURN_ID })],
        pumpHealth: [],
        nowMs: NOW + 46 * 60000,
      }),
    ).toEqual([
      expect.objectContaining({ action: "align-running-turn", runtimeTurnId: OLD_TURN_ID }),
    ]);
  });
  it.each(["completed", "error"] as const)(
    "does not repeatedly reopen a final %s turn",
    (state) => {
      expect(
        planProviderRuntimeReconciliation({
          threads: [
            threadShell({
              latestTurn: {
                ...threadShell().latestTurn!,
                state,
                completedAt: "2026-07-23T20:00:10.000Z",
              },
            }),
          ],
          bindings: [binding()],
          liveSessions: [liveSession({ status: "running", activeTurnId: OLD_TURN_ID })],
          pumpHealth: [],
          nowMs: NOW + 46 * 60000,
        }),
      ).toEqual([]);
    },
  );
  it("settles an abandoned starting session without a binding or live turn", () => {
    expect(
      planProviderRuntimeReconciliation({
        threads: [
          threadShell({
            latestTurn: {
              ...threadShell().latestTurn!,
              state: "interrupted",
              completedAt: "2026-07-23T20:00:10.000Z",
            },
            session: { ...threadShell().session!, status: "starting", activeTurnId: null },
          }),
        ],
        bindings: [],
        liveSessions: [],
        pumpHealth: [],
        nowMs: NOW + 46 * 60000,
      }),
    ).toEqual([expect.objectContaining({ action: "settle-interrupted", projectedTurnId: null })]);
  });
});
