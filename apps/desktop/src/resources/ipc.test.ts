import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESOURCE_CHANNELS as C,
  type ResourceEntry,
  type ResourceSnapshot,
  type ResourceBatchPlan,
  type ResourceBatchResult,
  type ResourcePage,
  type ResourceLocateResult,
} from "@synara/contracts/resourceLibrary";
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  open: vi.fn(),
  confirm: vi.fn(),
  trash: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { once: vi.fn() },
  ipcMain: {
    removeHandler: (key: string) => mock.handlers.delete(key),
    handle: (key: string, fn: (event: unknown, input?: unknown) => Promise<unknown>) =>
      mock.handlers.set(key, fn),
  },
  dialog: { showOpenDialog: mock.open, showMessageBox: mock.confirm },
  shell: { trashItem: mock.trash, showItemInFolder: mock.reveal },
}));
import { registerResourceLibrary } from "./ipc";
let folder: string;
let library: ReturnType<typeof registerResourceLibrary>;
const frame = { url: "aha-next://app/resources" };
const window = { webContents: { id: 1, mainFrame: frame, getURL: () => frame.url, send: vi.fn() } };
const event = { sender: window.webContents, senderFrame: frame };
const invoke = (input: unknown, source: unknown = event) =>
  mock.handlers.get(C.request)!(source, input);
