import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESOURCE_CHANNELS as C,
  type ResourceEntry,
  type ResourceSnapshot,
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
