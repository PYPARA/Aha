import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import path from "node:path";
import { z } from "zod";
import { RESOURCE_CHANNELS as C, type ResourceCommand } from "@synara/contracts/resourceLibrary";
import { ResourceLibrary } from "./library";

const ids = z.array(z.string().min(1).max(128)).min(1).max(10000);
const text = z.string().max(4096);
const origin = z.object({
  kind: z.enum(["drawing", "chat", "local", "game"]),
  threadId: text.optional(),
  messageId: text.optional(),
  jobId: text.optional(),
  batchId: text.optional(),
  prompt: z.string().max(100000).optional(),
  model: text.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("snapshot") }),
  z.object({ op: z.literal("refresh") }),
  z.object({ op: z.literal("chooseRoot") }),
  z.object({ op: z.literal("cancelImport") }),
  z.object({
    op: z.literal("list"),
    query: z.object({
      path: text,
      kind: z.enum(["file", "directory"]).optional(),
      recursive: z.boolean().optional(),
      query: text.optional(),
      searchIn: z.enum(["name", "nameAndPath"]).optional(),
      tag: text.optional(),
      type: z.enum(["all", "image", "audio", "video", "document", "other"]).optional(),
      sort: z.enum(["name", "modified"]).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({ op: z.literal("locate"), id: text, sort: z.enum(["name", "modified"]).optional() }),
  z.object({ op: z.literal("createDirectory"), parent: text, name: text }),
  z.object({ op: z.literal("rename"), ids, name: text }),
  z.object({ op: z.literal("move"), ids, target: text }),
  z.object({
    op: z.literal("metadata"),
    ids,
    tags: z.array(z.string().max(100)).max(100).optional(),
    notes: z.string().max(32000).optional(),
    tagMode: z.enum(["add", "remove", "replace"]).optional(),
  }),
  z.object({
    op: z.literal("prepareBatch"),
    action: z.enum(["rename", "move", "trash", "export"]),
    ids,
    name: text.optional(),
    target: text.optional(),
  }),
  z.object({ op: z.literal("executeBatch"), planId: text, retryFailed: z.boolean().optional() }),
  z.object({ op: z.literal("trash"), ids }),
  z.object({ op: z.literal("export"), ids }),
  z.object({ op: z.literal("reveal"), id: text.optional() }),
  z.object({ op: z.literal("read"), id: text, thumbnail: z.boolean().optional() }),
  z.object({
    op: z.literal("importPaths"),
    target: text,
    paths: z.array(text).max(10000).optional(),
    directories: z.boolean().optional(),
    origin: origin.optional(),
  }),
  z.object({
    op: z.literal("importBytes"),
    target: text,
    name: text,
    bytes: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength <= 100 * 1024 * 1024, "File exceeds 100 MiB."),
    origin: origin.optional(),
  }),
]);
export function registerResourceLibrary(
  directory: string,
  getWindow: () => BrowserWindow | null,
  defaultRoot?: string,
) {
  const library = new ResourceLibrary(
    path.join(directory, "resource-library.json"),
    () => getWindow()?.webContents.send(C.changed),
    (name, completed) => getWindow()?.webContents.send(C.progress, { name, completed }),
  );
  const ready = library.load(defaultRoot);
  ipcMain.removeHandler(C.request);
  ipcMain.handle(C.request, async (event, raw: unknown) => {
    const window = getWindow();
    if (
      !window ||
      event.sender.id !== window.webContents.id ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("IPC_FORBIDDEN");
    const actual = new URL(event.senderFrame.url),
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
    const input = Command.parse(raw) satisfies ResourceCommand;
    if (input.op === "cancelImport") {
      library.cancelImport();
      return;
    }
    if (input.op === "snapshot") return library.snapshot();
    if (input.op === "list") return library.list(input.query);
    if (input.op === "locate") return library.locate(input.id, input.sort);
    if (input.op === "read") return library.read(input.id, input.thumbnail);
    if (input.op === "reveal")
      return shell.showItemInFolder(
        await library.resolve(input.id ? library.entry(input.id).path : ""),
      );
    await ready;
    return library.serial(async () => {
      if (input.op !== "refresh" && input.op !== "chooseRoot") library.assertWritable();
      switch (input.op) {
        case "refresh":
          return library.scan();
        case "chooseRoot": {
          const result = await dialog.showOpenDialog(window, {
            title: "资源中心 / Resource center",
            properties: ["openDirectory", "createDirectory"],
          });
          return result.canceled || !result.filePaths[0]
            ? library.snapshot()
            : library.open(result.filePaths[0]);
        }
        case "createDirectory":
          return library.createDirectory(input.parent, input.name);
        case "rename":
          return library.relocate(input.ids, null, input.name);
        case "move":
          return library.relocate(input.ids, input.target);
        case "metadata":
          return library.metadata(input.ids, input.tags, input.notes, input.tagMode);
        case "prepareBatch": {
          let target = input.target;
          if (input.action === "export") {
            const picked = await dialog.showOpenDialog(window, {
              title: "导出资源 / Export resources",
              properties: ["openDirectory", "createDirectory"],
            });
            if (picked.canceled || !picked.filePaths[0]) return null;
            target = picked.filePaths[0];
          }
          return library.prepareBatch(input.action, input.ids, target, input.name);
        }
        case "executeBatch": {
          const plan = library.batchPlan(input.planId);
          const pending = library.batchPendingItems(input.planId, input.retryFailed);
          if (plan.action === "trash" && pending.length) {
            const affected = library.entries.filter(
              (entry) =>
                !entry.deleted &&
                pending.some(
                  (item) => entry.path === item.source || entry.path.startsWith(item.source + "/"),
                ),
            ).length;
            const response = await dialog.showMessageBox(window, {
              type: "warning",
              message: `将 ${affected} 个文件或文件夹移入系统废纸篓？ / Move ${affected} items to the system trash?`,
              detail: pending
                .slice(0, 10)
                .map((item) => item.source)
                .join("\n"),
              buttons: ["取消 / Cancel", "移入废纸篓 / Move to trash"],
              defaultId: 0,
              cancelId: 0,
            });
            if (response.response !== 1)
              return {
                planId: plan.id,
                items: plan.items.map((item) =>
                  Object.assign({}, item, { status: "cancelled" as const }),
                ),
              };
          }
          return library.executeBatch(input.planId, input.retryFailed, (file) =>
            shell.trashItem(file),
          );
        }
        case "importPaths": {
          let paths = input.paths;
          if (!paths) {
            const picked = await dialog.showOpenDialog(window, {
              title: "导入资源 / Import resources",
              properties: input.directories
                ? ["openDirectory", "multiSelections"]
                : ["openFile", "multiSelections"],
            });
            if (picked.canceled) return { added: 0, skipped: 0, failed: [], cancelled: true };
            paths = picked.filePaths;
          }
          return library.importPaths(input.target, paths, input.origin);
        }
        case "importBytes":
          return library.importBytes(input.target, input.name, input.bytes, input.origin);
        case "trash": {
          const selected = input.ids.map((id) => library.entry(id));
          const descendants = library.entries.filter(
            (e) =>
              !e.deleted &&
              selected.some((s) => e.path === s.path || e.path.startsWith(s.path + "/")),
          ).length;
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            message: `将 ${descendants} 个文件或文件夹移入系统废纸篓？ / Move ${descendants} items to the system trash?`,
            detail: selected
              .map((e) => e.path)
              .slice(0, 10)
              .join("\n"),
            buttons: ["取消 / Cancel", "移入废纸篓 / Move to trash"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response === 1)
            await library.trash(input.ids, (file) => shell.trashItem(file));
          return;
        }
        case "export": {
          const result = await dialog.showOpenDialog(window, {
            title: "导出资源 / Export resources",
            properties: ["openDirectory", "createDirectory"],
          });
          if (!result.canceled && result.filePaths[0])
            await library.export(input.ids, result.filePaths[0]);
          return;
        }
      }
    });
  });
  app.once("before-quit", () => library.close());
  return library;
}