beforeEach(async () => {
  vi.clearAllMocks();
  folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-resource-ipc-")));
  await fs.mkdir(path.join(folder, "root"));
  mock.open.mockResolvedValue({ canceled: false, filePaths: [path.join(folder, "root")] });
  library = registerResourceLibrary(path.join(folder, "config"), () => window as never);
});
afterEach(async () => {
  library.close();
  await library.serial(async () => {});
  await fs.rm(folder, { recursive: true, force: true });
});
it("rejects untrusted windows, subframes and malformed operations", async () => {
  await expect(invoke({ op: "chooseRoot" }, { ...event, sender: { id: 2 } })).rejects.toThrow(
    "IPC_FORBIDDEN",
  );
  await expect(
    invoke({ op: "chooseRoot" }, { ...event, senderFrame: { ...frame } }),
  ).rejects.toThrow("IPC_FORBIDDEN");
  await expect(invoke({ op: "shell", path: "/tmp" })).rejects.toThrow();
  expect(mock.open).not.toHaveBeenCalled();
});
it("runs the native choose/import/list lifecycle and broadcasts updates", async () => {
  const chosen = (await invoke({ op: "chooseRoot" })) as ResourceSnapshot;
  expect(chosen.root).toBe(path.join(folder, "root"));
  await invoke({ op: "createDirectory", parent: "", name: "Game" });
  await invoke({
    op: "importBytes",
    target: "Game",
    name: "sprite.txt",
    bytes: new TextEncoder().encode("sprite"),
    origin: { kind: "game", batchId: "batch" },
  });
  const entries = (
    (await invoke({ op: "list", query: { path: "Game" } })) as { entries: ResourceEntry[] }
  ).entries;
  expect(entries[0]?.origin?.batchId).toBe("batch");
  expect(window.webContents.send).toHaveBeenCalledWith(C.changed);
});
it("does not trash when canceled and propagates a native trash failure without deletion", async () => {
  await invoke({ op: "chooseRoot" });
  const project = (await invoke({
    op: "createDirectory",
    parent: "",
    name: "Game",
  })) as ResourceEntry;
  mock.confirm.mockResolvedValue({ response: 0 });
  await invoke({ op: "trash", ids: [project.id] });
  expect(mock.trash).not.toHaveBeenCalled();
  mock.confirm.mockResolvedValue({ response: 1 });
  mock.trash.mockRejectedValue(new Error("OS trash unavailable"));
  await expect(invoke({ op: "trash", ids: [project.id] })).rejects.toThrow("OS trash unavailable");
  expect((await fs.stat(path.join(folder, "root/Game"))).isDirectory()).toBe(true);
});
it("leaves the current root unchanged when native root selection is canceled", async () => {
  await invoke({ op: "chooseRoot" });
  mock.open.mockResolvedValue({ canceled: true, filePaths: [] });
  const snapshot = (await invoke({ op: "chooseRoot" })) as ResourceSnapshot;
  expect(snapshot.root).toBe(path.join(folder, "root"));
});
it("keeps a canceled prepared trash batch retryable and confirms its complete directory impact", async () => {
  await invoke({ op: "chooseRoot" });
  const project = (await invoke({
    op: "createDirectory",
    parent: "",
    name: "Game",
  })) as ResourceEntry;
  await invoke({
    op: "importBytes",
    target: "Game",
    name: "one.txt",
    bytes: new TextEncoder().encode("one"),
  });
  const plan = (await invoke({
    op: "prepareBatch",
    action: "trash",
    ids: [project.id],
  })) as ResourceBatchPlan;
  mock.confirm.mockResolvedValue({ response: 0 });
  const canceled = (await invoke({ op: "executeBatch", planId: plan.id })) as ResourceBatchResult;
  expect(canceled.items[0]?.status).toBe("cancelled");
  expect(mock.confirm.mock.calls[0]?.[1].message).toContain("2");
  expect(mock.trash).not.toHaveBeenCalled();
  mock.confirm.mockResolvedValue({ response: 1 });
  mock.trash.mockImplementation((file: string) => fs.rm(file, { recursive: true }));
  const result = (await invoke({ op: "executeBatch", planId: plan.id })) as ResourceBatchResult;
  expect(result.items[0]?.status).toBe("succeeded");
  await invoke({ op: "executeBatch", planId: plan.id });
  expect(mock.trash).toHaveBeenCalledTimes(1);
  expect(mock.confirm).toHaveBeenCalledTimes(2);
});
it("does not create an export batch when the native destination dialog is canceled", async () => {
  await invoke({ op: "chooseRoot" });
  const project = (await invoke({
    op: "createDirectory",
    parent: "",
    name: "Game",
  })) as ResourceEntry;
  mock.open.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await invoke({ op: "prepareBatch", action: "export", ids: [project.id] })).toBeNull();
  expect((await fs.stat(path.join(folder, "root/Game"))).isDirectory()).toBe(true);
});
it("reports native import cancellation without a successful empty import", async () => {
  await invoke({ op: "chooseRoot" });
  await invoke({ op: "createDirectory", parent: "", name: "Game" });
  mock.open.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await invoke({ op: "importPaths", target: "Game" })).toEqual({
    added: 0,
    skipped: 0,
    failed: [],
    cancelled: true,
  });
});
it("validates root destinations, name-and-path search, statistics and locate over IPC", async () => {
  await fs.writeFile(path.join(folder, "root/loose.txt"), "root file");
  await invoke({ op: "chooseRoot" });
  await invoke({ op: "createDirectory", parent: "", name: "Nested" });
  await invoke({
    op: "importBytes",
    target: "Nested",
    name: "same.txt",
    bytes: new TextEncoder().encode("nested"),
  });
  const page = (await invoke({
    op: "list",
    query: { path: "", recursive: true, kind: "file", searchIn: "nameAndPath", query: "Nested" },
  })) as ResourcePage;
  expect(page.stats).toEqual({ scopeFiles: 2, matchedFiles: 1, matchedDirectories: 0 });
  const located = (await invoke({
    op: "locate",
    id: page.entries[0]!.id,
    sort: "name",
  })) as ResourceLocateResult;
  expect(located).toMatchObject({ parentPath: "Nested", offset: 0, revision: page.revision });
  await expect(
    invoke({ op: "prepareBatch", action: "move", ids: [located.entry.id] }),
  ).rejects.toThrow("destination");
  const plan = (await invoke({
    op: "prepareBatch",
    action: "move",
    ids: [located.entry.id],
    target: "",
  })) as ResourceBatchPlan;
  expect(plan.items[0]?.target).toBe("same.txt");
  await invoke({ op: "executeBatch", planId: plan.id });
  expect(
    ((await invoke({ op: "snapshot" })) as ResourceSnapshot).directoryStats?.find(
      (d) => d.path === "",
    )?.directFiles,
  ).toBe(2);
});
it("exposes cached reads and failed scan diagnostics while refusing library changes", async () => {
  await fs.writeFile(path.join(folder, "root/cached.txt"), "cached");
  await invoke({ op: "chooseRoot" });
  const before = (await invoke({ op: "list", query: { path: "" } })) as ResourcePage;
  const resolve = library.resolve.bind(library);
  const failure = vi.spyOn(library, "resolve").mockRejectedValueOnce(new Error("Offline volume"));
  await expect(invoke({ op: "refresh" })).rejects.toThrow("Offline volume");
  failure.mockImplementation(resolve);
  expect(((await invoke({ op: "snapshot" })) as ResourceSnapshot).scan?.phase).toBe("failed");
  expect(await invoke({ op: "list", query: { path: "" } })).toEqual(before);
  expect(await invoke({ op: "read", id: before.entries[0]!.id })).toMatchObject({
    name: "cached.txt",
  });
  await expect(
    invoke({ op: "importBytes", target: "", name: "no.txt", bytes: new Uint8Array() }),
  ).rejects.toThrow("not ready");
  await invoke({ op: "refresh" });
  expect(((await invoke({ op: "snapshot" })) as ResourceSnapshot).scan?.phase).toBe("ready");
});
