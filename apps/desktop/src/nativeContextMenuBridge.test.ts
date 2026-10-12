import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcMain, Menu, type BrowserWindow } from "electron";
import { attachNativeContextMenu } from "./nativeContextMenuBridge";
import { DESKTOP_IPC_CHANNELS as IPC } from "./ipcChannels";
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn(), closePopup: vi.fn() })) },
  };
});
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    getURL: (): string => "aha-next://app/",
    isDestroyed: () => false,
    send: vi.fn(),
    getZoomFactor: () => 1.5,
    replaceMisspelling: vi.fn(),
    copyImageAt: vi.fn(),
  });
  const win = { webContents: contents };
  attachNativeContextMenu(win as unknown as BrowserWindow, "aha-next://app/");
  const params = {
    x: 150,
    y: 75,
    frame: contents.mainFrame,
    mediaType: "image",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
  };
  const open = () => contents.emit("context-menu", { preventDefault: vi.fn() }, params);
  const request = () =>
    contents.send.mock.calls.find(([channel]) => channel === IPC.contextMenuExtensionQuery)![1] as {
      requestId: string;
      x: number;
      y: number;
    };
  const respond = (sender = contents, senderFrame = contents.mainFrame) =>
    ipcMain.emit(
      IPC.contextMenuExtensionResponse,
      { sender, senderFrame },
      { requestId: request().requestId, label: "Collect" },
    );
  return { contents, params, open, request, respond };
}
afterEach(() => {
  ipcMain.removeAllListeners();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("native menu bridge", () => {
  it("normalizes zoom for renderer matching and keeps native image coordinates", async () => {
    const f = fixture();
    f.open();
    expect(f.request()).toMatchObject({ x: 100, y: 50 });
    f.respond();
    await Promise.resolve();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0];
    expect(template.at(-1)?.label).toBe("Collect");
    (template[0]!.click as () => void)();
    expect(f.contents.copyImageAt).toHaveBeenCalledWith(150, 75);
    (template.at(-1)!.click as () => void)();
    expect(f.contents.send).toHaveBeenLastCalledWith(IPC.contextMenuExtensionResult, {
      requestId: f.request().requestId,
      selected: true,
    });
  });
  it("ignores replies from another window or an iframe and falls back", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.open();
    f.respond(Object.assign(new EventEmitter(), f.contents, { mainFrame: {} }));
    f.respond(f.contents, {});
    await vi.advanceTimersByTimeAsync(150);
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0];
    expect(template.at(-1)?.role).toBe("selectAll");
    f.contents.emit("destroyed");
    expect(ipcMain.listenerCount(IPC.contextMenuExtensionResponse)).toBe(0);
  });
  it("never sends queries to embedded frames or an untrusted navigated page", () => {
    const f = fixture();
    f.params.frame = {};
    f.open();
    expect(f.contents.send).not.toHaveBeenCalled();
    f.params.frame = f.contents.mainFrame;
    f.contents.getURL = () => "https://untrusted.example/";
    f.open();
    expect(f.contents.send).not.toHaveBeenCalled();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
  });
  it("cancels navigation and crash queries before any obsolete popup can appear", async () => {
    const f = fixture();
    f.open();
    f.contents.emit("did-start-navigation", {}, "aha-next://app/new", false, true);
    f.respond();
    await Promise.resolve();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    f.open();
    f.contents.emit("render-process-gone");
    await Promise.resolve();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  });
});
