import "../../index.css";
import { useState } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SpriteChat } from "./SpriteChat";
import { newSpriteProject, type SpriteProject } from "./spriteModel";
import { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
const mocks = vi.hoisted(() => ({
  shell: {
    threadShellById: {} as Record<
      string,
      { id: string; title: string; archivedAt: string | null; updatedAt: string }
    >,
    threadTurnStateById: {},
    shellSnapshotSequence: 1,
  },
  drafts: {
    draftThreadsByThreadId: {} as Record<string, { projectId: string; createdAt: string }>,
  },
  listeners: new Set<() => void>(),
  draftListeners: new Set<() => void>(),
  snapshot: vi.fn(),
  dispatch: vi.fn(),
  confirm: vi.fn(),
  persist: vi.fn(),
  sync: vi.fn(),
  error: vi.fn(),
  create: vi.fn(),
  clear: vi.fn(),
  archiveToast: vi.fn(),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { confirmThreadArchive: true, confirmThreadDelete: true } }),
  getProviderInstanceOptions: () => [],
}));
vi.mock("~/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const store = Object.assign(
    (select: (s: typeof mocks.shell) => unknown) =>
      useSyncExternalStore(
        (listen) => {
          mocks.listeners.add(listen);
          return () => {
            mocks.listeners.delete(listen);
          };
        },
        () => select(mocks.shell),
      ),
    { getState: () => ({ ...mocks.shell, projects: [], syncServerShellSnapshot: () => {} }) },
  );
  return { useStore: store };
});
vi.mock("~/composerDraftStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useComposerDraftStore: Object.assign(
      (select: (s: typeof mocks.drafts) => unknown) =>
        useSyncExternalStore(
          (listen) => {
            mocks.draftListeners.add(listen);
            return () => {
              mocks.draftListeners.delete(listen);
            };
          },
          () => select(mocks.drafts),
        ),
      { getState: () => mocks.drafts },
    ),
    resolvePreferredComposerModelSelection: () => ({ provider: "codex", model: "chosen-model" }),
  };
});
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: {
      getShellSnapshot: mocks.snapshot,
      dispatchCommand: mocks.dispatch,
      getThreadDetailSnapshot: async () => ({ thread: { notes: "User notes" } }),
    },
    dialogs: { confirm: mocks.confirm },
    git: { removeWorktree: vi.fn() },
  }),
}));
vi.mock("~/lib/chatProjects", () => ({ ensureHomeChatProject: async () => "home" }));
vi.mock("~/workspacePathsStore", () => ({ useWorkspacePathsStore: { getState: () => ({}) } }));
vi.mock("~/lib/draftThreadCreate", () => ({ createDraftThread: mocks.create }));
vi.mock("~/threadDetailSubscriptionRetention", () => ({
  retainThreadDetailSubscription: () => () => {},
}));
vi.mock("~/lib/threadLifecycleClient", () => ({
  clearDeletedThreadResources: mocks.clear,
  showThreadArchiveUndoToast: mocks.archiveToast,
  restoreThreadFromClient: async (id: string) => {
    await mocks.dispatch({ type: "thread.unarchive", threadId: id });
  },
}));
vi.mock("~/lib/archiveThreadWorktreeCleanup", () => ({
  releaseOrphanedWorktreeAfterArchive: vi.fn(),
}));
vi.mock("~/lib/activeThreadDelete", () => ({
  deleteActiveThreadFromClient: async ({
    threadId,
    onDeleted,
  }: {
    threadId: string;
    onDeleted: (input: unknown) => void;
  }) => {
    const thread = mocks.shell.threadShellById[threadId];
    await mocks.dispatch({ type: "thread.delete", threadId });
    onDeleted({ thread: { ...thread, projectId: "home" } });
  },
}));
vi.mock("../ChatView", () => ({
  default: ({
    threadId,
    beforeTurnDispatch,
  }: {
    threadId: string;
    beforeTurnDispatch: (id: string) => Promise<void>;
  }) => (
    <div data-testid="embedded-chat">
      Chat {threadId}
      <button onClick={() => void beforeTurnDispatch(threadId)}>Send fixture</button>
    </div>
  ),
}));

