import { SpriteId, SpriteProjectDataSchema } from "@synara/contracts/spriteLibrarySchema";
import { ipcMain, shell, type BrowserWindow } from "electron";
import { z } from "zod";
import { SPRITE_LIBRARY_CHANNEL } from "@synara/contracts/spriteLibrary";
import { SpriteLibrary } from "./library";
const bytes = z.instanceof(Uint8Array).refine((b) => b.byteLength <= 80 * 1024 * 1024);
const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("reveal") }),
  z.object({ op: z.literal("get"), id: SpriteId }),
  z.object({
    op: z.literal("readImage"),
    id: SpriteId,
    file: z.string().regex(/^(thumbnail\.png|images\/[a-f0-9]{64}\.(png|jpg|webp))$/),
  }),
  z.object({
    op: z.literal("save"),
    project: SpriteProjectDataSchema,
    images: z
      .array(z.object({ file: z.string().max(100), bytes }))
      .max(1024)
      .refine(
        (images) => images.reduce((n, image) => n + image.bytes.byteLength, 0) <= 80 * 1024 * 1024,
        "Project images exceed 80 MiB.",
      ),
    thumbnail: bytes.nullable(),
  }),
  z.object({ op: z.literal("rename"), id: SpriteId, name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal("beginDelete"), id: SpriteId }),
  z.object({ op: z.literal("finishDelete"), id: SpriteId }),
]);
export function registerSpriteLibrary(root: string, getWindow: () => BrowserWindow | null) {
  const library = new SpriteLibrary(root);
  ipcMain.removeHandler(SPRITE_LIBRARY_CHANNEL);
  ipcMain.handle(SPRITE_LIBRARY_CHANNEL, async (event, raw: unknown) => {
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
    const c = Command.parse(raw);
    return library.serial(async () => {
      switch (c.op) {
        case "list":
          return library.list();
        case "get":
          return library.get(c.id);
        case "readImage":
          return library.readImage(c.id, c.file);
        case "save":
          return library.save(c.project, c.images, c.thumbnail);
        case "rename":
          return library.rename(c.id, c.name);
        case "beginDelete":
          return library.beginDelete(c.id);
        case "finishDelete":
          return library.finishDelete(c.id);
        case "reveal": {
          await library.list();
          const error = await shell.openPath(root);
          if (error) throw new Error(error);
          return;
        }
      }
    });
  });
  return library;
}
