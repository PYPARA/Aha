import { beforeEach, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
const mocks = vi.hoisted(() => ({
  clearDraft: vi.fn(),
  clearProjectDraft: vi.fn(),
  unpin: vi.fn(),
  split: vi.fn(),
  temporary: vi.fn(),
  terminal: vi.fn(),
  selection: vi.fn(),
  toast: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      clearDraftThread: mocks.clearDraft,
      clearProjectDraftThreadById: mocks.clearProjectDraft,
    }),
  },
}));
vi.mock("../pinnedThreadsStore", () => ({
  usePinnedThreadsStore: { getState: () => ({ unpinThread: mocks.unpin }) },
}));
vi.mock("../splitViewStore", () => ({
  useSplitViewStore: { getState: () => ({ removeThreadFromSplitViews: mocks.split }) },
}));
vi.mock("../temporaryThreadStore", () => ({
  useTemporaryThreadStore: { getState: () => ({ clearTemporaryThread: mocks.temporary }) },
}));
vi.mock("../terminalStateStore", () => ({
  useTerminalStateStore: { getState: () => ({ clearTerminalState: mocks.terminal }) },
}));
vi.mock("../threadSelectionStore", () => ({
  useThreadSelectionStore: { getState: () => ({ removeFromSelection: mocks.selection }) },
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatch } }),
}));
import {
  clearDeletedThreadResources,
  restoreThreadFromClient,
  showThreadArchiveUndoToast,
} from "./threadLifecycleClient";
beforeEach(() => {
  vi.clearAllMocks();
});
it("clears all ordinary chat resources without navigating or touching sprite artwork", () => {
  const id = ThreadId.makeUnsafe("chat"),
    project = ProjectId.makeUnsafe("home");
  clearDeletedThreadResources(id, project);
  for (const fn of [mocks.clearDraft, mocks.unpin, mocks.split, mocks.temporary, mocks.terminal])
    expect(fn).toHaveBeenCalledExactlyOnceWith(id);
  expect(mocks.clearProjectDraft).toHaveBeenCalledExactlyOnceWith(project, id);
  expect(mocks.selection).toHaveBeenCalledExactlyOnceWith([id]);
});
function toastFixture(onUndo: () => Promise<boolean>) {
  const onNoUndo = vi.fn();
  showThreadArchiveUndoToast({
    threadId: ThreadId.makeUnsafe("chat"),
    onUndo,
    onNoUndo,
    onViewArchived: vi.fn(),
  });
  const toast = mocks.toast.mock.calls[0]![0] as {
    onClose: () => void;
    data: { archiveUndo: { onNoUndo: () => void; onUndo: () => Promise<boolean> } };
  };
  return { toast, onNoUndo };
}
it("never releases an archived worktree during a pending or successful Undo", async () => {
  let resolve!: (value: boolean) => void;
  const task = new Promise<boolean>((done) => {
    resolve = done;
  });
  const { toast, onNoUndo } = toastFixture(() => task);
  const undo = toast.data.archiveUndo.onUndo();
  toast.onClose();
  toast.data.archiveUndo.onNoUndo();
  expect(onNoUndo).not.toHaveBeenCalled();
  resolve(true);
  await undo;
  toast.onClose();
  expect(onNoUndo).not.toHaveBeenCalled();
});
it("only releases once when expiry and dismissal both occur", () => {
  const { toast, onNoUndo } = toastFixture(async () => false);
  toast.data.archiveUndo.onNoUndo();
  toast.onClose();
  expect(onNoUndo).toHaveBeenCalledOnce();
});
it("uses the ordinary unarchive command", async () => {
  await restoreThreadFromClient(ThreadId.makeUnsafe("chat"));
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "thread.unarchive", threadId: "chat" }),
  );
});