beforeEach(async () => {
  await page.viewport(900, 760);
  document.documentElement.classList.add("dark");
  mocks.shell.threadShellById = {
    a: {
      id: "a",
      title: "Generate a fox with a very long conversation title",
      archivedAt: null,
      updatedAt: "2026-10-13",
    },
    b: { id: "b", title: "Walk cycle", archivedAt: null, updatedAt: "2026-10-12" },
  };
  mocks.shell.shellSnapshotSequence++;
  mocks.drafts.draftThreadsByThreadId = {};
  for (const name of [
    "persist",
    "sync",
    "error",
    "create",
    "clear",
    "archiveToast",
    "confirm",
    "snapshot",
    "dispatch",
  ] as const)
    mocks[name].mockReset();
  mocks.persist.mockResolvedValue(undefined);
  mocks.sync.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.snapshot.mockImplementation(async () => ({
    threads: Object.values(mocks.shell.threadShellById),
  }));
  mocks.dispatch.mockImplementation(
    async ({ type, threadId }: { type: string; threadId: string }) => {
      const shell = { ...mocks.shell.threadShellById };
      if (type === "thread.delete") delete shell[threadId];
      if (type === "thread.archive")
        shell[threadId] = { ...shell[threadId]!, archivedAt: new Date().toISOString() };
      if (type === "thread.unarchive") shell[threadId] = { ...shell[threadId]!, archivedAt: null };
      mocks.shell.threadShellById = shell;
      mocks.shell.shellSnapshotSequence++;
      mocks.listeners.forEach((listen) => listen());
      return { sequence: mocks.shell.shellSnapshotSequence };
    },
  );
  mocks.create.mockImplementation(() => {
    mocks.drafts.draftThreadsByThreadId = {
      ...mocks.drafts.draftThreadsByThreadId,
      draft: { projectId: "home", createdAt: new Date().toISOString() },
    };
    mocks.draftListeners.forEach((listen) => listen());
    return "draft";
  });
});
afterEach(async () => {
  await cleanup();
  document.querySelectorAll("[data-chat-host]").forEach((el) => el.remove());
});
async function mount(ids = ["a", "b"], active: string | null = "a") {
  const p = { ...newSpriteProject(), threadIds: ids, activeThreadId: active };
  function Harness() {
    const [project, setProject] = useState<SpriteProject>(p);
    const persist = async (ids: string[], active: string | null) => {
      await mocks.persist(ids, active);
      setProject((p) => ({ ...p, threadIds: ids, activeThreadId: active }));
    };
    return (
      <SpriteChat
        project={project}
        onThreads={persist}
        onThread={(id, activate = true) =>
          persist([...new Set([...project.threadIds, id])], activate ? id : project.activeThreadId)
        }
        onCreateReady={() => {}}
        syncContext={mocks.sync}
        onError={mocks.error}
        attachmentBridge={new EmbeddedChatAttachments()}
      />
    );
  }
  const host = document.createElement("div");
  host.dataset.chatHost = "true";
  host.style.cssText = "height:700px;display:flex;justify-content:flex-end;";
  document.body.append(host);
  await render(<Harness />, { container: host });
  return host;
}
it("uses the shared searchable picker, switches chats and injects no notes from the client", async () => {
  const host = await mount();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat a");
  expect(host.querySelector("select")).toBeNull();
  await page.getByRole("combobox", { name: "Sprite conversations" }).click();
  await page.getByPlaceholder("Search conversations").fill("Walk");
  await page.getByRole("option", { name: "Walk cycle" }).click();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat b");
  await page.getByRole("button", { name: "Send fixture" }).click();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.sync).toHaveBeenCalled();
});
it("archives, shows archived chats, restores, and offers the shared undo toast", async () => {
  await mount();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat a");
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat b");
  expect(mocks.archiveToast).toHaveBeenCalledOnce();
  await page.getByRole("combobox", { name: "Sprite conversations" }).click();
  await page.getByRole("button", { name: "View archived conversations" }).click();
  await page.getByRole("option", { name: /Generate a fox/ }).click();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat a");
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Restore conversation" }).click();
  await expect.poll(() => mocks.shell.threadShellById.a?.archivedAt).toBeNull();
});
it("keeps a retryable association after durable deletion and does not delete twice or create a replacement", async () => {
  await mount(["a"]);
  await expect.element(page.getByTestId("embedded-chat")).toBeVisible();
  mocks.persist.mockRejectedValueOnce(new Error("Disk full"));
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Delete conversation" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Project association still needs saving");
  expect(mocks.confirm.mock.calls[0]?.[0]).toContain("Adopted sprite artwork");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "View archived conversations" }))
    .toBeVisible();
  expect(
    mocks.dispatch.mock.calls.filter(([command]) => command.type === "thread.delete"),
  ).toHaveLength(1);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("reconciles deletion from the ordinary chat entry and leaves the project chat empty", async () => {
  await mount(["a"]);
  await expect.element(page.getByTestId("embedded-chat")).toBeVisible();
  await mocks.dispatch({ type: "thread.delete", threadId: "a" });
  await expect
    .element(page.getByRole("button", { name: "View archived conversations" }))
    .toBeVisible();
  expect(mocks.persist).toHaveBeenCalledWith([], null);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("does not auto-create an empty project's chat and deletes a local draft without a server delete", async () => {
  const host = await mount([], null);
  await expect
    .element(page.getByRole("button", { name: "View archived conversations" }))
    .toBeVisible();
  expect(mocks.create).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat draft");
  await page.getByRole("button", { name: "Conversation options" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Archive conversation" }))
    .not.toBeInTheDocument();
  await page.getByRole("menuitem", { name: "Delete conversation" }).click();
  await expect
    .element(page.getByRole("button", { name: "View archived conversations" }))
    .toBeVisible();
  expect(mocks.clear).toHaveBeenCalledWith("draft", "home");
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(host.querySelector("select")).toBeNull();
});

it("keeps shared popup styling and keyboard focus at narrow widths", async () => {
  const host = await mount();
  await expect.element(page.getByTestId("embedded-chat")).toBeVisible();
  await page.getByRole("combobox", { name: "Sprite conversations" }).click();
  await expect.element(page.getByRole("option", { name: "Walk cycle" })).toBeVisible();
  await page.screenshot({
    path: "/Users/0x10/Documents/Github/Aha/output/playwright/sprite-chat-picker-dark.png",
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("combobox", { name: "Sprite conversations" })).toHaveFocus();
  await page.viewport(560, 760);
  await page.getByRole("combobox", { name: "Sprite conversations" }).click();
  await page.getByPlaceholder("Search conversations").fill("Walk");
  await page.screenshot({
    path: "/Users/0x10/Documents/Github/Aha/output/playwright/sprite-chat-picker-narrow.png",
  });
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat b");
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
});

it("retries association failure with the same draft and model selection", async () => {
  await mount([], null);
  await expect
    .element(page.getByRole("button", { name: "View archived conversations" }))
    .toBeVisible();
  mocks.persist.mockRejectedValueOnce(new Error("Disk full"));
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await expect.poll(() => mocks.error.mock.calls.length).toBe(1);
  expect(mocks.create).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat draft");
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.create.mock.calls[0]?.[0].modelSelection).toMatchObject({ model: "chosen-model" });
});

it("does not remove a chat using a shell snapshot older than a server push", async () => {
  let resolve!: (value: unknown) => void;
  let count = 0;
  mocks.snapshot.mockImplementation(async () => {
    if (++count === 2)
      return new Promise((done) => {
        resolve = done;
      });
    return {
      snapshotSequence: mocks.shell.shellSnapshotSequence,
      threads: Object.values(mocks.shell.threadShellById),
    };
  });
  await mount(["a"]);
  await expect.element(page.getByTestId("embedded-chat")).toBeVisible();
  await expect.poll(() => count).toBe(2);
  const old = mocks.shell.shellSnapshotSequence;
  mocks.shell.shellSnapshotSequence++;
  mocks.listeners.forEach((listen) => listen());
  resolve({ snapshotSequence: old, threads: [] });
  await expect.poll(() => count).toBeGreaterThan(2);
  expect(mocks.persist).not.toHaveBeenCalled();
  await expect.element(page.getByTestId("embedded-chat")).toHaveTextContent("Chat a");
});
