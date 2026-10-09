import { ipcMain, dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AHA_APPEARANCE_CHANNELS as C,
  AhaSaveAppearanceSchema,
  AhaBuiltinThemeIdSchema,
} from "@synara/contracts/ahaAppearance";
import { ResourceIdSchema } from "@synara/contracts/ahaLegacyAppearance";
import { AhaAppearanceStore } from "./appearance-store";

export function registerAhaAppearance(
  directory: string,
  getWindow: () => BrowserWindow | null,
  resolveBuiltinManifest: () => string | null,
) {
  const store = new AhaAppearanceStore(join(directory, "aha-appearance.json"));
  const ready = store.load();
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    const frame = event.senderFrame;
    if (
      !window ||
      !frame ||
      event.sender.id !== window.webContents.id ||
      frame !== event.sender.mainFrame
    )
      throw new Error("IPC_FORBIDDEN");
    const actual = new URL(frame.url),
      expected = new URL(window.webContents.getURL());
    if (
      actual.protocol !== expected.protocol ||
      actual.host !== expected.host ||
      ![
        "aha-next:",
        "aha-next-beta:",
        "aha-next-canary:",
        "aha-next-cua:",
        "http:",
        "https:",
      ].includes(actual.protocol)
    )
      throw new Error("IPC_FORBIDDEN");
    return window;
  };
  const handle = (
    channel: string,
    fn: (window: BrowserWindow, input: unknown) => Promise<unknown>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, input: unknown) => {
      const window = trusted(event);
      await ready;
      try {
        return await fn(window, input);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error("主题或外观文件不是有效的 JSON。", { cause: error });
        if (error instanceof z.ZodError) throw new Error("外观数据格式不正确。");
        if (error && typeof error === "object" && "code" in error)
          throw new Error("外观文件操作失败，请检查文件与存储权限。");
        throw error;
      }
    });
  };
  handle(C.get, async (_window, input) => {
    z.undefined().parse(input);
    return store.snapshot();
  });
  handle(C.save, async (window, input) => {
    const parsed = AhaSaveAppearanceSchema.parse(input);
    const snap = await store.save(parsed.preferences, parsed.revision);
    window.webContents.send(C.changed, snap);
    return snap;
  });
  handle(C.imageImport, async (window, input) => {
    z.undefined().parse(input);
    const result = await dialog.showOpenDialog(window, {
      title: "选择背景图片 / Choose background",
      filters: [{ name: "PNG / JPEG / WebP", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile"],
    });
    return result.canceled || !result.filePaths[0]
      ? null
      : { id: await store.images.importFile(result.filePaths[0]) };
  });
  handle(C.imageRead, async (_window, input) => store.images.read(ResourceIdSchema.parse(input)));
  handle(C.builtinPreview, async (_window, input) => {
    const id = AhaBuiltinThemeIdSchema.parse(input);
    const manifest = resolveBuiltinManifest();
    if (!manifest)
      throw new Error("虚照·欢愉素材尚未安装 / Xuzhao · Elation assets are not installed.");
    return store.previewBuiltin(id, dirname(manifest));
  });
  handle(C.packagePreview, async (window, input) => {
    z.undefined().parse(input);
    const result = await dialog.showOpenDialog(window, {
      title: "导入 Aha 主题包 / Import theme package",
      filters: [{ name: "Aha theme", extensions: ["json"] }],
      properties: ["openFile"],
    });
    return result.canceled || !result.filePaths[0]
      ? null
      : store.previewPackage(result.filePaths[0]);
  });
  handle(C.directoryPreview, async (window, input) => {
    z.undefined().parse(input);
    const result = await dialog.showOpenDialog(window, {
      title: "选择含 appearance.json 的旧 Aha 外观目录",
      properties: ["openDirectory"],
    });
    return result.canceled || !result.filePaths[0]
      ? null
      : store.previewDirectory(result.filePaths[0]);
  });
  handle(C.packageExport, async (window, input) => {
    const parsed = z.strictObject({ nativeTheme: z.string().max(256 * 1024) }).parse(input);
    const result = await dialog.showSaveDialog(window, {
      defaultPath: "aha-theme.json",
      filters: [{ name: "Aha theme", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await store.exportPackage(result.filePath, parsed.nativeTheme);
    return true;
  });
}
