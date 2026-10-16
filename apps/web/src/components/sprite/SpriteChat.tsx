import { useCallback, useEffect, useRef, useState } from "react";
import { ThreadId } from "@synara/contracts";
import ChatView from "../ChatView";
import { ensureNativeApi } from "~/nativeApi";
import { useAppSettings, getProviderInstanceOptions } from "~/appSettings";
import { useStore } from "~/store";
import { ensureHomeChatProject } from "~/lib/chatProjects";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import {
  SpriteConversationPicker,
  type SpriteConversationOption,
} from "./SpriteConversationPicker";
import { deleteActiveThreadFromClient } from "~/lib/activeThreadDelete";
import { archiveThreadFromClient } from "~/lib/threadArchive";
import {
  clearDeletedThreadResources,
  restoreThreadFromClient,
  showThreadArchiveUndoToast,
} from "~/lib/threadLifecycleClient";
import { releaseOrphanedWorktreeAfterArchive } from "~/lib/archiveThreadWorktreeCleanup";
import { createDraftThread } from "~/lib/draftThreadCreate";
import {
  useComposerDraftStore,
  resolvePreferredComposerModelSelection,
} from "~/composerDraftStore";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { type SpriteProject } from "./spriteModel";
import type { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { Button } from "../ui/button";
import { DEFAULT_RUNTIME_MODE, DEFAULT_INTERACTION_MODE } from "~/types";
import { useAhaTranslation } from "~/aha/AppearanceProvider";

export function SpriteChat({
  project,
  onThread,
  onThreads,
  onCreateReady,
  syncContext,
  onError,
  attachmentBridge,
}: {
  project: SpriteProject;
  onThread: (id: string, activate?: boolean) => Promise<void>;
  onThreads: (ids: string[], active: string | null) => Promise<void>;
  onCreateReady: (create: (() => Promise<ThreadId>) | null) => void;
  syncContext: () => Promise<void>;
  onError: (error: unknown) => void;
  attachmentBridge: EmbeddedChatAttachments;
}) {
  const tr = useAhaTranslation(),
    { settings } = useAppSettings();
  const [threadId, setThreadId] = useState<ThreadId | null>(
    project.activeThreadId ? ThreadId.makeUnsafe(project.activeThreadId) : null,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error" | "empty">(
    "loading",
  );
  const pending = useRef<Promise<ThreadId> | null>(null);
  const createdDraft = useRef<ThreadId | null>(null);
  const callbacks = useRef({ onThread, onThreads, syncContext, onError, settings });
  callbacks.current = { onThread, onThreads, syncContext, onError, settings };
  const linkedId = useRef(project.activeThreadId);
  linkedId.current = project.activeThreadId;
  const [busy, setBusy] = useState(false);
  const titles = useStore((s) => s.threadShellById);
  const turnStates = useStore((s) => s.threadTurnStateById);
  const shellSequence = useStore((s) => s.shellSnapshotSequence);
  const drafts = useComposerDraftStore((s) => s.draftThreadsByThreadId);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingAssociation, setPendingAssociation] = useState<{
    ids: string[];
    active: string | null;
  } | null>(null);
  const reconcileBusy = useRef(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const conversations: SpriteConversationOption[] = project.threadIds.map((id, i) => {
    const shell = titles?.[ThreadId.makeUnsafe(id)];
    const draft = drafts[ThreadId.makeUnsafe(id)];
    return {
      id,
      title: shell?.title || `${tr("Conversation")} ${i + 1}`,
      archived: shell?.archivedAt != null,
      draft: !!draft && !shell,
      running: turnStates?.[ThreadId.makeUnsafe(id)]?.latestTurn?.state === "running",
      updatedAt: shell?.updatedAt ?? draft?.createdAt ?? "",
    };
  });
  const persistAssociations = async (ids: string[], active: string | null) => {
    setPendingAssociation({ ids, active });
    await callbacks.current.onThreads(ids, active);
    setPendingAssociation(null);
  };
  const create = useCallback(() => {
    if (pending.current) return pending.current;
    pending.current = (async () => {
      const projectId = await ensureHomeChatProject(useWorkspacePathsStore.getState());
      if (!projectId) throw new Error("Chat workspace is not ready. Try again after connecting.");
      const prefs = callbacks.current.settings;
      const composer = useComposerDraftStore.getState();
      const modelSelection = resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: composer.stickyModelSelectionByProvider,
          activeProvider: composer.stickyActiveProvider,
        },
        threadModelSelection: null,
        projectModelSelection: useStore.getState().projects.find((p) => p.id === projectId)
          ?.defaultModelSelection,
        defaultProvider: prefs.defaultProvider,
        resolveProviderForInstanceId: (instanceId) =>
          getProviderInstanceOptions(prefs).find((p) => p.instanceId === instanceId)?.provider,
      });
      const id =
        createdDraft.current ??
        createDraftThread({
          projectId,
          prompt: "",
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          envMode: "local",
        });
      createdDraft.current = id;
      // Link the stable draft ID before any send. Retry preserves this draft's content.
      await callbacks.current.onThread(id);
      setThreadId(id);
      return id;
    })();
    void pending.current.catch(() => {
      pending.current = null;
    });
    return pending.current;
  }, []);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setStatus("loading");
    try {
      if (!linkedId.current) {
        setThreadId(null);
        setStatus("empty");
        return;
      }
      const id = ThreadId.makeUnsafe(linkedId.current);
      if (generation !== loadGeneration.current) return;
      setThreadId(id);
      if (useComposerDraftStore.getState().draftThreadsByThreadId[id]) {
        setStatus("ready");
        return;
      }
      // A successful fresh snapshot confirms absence; initial hydration is not evidence.
      const api = ensureNativeApi();
      const snapshot = await api.orchestration.getShellSnapshot();
      if (generation !== loadGeneration.current) return;
      useStore.getState().syncServerShellSnapshot(snapshot);
      setStatus(snapshot.threads.some((t) => t.id === id) ? "ready" : "missing");
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      callbacks.current.onError(e);
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    const counter = loadGeneration;
    void load();
    return () => {
      counter.current++;
    };
  }, [load, project.activeThreadId]);
  useEffect(() => (threadId ? retainThreadDetailSubscription(threadId) : undefined), [threadId]);
  const initialize = useCallback(
    async (id: ThreadId) => {
      const api = ensureNativeApi();
      const detail = await api.orchestration.getThreadDetailSnapshot({ threadId: id });
      if (!detail) throw new Error("The linked conversation is unavailable. Your artwork is safe.");
      if (detail.thread.archivedAt) throw new Error("Restore this conversation before sending.");
      await onThread(id, false);
      await syncContext();
    },
    [onThread, syncContext],
  );
  const createConversation = useCallback(async () => {
    // Retry a failed association with the same draft, but each explicit success is independent.
    if (
      createdDraft.current &&
      (projectRef.current.threadIds.includes(createdDraft.current) ||
        !useComposerDraftStore.getState().draftThreadsByThreadId[createdDraft.current])
    ) {
      pending.current = null;
      createdDraft.current = null;
    }
    await callbacks.current.syncContext();
    const id = await create();
    setStatus("ready");
    setShowArchived(false);
    return id;
  }, [create]);
  useEffect(() => {
    onCreateReady(createConversation);
    return () => onCreateReady(null);
  }, [createConversation, onCreateReady]);
  const nextActive = (ids: string[], excluded?: string) =>
    ids
      .filter((id) => id !== excluded && titles?.[ThreadId.makeUnsafe(id)]?.archivedAt == null)
      .toSorted((a, b) =>
        (
          titles?.[ThreadId.makeUnsafe(b)]?.updatedAt ??
          drafts[ThreadId.makeUnsafe(b)]?.createdAt ??
          ""
        ).localeCompare(
          titles?.[ThreadId.makeUnsafe(a)]?.updatedAt ??
            drafts[ThreadId.makeUnsafe(a)]?.createdAt ??
            "",
        ),
      )[0] ?? null;
  const run = async (task: () => Promise<unknown>) => {
    if (busy || pendingAssociation) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const manage = async (action: "archive" | "restore" | "delete") => {
    const id = projectRef.current.activeThreadId;
    if (!id) return;
    const threadId = ThreadId.makeUnsafe(id);
    const api = ensureNativeApi();
    const draft = useComposerDraftStore.getState().draftThreadsByThreadId[threadId];
    const title = titles?.[threadId]?.title ?? tr("Conversation");
    const shouldConfirm =
      action === "archive"
        ? settings.confirmThreadArchive
        : action === "delete"
          ? settings.confirmThreadDelete
          : false;
    if (
      shouldConfirm &&
      !(await api.dialogs.confirm(
        [
          `${tr(action === "archive" ? "Archive conversation" : "Delete conversation")}: ${title}?`,
          tr(
            action === "archive"
              ? "Archived conversations can be restored later."
              : "This permanently deletes conversation history. Adopted sprite artwork, actions and frames are kept.",
          ),
        ].join("\n"),
      ))
    )
      return;
    await syncContext();
    if (action === "restore") {
      await restoreThreadFromClient(threadId);
      useStore.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
      setShowArchived(false);
      return;
    }
    if (action === "archive") {
      const sequence = await archiveThreadFromClient(api.orchestration, threadId);
      useStore.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
      showThreadArchiveUndoToast({
        threadId,
        onNoUndo: () => {
          void releaseOrphanedWorktreeAfterArchive({
            threadId,
            archiveSequence: sequence,
            enabled: settings.archiveDeletesOrphanedWorktree,
            removeWorktree: (input) => api.git.removeWorktree(input),
          });
        },
        onUndo: async () => {
          try {
            await restoreThreadFromClient(threadId);
            useStore.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
            await callbacks.current.onThread(id);
            setShowArchived(false);
            return true;
          } catch (error) {
            callbacks.current.onError(error);
            return false;
          }
        },
        onViewArchived: () => setShowArchived(true),
      });
      await persistAssociations(
        projectRef.current.threadIds,
        nextActive(projectRef.current.threadIds, id),
      );
    } else {
      if (draft && !draft.promotedTo && !titles?.[threadId])
        clearDeletedThreadResources(threadId, draft.projectId);
      else {
        await deleteActiveThreadFromClient({
          threadId,
          onDeleted: ({ thread }) => clearDeletedThreadResources(threadId, thread.projectId),
          removeWorktree: (input) => api.git.removeWorktree(input),
        });
      }
      const ids = projectRef.current.threadIds.filter((linked) => linked !== id);
      await persistAssociations(ids, nextActive(ids));
    }
  };
  // A fresh server snapshot confirms absence. Initial hydration cannot delete associations.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (reconcileBusy.current || busy || pendingAssociation) return;
      reconcileBusy.current = true;
      void (async () => {
        const api = ensureNativeApi();
        const p = projectRef.current;
        const snapshot = await api.orchestration.getShellSnapshot();
        // A reply older than a promotion/delete push cannot prove a chat is missing.
        if (
          snapshot.snapshotSequence < (useStore.getState().shellSnapshotSequence ?? 0) ||
          projectRef.current.threadIds !== p.threadIds ||
          projectRef.current.activeThreadId !== p.activeThreadId
        )
          return;
        const localDrafts = useComposerDraftStore.getState().draftThreadsByThreadId;
        const ids = p.threadIds.filter(
          (id) => localDrafts[ThreadId.makeUnsafe(id)] || snapshot.threads.some((t) => t.id === id),
        );
        const active = p.activeThreadId;
        const activeShell = snapshot.threads.find((t) => t.id === active);
        const removed = ids.length !== p.threadIds.length;
        const archived = activeShell?.archivedAt != null;
        if (removed || archived) {
          const next =
            !active || !ids.includes(active) || archived
              ? (ids
                  .filter(
                    (id) =>
                      localDrafts[ThreadId.makeUnsafe(id)] ||
                      snapshot.threads.some((t) => t.id === id && t.archivedAt == null),
                  )
                  .toSorted((a, b) =>
                    (
                      snapshot.threads.find((t) => t.id === b)?.updatedAt ??
                      localDrafts[ThreadId.makeUnsafe(b)]?.createdAt ??
                      ""
                    ).localeCompare(
                      snapshot.threads.find((t) => t.id === a)?.updatedAt ??
                        localDrafts[ThreadId.makeUnsafe(a)]?.createdAt ??
                        "",
                    ),
                  )[0] ?? null)
              : active;
          // An archived conversation explicitly opened from the picker remains viewable.
          if (removed || !showArchived) await persistAssociations(ids, next);
        }
      })()
        .catch(callbacks.current.onError)
        .finally(() => {
          reconcileBusy.current = false;
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [
    shellSequence,
    project.threadIds,
    project.activeThreadId,
    busy,
    pendingAssociation,
    showArchived,
  ]);
  return (
    <section
      className="flex min-h-0 min-w-64 w-[420px] max-w-[65vw] shrink-0 resize-x flex-col overflow-auto border-l bg-background"
      aria-label={tr("Sprite conversation")}
    >
      <SpriteConversationPicker
        conversations={conversations}
        activeId={project.activeThreadId}
        busy={
          busy ||
          status === "loading" ||
          pendingAssociation !== null ||
          (!!drafts[project.activeThreadId as ThreadId]?.promotedTo &&
            !titles?.[project.activeThreadId as ThreadId])
        }
        showArchived={showArchived}
        onShowArchived={setShowArchived}
        onSelect={(id) =>
          void run(async () => {
            await syncContext();
            await onThread(id);
          })
        }
        onNew={() => void run(createConversation)}
        onAction={(action) => void run(() => manage(action))}
      />
      {pendingAssociation && (
        <div role="alert" className="flex items-center gap-2 px-3 py-2 text-ui text-destructive">
          <span>{tr("Conversation updated. Project association still needs saving.")}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void persistAssociations(pendingAssociation.ids, pendingAssociation.active)
                .catch(onError)
                .finally(() => setBusy(false));
            }}
          >
            {tr("Retry")}
          </Button>
        </div>
      )}
      {status === "ready" && threadId ? (
        <ChatView
          key={threadId}
          threadId={threadId}
          attachmentBridge={attachmentBridge}
          hideHeader
          paneScopeId={`sprite-${project.id}`}
          surfaceMode="split"
          isFocusedPane
          beforeTurnDispatch={initialize}
          panelState={{
            panel: null,
            diffTurnId: null,
            diffFilePath: null,
            hasOpenedPanel: false,
            lastOpenPanel: "browser",
          }}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {status === "loading" && <p>{tr("Loading…")}</p>}
          {status === "error" && (
            <Button variant="outline" onClick={() => void load()}>
              {tr("Retry")}
            </Button>
          )}
          {status === "empty" && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(createConversation)}
              >
                {tr("New conversation")}
              </Button>
              <Button variant="ghost" onClick={() => setShowArchived(true)}>
                {tr("View archived conversations")}
              </Button>
            </>
          )}
          {status === "missing" && (
            <>
              <p className="text-sm">
                {tr("The linked conversation is unavailable. Your artwork is safe.")}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(createConversation)}
              >
                {tr("Start a new conversation")}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
