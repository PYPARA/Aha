import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SPRITE_LIBRARY_CHANNEL } from "@synara/contracts/spriteLibrary";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  openPath: vi.fn(async () => ""),
}));
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler),
  },
  shell: { openPath: mocks.openPath },
}));
import { registerSpriteLibrary } from "./ipc";
let root: string;
const frame = { url: "aha-next://app/sprite-animation" };
const window = { webContents: { id: 7, getURL: () => frame.url } };
const event = () => ({ sender: { id: 7, mainFrame: frame }, senderFrame: frame });
const request = (raw: unknown, sender: unknown = event()) =>
  mocks.handlers.get(SPRITE_LIBRARY_CHANNEL)!(sender, raw);
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-sprite-ipc-")));
  registerSpriteLibrary(path.join(root, "Sprite"), () => window as never);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  mocks.handlers.clear();
});
it("only serves the owning window's main frame and matching origin", async () => {
  await expect(
    request({ op: "list" }, { ...event(), sender: { id: 8, mainFrame: frame } }),
  ).rejects.toThrow("IPC_FORBIDDEN");
  const childFrame = { url: frame.url };
  await expect(request({ op: "list" }, { ...event(), senderFrame: childFrame })).rejects.toThrow(
    "IPC_FORBIDDEN",
  );
  const foreign = { url: "https://example.com/" };
  await expect(
    request({ op: "list" }, { sender: { id: 7, mainFrame: foreign }, senderFrame: foreign }),
  ).rejects.toThrow("IPC_FORBIDDEN");
  await expect(request({ op: "list" })).resolves.toEqual({
    root: path.join(root, "Sprite"),
    projects: [],
  });
});
it("validates identifiers, image paths and operation sequencing at the boundary", async () => {
  await expect(request({ op: "get", id: "../outside" })).rejects.toThrow();
  await expect(request({ op: "readImage", id: "fox", file: "../outside" })).rejects.toThrow();
  await expect(request({ op: "finishDelete", id: "fox" })).rejects.toThrow();
  await request({ op: "beginDelete", id: "fox" });
  await request({ op: "finishDelete", id: "fox" });
  await expect(request({ op: "list" })).resolves.toMatchObject({ projects: [] });
  await request({ op: "reveal" });
  expect(mocks.openPath).toHaveBeenCalledWith(path.join(root, "Sprite"));
});
