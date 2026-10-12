import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { WorkspaceMigrationItem } from "@synara/contracts/workspaceMigration";
export const within = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
};
export async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function statOrNull(file: string) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
/** Reject symlink ancestors, including an externally replaced destination directory. */
export async function assertRealAncestors(file: string) {
  let current = path.resolve(file);
  while (true) {
    const st = await statOrNull(current);
    if (st?.isSymbolicLink())
      throw new Error(`Symbolic directory requires manual migration: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".partial";
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
interface SourceFile {
  relative: string;
  kind: "directory" | "file" | "link";
  mode: number;
  bytes: number;
  modified: number;
  link?: string;
}
const inventoryIdentity = (entries: SourceFile[]) =>
  JSON.stringify(entries.map((e) => [e.relative, e.kind, e.mode, e.bytes, e.modified, e.link]));
async function inventory(root: string): Promise<SourceFile[]> {
  await assertRealAncestors(root);
  if (!(await fs.lstat(root)).isDirectory())
    throw new Error(`Source workspace is not a directory: ${root}`);
  const entries: SourceFile[] = [];
  const visit = async (relative: string) => {
    const file = path.join(root, relative),
      stat = await fs.lstat(file);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(file);
      // Relative internal links preserve their meaning after copying. Absolute or escaping links do not.
      if (path.isAbsolute(link) || !within(path.resolve(path.dirname(file), link), root))
        throw new Error(`External or absolute symbolic link requires manual migration: ${file}`);
      entries.push({ relative, kind: "link", mode, bytes: 0, modified: stat.mtimeMs, link });
      return;
    }
    if (path.basename(file) === ".git" && !stat.isDirectory())
      throw new Error(`Linked Git worktree requires manual repair: ${file}`);
    if (
      relative.endsWith(path.join(".git", "commondir")) ||
      relative.endsWith(path.join(".git", "objects", "info", "alternates"))
    )
      throw new Error(`External Git metadata requires manual repair: ${file}`);
    if (stat.isDirectory()) {
      entries.push({ relative, kind: "directory", mode, bytes: 0, modified: stat.mtimeMs });
      for (const name of (await fs.readdir(file)).toSorted()) {
        if (relative.endsWith(".git") && name === "worktrees")
          throw new Error(`Registered Git worktrees require manual repair: ${file}`);
        await visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      if (
        relative.endsWith(path.join(".git", "config")) &&
        /^\s*worktree\s*=/imu.test(await fs.readFile(file, "utf8"))
      )
        throw new Error(`Git core.worktree requires manual repair: ${file}`);
      entries.push({ relative, kind: "file", mode, bytes: stat.size, modified: stat.mtimeMs });
    } else throw new Error(`Unsupported filesystem entry: ${file}`);
  };
  await visit("");
  return entries;
}
export async function copyWorkspace(item: WorkspaceMigrationItem, persist: () => Promise<void>) {
  if (!item.target || within(item.target, item.source) || within(item.source, item.target))
    throw new Error("Source and destination must be separate directories.");
  await assertRealAncestors(item.source);
  await assertRealAncestors(item.target);
  const initial = await inventory(item.source);
  const conflicts: string[] = [];
  for (const entry of initial) {
    const dest = path.join(item.target, entry.relative);
    await assertRealAncestors(entry.kind === "link" ? path.dirname(dest) : dest);
    const existing = await statOrNull(dest);
    if (!existing) continue;
    if (
      entry.kind === "directory"
        ? !existing.isDirectory()
        : entry.kind === "link"
          ? !existing.isSymbolicLink() || (await fs.readlink(dest)) !== entry.link
          : !existing.isFile() ||
            (await fileHash(dest)) !== (await fileHash(path.join(item.source, entry.relative)))
    )
      conflicts.push(entry.relative || ".");
  }
  item.conflicts = conflicts;
  if (conflicts.length)
    throw new Error(
      "Destination contains different files. Resolve the reported conflicts and retry.",
    );
  item.status = "copying";
  await persist();
  const createdDirectories: SourceFile[] = [];
  for (const entry of initial) {
    const source = path.join(item.source, entry.relative),
      dest = path.join(item.target, entry.relative);
    await assertRealAncestors(path.dirname(dest));
    const existing = await statOrNull(dest);
    if (entry.kind === "directory") {
      if (!existing) {
        await fs.mkdir(dest, { recursive: true, mode: 0o700 });
        createdDirectories.push(entry);
      } else if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new Error(`Destination changed during migration: ${dest}`);
    } else if (entry.kind === "link") {
      if (!existing) await fs.symlink(entry.link!, dest);
      else if (!existing.isSymbolicLink() || (await fs.readlink(dest)) !== entry.link)
        throw new Error(`Destination link changed: ${dest}`);
    } else {
      const hash = await fileHash(source);
      if (!existing) {
        const temp = path.join(path.dirname(dest), `.aha-migrate-${randomUUID()}.partial`);
        try {
          await fs.copyFile(source, temp, 1);
          if ((await fileHash(temp)) !== hash || (await fileHash(source)) !== hash)
            throw new Error(`Source changed during copying: ${source}`);
          await fs.chmod(temp, entry.mode);
          const complete = await fs.open(temp, "r");
          try {
            await complete.sync();
          } finally {
            await complete.close();
          }
          await fs.link(temp, dest); // exclusive commit; never overwrite a concurrent writer
        } finally {
          await fs.rm(temp, { force: true });
        }
      } else if (!existing.isFile() || existing.isSymbolicLink() || (await fileHash(dest)) !== hash)
        throw new Error(`Destination changed during migration: ${dest}`);
      item.files[entry.relative] = { hash, bytes: entry.bytes, mode: entry.mode };
      await persist();
    }
  }
  for (const directory of createdDirectories.toReversed())
    await fs.chmod(path.join(item.target, directory.relative), directory.mode);
  const final = await inventory(item.source);
  if (inventoryIdentity(initial) !== inventoryIdentity(final))
    throw new Error(
      "Source changed during migration; no paths were switched. Retry when it is idle.",
    );
  for (const entry of final)
    if (entry.kind === "file") {
      const saved = item.files[entry.relative];
      if (
        !saved ||
        (await fileHash(path.join(item.source, entry.relative))) !== saved.hash ||
        (await fileHash(path.join(item.target, entry.relative))) !== saved.hash
      )
        throw new Error(`Content verification failed: ${entry.relative}`);
    }
  item.status = "verified";
  await persist();
}
