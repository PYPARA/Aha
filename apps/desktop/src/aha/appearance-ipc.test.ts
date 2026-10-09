import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AHA_APPEARANCE_CHANNELS as C } from "@synara/contracts/ahaAppearance";
import type { SkinSnapshot, SkinPreview } from "@synara/contracts/ahaSkins";
import { BUILTIN_PALETTES } from "./skin-palettes";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, data?: unknown) => Promise<unknown>>(),
  dialog: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (key: string) => mocks.handlers.delete(key),
    handle: (key: string, fn: (event: unknown, data?: unknown) => Promise<unknown>) =>
      mocks.handlers.set(key, fn),
  },
  dialog: { showOpenDialog: mocks.dialog },
}));
import { registerAhaAppearance } from "./appearance-ipc";
let directory: string;
const frame = { url: "aha-next://app/settings" };
const send = vi.fn();
const window = { webContents: { id: 1, mainFrame: frame, getURL: () => frame.url, send } };
const event = { sender: window.webContents, senderFrame: frame };
const invoke = (channel: string, value?: unknown, source: unknown = event) =>
  mocks.handlers.get(channel)!(source, value);
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  directory = await mkdtemp(join(tmpdir(), "aha-skin-ipc-"));
  const controller = registerAhaAppearance(
    directory,
    () => window as never,
    () => null,
    { builtinDirectory: () => null, defaultIcon: () => null, applyIcon: async () => {} },
  );
  await controller.ready;
});
afterEach(() => rm(directory, { recursive: true, force: true }));
it("accepts the trusted main frame and keeps bridge appearance and library projections consistent", async () => {
  const state = (await invoke(C.skinsList, {
    initialPalette: BUILTIN_PALETTES["aha-elation"],
  })) as SkinSnapshot;
  const preview = (await invoke(C.skinsPreview, state.activeId)) as SkinPreview;
  const next = (await invoke(C.skinsApply, {
    id: preview.id,
    revision: state.revision,
    preferences: state.appearance.preferences,
    definition: preview.definition,
  })) as SkinSnapshot;
  expect(next.revision).toBe(1);
  expect(await invoke(C.get)).toEqual(next.appearance);
  expect(send).toHaveBeenCalledWith(C.skinsChanged, next);
});
it("refuses other windows and subframes before processing any skin input", async () => {
  await expect(
    invoke(C.skinsList, undefined, { ...event, sender: { ...window.webContents, id: 2 } }),
  ).rejects.toThrow("IPC_FORBIDDEN");
  await expect(
    invoke(C.skinsPreview, "aha-elation", { ...event, senderFrame: { ...frame } }),
  ).rejects.toThrow("IPC_FORBIDDEN");
  expect(send).not.toHaveBeenCalled();
});
it("rejects resource paths and invalid structured input without changing the library", async () => {
  const before = await invoke(C.skinsList, { initialPalette: BUILTIN_PALETTES["aha-elation"] });
  await expect(invoke(C.skinsPreview, "../../icon.png")).rejects.toThrow();
  await expect(
    invoke(C.skinsApply, { id: "aha-elation", path: "/tmp/icon.png" }),
  ).rejects.toThrow();
  expect(await invoke(C.skinsList)).toEqual(before);
});
it("canceled native import does not mutate state or announce an appearance change", async () => {
  mocks.dialog.mockResolvedValue({ canceled: true, filePaths: [] });
  const before = await invoke(C.skinsList, { initialPalette: BUILTIN_PALETTES["aha-elation"] });
  expect(await invoke(C.skinsImport)).toBeNull();
  expect(await invoke(C.skinsList)).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
