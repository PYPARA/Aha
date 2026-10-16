import type { ProjectId, ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { useSplitViewStore } from "../splitViewStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { toastManager } from "../components/ui/toast";
import { unarchiveThreadFromClient, isThreadAlreadyUnarchivedError } from "./threadArchive";
import { ensureNativeApi } from "../nativeApi";
import { randomUUID } from "./utils";

/** Surface-independent cleanup. Call only after durable delete, or for a local draft. */
export function clearDeletedThreadResources(threadId: ThreadId, projectId?: ProjectId) {
  const composer = useComposerDraftStore.getState();
  composer.clearDraftThread(threadId);
  if (projectId) composer.clearProjectDraftThreadById(projectId, threadId);
  usePinnedThreadsStore.getState().unpinThread(threadId);
  useSplitViewStore.getState().removeThreadFromSplitViews(threadId);
  useTemporaryThreadStore.getState().clearTemporaryThread(threadId);
  useTerminalStateStore.getState().clearTerminalState(threadId);
  useThreadSelectionStore.getState().removeFromSelection([threadId]);
}

export async function restoreThreadFromClient(threadId: ThreadId) {
  try {
    await unarchiveThreadFromClient(ensureNativeApi().orchestration, threadId);
  } catch (error) {
    if (!isThreadAlreadyUnarchivedError(error, threadId)) throw error;
  }
}

/** The same undo UI in sidebar and embedded chat; navigation stays with the caller. */
export function showThreadArchiveUndoToast(input: {
  threadId: ThreadId;
  onUndo: () => Promise<boolean>;
  onNoUndo: () => void;
  onViewArchived: () => void;
}) {
  let undoPending = false;
  let restored = false;
  let cleanupStarted = false;
  const cleanup = () => {
    if (!undoPending && !restored && !cleanupStarted) {
      cleanupStarted = true;
      input.onNoUndo();
    }
  };
  toastManager.add({
    id: `archive-undo:${input.threadId}:${randomUUID()}`,
    timeout: 0,
    onClose: cleanup,
    data: {
      allowCrossThreadVisibility: true,
      dismissAfterVisibleMs: 8000,
      archiveUndo: {
        onNoUndo: cleanup,
        onUndo: async () => {
          if (undoPending) return false;
          undoPending = true;
          try {
            restored = await input.onUndo();
            return restored;
          } finally {
            undoPending = false;
          }
        },
        onViewArchived: input.onViewArchived,
      },
    },
  });
}
