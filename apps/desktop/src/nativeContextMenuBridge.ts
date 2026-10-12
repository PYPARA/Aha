import { ipcMain, Menu, type BrowserWindow, type IpcMainEvent } from "electron";
import { DESKTOP_IPC_CHANNELS as IPC } from "./ipcChannels";
import { NativeContextMenuSession, nativeContextMenuTemplate } from "./nativeContextMenu";

export function attachNativeContextMenu(window: BrowserWindow, trustedPageUrl: string) {
  const contents = window.webContents;
  let menu: Menu | undefined;
  const trusted = () => {
    try {
      const actual = new URL(contents.getURL()),
        expected = new URL(trustedPageUrl);
      return actual.protocol === expected.protocol && actual.host === expected.host;
    } catch {
      return false;
    }
  };
  const session = new NativeContextMenuSession(
    (request) => contents.send(IPC.contextMenuExtensionQuery, request),
    (result) => {
      if (!contents.isDestroyed()) contents.send(IPC.contextMenuExtensionResult, result);
    },
  );
  const cancel = () => {
    session.cancel();
    menu?.closePopup(window);
    menu = undefined;
  };
  const response = (event: IpcMainEvent, value: unknown) => {
    if (
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !trusted() ||
      !value ||
      typeof value !== "object"
    )
      return;
    const { requestId, label } = value as { requestId?: unknown; label?: unknown };
    if (typeof requestId === "string") session.respond(requestId, label);
  };
  ipcMain.on(IPC.contextMenuExtensionResponse, response);
  contents.on("context-menu", (event, params) => {
    event.preventDefault();
    cancel();
    const show = (extension?: { label: string; click: () => void }, requestId?: string) => {
      if (contents.isDestroyed() || (requestId && !session.isCurrent(requestId))) return;
      menu = Menu.buildFromTemplate(
        nativeContextMenuTemplate(
          params,
          {
            replaceMisspelling: (word) => contents.replaceMisspelling(word),
            copyImageAt: (x, y) => contents.copyImageAt(x, y),
          },
          extension,
        ),
      );
      menu.popup({
        window,
        callback: () => {
          if (requestId) session.finish(requestId);
        },
      });
    };
    if (!trusted() || params.frame !== contents.mainFrame) {
      show();
      return;
    }
    void session
      .query(params.x / contents.getZoomFactor(), params.y / contents.getZoomFactor())
      .then(({ requestId, label }) => {
        show(
          label ? { label, click: () => session.finish(requestId, true) } : undefined,
          requestId,
        );
      });
  });
  contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cancel();
  });
  contents.on("render-process-gone", cancel);
  contents.once("destroyed", () => {
    session.cancel();
    ipcMain.removeListener(IPC.contextMenuExtensionResponse, response);
  });
}
