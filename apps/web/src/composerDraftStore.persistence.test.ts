import { OrchestrationProposedPlanId, ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
} from "./composerDraftPersistence";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import {
  makeImage,
  makeQueuedChatTurn,
  makeQueuedTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";
describe("composerDraftStore persisted-state hydration", () => {
  it("keeps the queue stop and resume markers only while the queue has entries", () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-queue-resume");
    const store = useComposerDraftStore.getState();
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("resume-queue"));
    const roundTrip = () => {
      const persisted = normalizeCurrentPersistedComposerDraftStoreState(
        JSON.parse(
          JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
        ),
      );
      return toHydratedThreadDraft(threadId, persisted.draftsByThreadId[threadId]!);
    };
    store.pauseQueuedTurnsAfterStop(threadId, "turn-stopped");
    expect(roundTrip().queueStoppedTurnId).toBe("turn-stopped");
    store.resumeQueuedTurns(threadId, "turn-failed");
    const resumed = roundTrip();
    expect(resumed.queueStoppedTurnId).toBeUndefined();
    expect(resumed.queueResumedTurnId).toBe("turn-failed");
    store.removeQueuedTurn(threadId, "resume-queue");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
  it("normalizes null and empty persisted states", () => {
    const emptyState = {
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    };
    expect(normalizeCurrentPersistedComposerDraftStoreState(null)).toEqual(emptyState);
    expect(normalizeCurrentPersistedComposerDraftStoreState({})).toEqual(emptyState);
  });
  it("hydrates project mappings, defaults, and persisted selections", () => {
    const projectId = ProjectId.makeUnsafe("project-hydration");
    const threadId = ThreadId.makeUnsafe("thread-hydration");
    const mappingKey = `${projectId}::terminal`;
    const hydrated = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadId: {
        [threadId]: {
          prompt: "Review these selections",
          attachments: [],
          assistantSelections: [
            {
              id: "assistant-selection-1",
              assistantMessageId: " assistant-message-1 ",
              text: " selected assistant text ",
            },
          ],
          fileComments: [
            {
              id: "file-comment-1",
              path: " src/example.ts ",
              startLine: 8,
              endLine: 4,
              text: " selected file text ",
            },
          ],
        },
      },
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: { [mappingKey]: threadId },
    });
    expect(hydrated.projectDraftThreadIdByProjectId).toEqual({ [mappingKey]: threadId });
    expect(hydrated.draftThreadsByThreadId[threadId]).toMatchObject({
      projectId,
      runtimeMode: "full-access",
      interactionMode: "default",
      entryPoint: "terminal",
    });
    expect(hydrated.draftsByThreadId[threadId]?.assistantSelections).toEqual([
      {
        id: "assistant-selection-1",
        assistantMessageId: "assistant-message-1",
        text: "selected assistant text",
      },
    ]);
    expect(hydrated.draftsByThreadId[threadId]?.fileComments).toEqual([
      {
        id: "file-comment-1",
        path: "src/example.ts",
        startLine: 8,
        endLine: 8,
        text: "selected file text",
      },
    ]);
  });
});
describe("composerDraftStore restored source proposed plan", () => {
  const threadId = ThreadId.makeUnsafe("thread-restored-source");
  beforeEach(() => {
    resetComposerDraftStore();
  });
  it("persists restored plan source metadata with composer drafts", () => {
    const restoredSource = {
      threadId,
      restoredPrompt: "Implement the accepted plan",
      sourceProposedPlan: {
        threadId,
        planId: OrchestrationProposedPlanId.makeUnsafe("plan-restored-source"),
      },
    };
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, restoredSource.restoredPrompt);
    store.setRestoredSourceProposedPlan(threadId, restoredSource);
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = partializeComposerDraftStoreState(
      useComposerDraftStore.getState(),
    ) as unknown as {
      draftsByThreadId?: Record<
        string,
        {
          restoredSourceProposedPlan?: unknown;
        }
      >;
    };
    expect(persistedState.draftsByThreadId?.[threadId]?.restoredSourceProposedPlan).toEqual(
      restoredSource,
    );
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());
    expect(mergedState.draftsByThreadId[threadId]?.restoredSourceProposedPlan).toEqual(
      restoredSource,
    );
  });
});
describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });
  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectId: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );
    expect(mergedState.draftsByThreadId[threadId]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadId).toEqual({});
    expect(mergedState.projectDraftThreadIdByProjectId).toEqual({});
  });
});
describe("composerDraftStore queued follow-ups", () => {
  const threadId = ThreadId.makeUnsafe("thread-queue");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;
  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });
  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });
  it("keeps queued turns when the live composer draft is cleared", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "temporary prompt");
    store.setSkills(threadId, [{ name: "check-code", path: "/skills/check-code" }]);
    store.setMentions(threadId, [{ name: "linear", path: "plugin://linear" }]);
    store.enqueueQueuedTurn(threadId, makeQueuedTurn("queued-1"));
    store.clearComposerContent(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "",
      skills: [],
      mentions: [],
      queuedTurns: [makeQueuedTurn("queued-1")],
    });
  });
  it("drops the draft entry once the last queued turn is removed", () => {
    const store = useComposerDraftStore.getState();
    store.enqueueQueuedTurn(threadId, makeQueuedTurn("queued-1"));
    store.removeQueuedTurn(threadId, "queued-1");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
  it("persists queued chat turns for refresh and restart rehydration", () => {
    const queuedImage = makeImage({
      id: "queued-image-persisted",
      previewUrl: "data:image/png;base64,AA==",
      name: "queued.png",
    });
    const store = useComposerDraftStore.getState();
    const queuedChatTurn = makeQueuedChatTurn("queued-chat-1", queuedImage);
    if (queuedChatTurn.kind !== "chat") {
      throw new Error("Expected a queued chat turn fixture");
    }
    store.enqueueQueuedTurn(threadId, {
      ...queuedChatTurn,
      interactionMode: "debug",
    });
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = partializeComposerDraftStoreState(
      useComposerDraftStore.getState(),
    ) as unknown as {
      draftsByThreadId?: Record<
        string,
        {
          queuedTurns?: Array<Record<string, unknown>>;
        }
      >;
    };
    expect(persistedState.draftsByThreadId?.[threadId]?.queuedTurns).toHaveLength(1);
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());
    expect(mergedState.draftsByThreadId[threadId]?.queuedTurns).toMatchObject([
      {
        id: "queued-chat-1",
        kind: "chat",
        prompt: "queued chat prompt",
        images: [{ name: "queued.png" }],
        sourceProposedPlan: {
          threadId: "thread-source-plan",
          planId: "plan-1",
        },
        terminalContexts: [{ text: "git status\nOn branch main" }],
        interactionMode: "debug",
      },
    ]);
  });
  it("revokes queued chat image blob URLs when a queued turn is removed", () => {
    const queuedImage = makeImage({
      id: "queued-image-blob",
      previewUrl: "blob:queued-image-blob",
    });
    const store = useComposerDraftStore.getState();
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-chat-blob", queuedImage));
    store.removeQueuedTurn(threadId, "queued-chat-blob");
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-image-blob");
  });
  it("revokes queued chat image blob URLs when a draft thread is cleared", () => {
    const queuedImage = makeImage({
      id: "queued-image-thread-clear",
      previewUrl: "blob:queued-image-thread-clear",
    });
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(ProjectId.makeUnsafe("queue-project"), threadId);
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-chat-thread-clear", queuedImage));
    store.clearDraftThread(threadId);
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-image-thread-clear");
  });
});
