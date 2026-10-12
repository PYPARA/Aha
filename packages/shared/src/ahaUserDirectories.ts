import { posix, win32 } from "node:path";
/** One layout shared by Electron and the server. Electron supplies app.getPath("documents"). */
export function ahaUserDirectories(
  homeDir: string,
  documentsDirectory?: string,
  platform = process.platform,
) {
  const p = platform === "win32" ? win32 : posix;
  const documents = documentsDirectory?.trim() || p.join(homeDir, "Documents");
  const root = p.join(documents, "Aha");
  return {
    root,
    resource: p.join(root, "Resource"),
    chats: p.join(root, "Chats"),
    studio: p.join(root, "Studio"),
    groups: p.join(root, "Groups"),
    legacyRoot: p.join(documents, "Synara"),
  };
}
