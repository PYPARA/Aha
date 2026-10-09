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
import { SkinLibrary, type SkinLibraryOptions } from "./skin-library";
import { SkinIdSchema, SkinApplySchema, SkinPaletteSchema } from "@synara/contracts/ahaSkins";

export function registerAhaAppearance(
  directory: string,
  getWindow: () => BrowserWindow | null,
  resolveBuiltinManifest: (id: "aha-elation" | "furina-chanson") => string | null,
  skinOptions?: SkinLibraryOptions,
) {
  const store = new AhaAppearanceStore(join(directory, "aha-appearance.json"));
  const skins = skinOptions
    ? new SkinLibrary(join(directory, "aha-skins.json"), store, skinOptions)
    : null;
  const ready = store.load().then(() => skins?.load());
  const announce = (window: BrowserWindow) => {
    if (!skins) return;
    const value = skins.snapshot();
    window.webContents.send(C.skinsChanged, value);
    window.webContents.send(C.changed, value.appearance);
  };
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
    return skins?.snapshot().appearance ?? store.snapshot();
  });
  handle(C.save, async (window, input) => {
    const parsed = AhaSaveAppearanceSchema.parse(input);
    const snap = skins
      ? await skins.saveAppearance(parsed.preferences, parsed.revision)
      : await store.save(parsed.preferences, parsed.revision);
    announce(window);
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
    const manifest = resolveBuiltinManifest(id);
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
    await store.exportPackage(
      result.filePath,
      parsed.nativeTheme,
      skins?.snapshot().appearance.preferences,
    );
    return true;
  });
  if (skins) {
    handle(C.skinsList, async (_window, input) => {
      const parsed = z.strictObject({ initialPalette: SkinPaletteSchema }).optional().parse(input);
      return skins.list(parsed?.initialPalette);
    });
    handle(C.skinsPreview, async (_window, input) => skins.preview(SkinIdSchema.parse(input)));
    handle(C.skinsApply, async (window, input) => {
      const value = await skins.apply(SkinApplySchema.parse(input));
      announce(window);
      return value;
    });
    handle(C.skinsRename, async (window, input) => {
      const parsed = z
        .strictObject({
          id: SkinIdSchema,
          name: z.string().trim().min(1).max(80),
          revision: z.number().int().nonnegative(),
        })
        .parse(input);
      const value = await skins.rename(parsed.id, parsed.name, parsed.revision);
      announce(window);
      return value;
    });
    handle(C.skinsRemove, async (window, input) => {
      const parsed = z
        .strictObject({ id: SkinIdSchema, revision: z.number().int().nonnegative() })
        .parse(input);
      const value = await skins.remove(parsed.id, parsed.revision);
      announce(window);
      return value;
    });
    handle(C.skinsImport, async (window, input) => {
      z.undefined().parse(input);
      const result = await dialog.showOpenDialog(window, {
        title: "导入皮肤 / Import skin",
        filters: [{ name: "Aha skin / theme", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const value = await skins.importPackage(result.filePaths[0]);
      announce(window);
      return value;
    });
    handle(C.skinsDirectory, async (window, input) => {
      z.undefined().parse(input);
      const result = await dialog.showOpenDialog(window, {
        title: "导入旧外观 / Import legacy appearance",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const value = await skins.importDirectory(result.filePaths[0]);
      announce(window);
      return value;
    });
    handle(C.skinsIcon, async (window, input) => {
      z.undefined().parse(input);
      const result = await dialog.showOpenDialog(window, {
        title: "选择皮肤图标 / Choose skin icon",
        filters: [{ name: "PNG / JPEG / WebP", extensions: ["png", "jpg", "jpeg", "webp"] }],
        properties: ["openFile"],
      });
      return result.canceled || !result.filePaths[0]
        ? null
        : { id: await skins.importIcon(result.filePaths[0]) };
    });
    handle(C.skinsExport, async (window, input) => {
      z.undefined().parse(input);
      const result = await dialog.showSaveDialog(window, {
        defaultPath: "aha-skin.json",
        filters: [{ name: "Aha skin", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return false;
      await skins.exportPackage(result.filePath);
      return true;
    });
    handle(C.skinsReapply, async (_window, input) => {
      z.undefined().parse(input);
      await skins.reapplyIcon();
    });
  }
  return { ready, reapplyIcon: () => skins?.reapplyIcon() ?? Promise.resolve() };
}
