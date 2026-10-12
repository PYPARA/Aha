import { ResourceIndex } from "./resourceIndex";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  resourceType,
  type ResourceEntry,
  type ResourceOrigin,
  type ResourceSnapshot,
  type ResourcePage,
  type ResourceQuery,
  type ResourceImportResult,
} from "@synara/contracts/resourceLibrary";

const CONTROL = ".aha-resources";
const Metadata = z.object({
  version: z.literal(1),
  libraryId: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      name: z.string(),
      kind: z.enum(["file", "directory"]),
      bytes: z.number(),
      modifiedAt: z.number(),
      tags: z.array(z.string()),
      notes: z.string(),
      hash: z.string().regex(/^(?:[0-9a-f]{64})?$/u),
      fileKey: z.string(),
      deleted: z.boolean().optional(),
      origin: z
        .object({
          kind: z.enum(["drawing", "chat", "local", "game"]),
          threadId: z.string().optional(),
          messageId: z.string().optional(),
          jobId: z.string().optional(),
          batchId: z.string().optional(),
          prompt: z.string().optional(),
          model: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    }),
  ),
});
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function safeName(value: string) {
  const name = value.trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name === CONTROL ||
    // eslint-disable-next-line no-control-regex -- filesystem names cannot contain control characters.
    /[\\/\x00-\x1f<>:"|?*]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  )
    throw new Error("Invalid file or folder name.");
  if (Buffer.byteLength(name) > 240) throw new Error("File name is too long.");
  return name;
}
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + "/");
async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
async function atomicJson(file: string, data: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export class ResourceLibrary {
  root: string | null = null;
  libraryId: string | null = null;
  entries: ResourceEntry[] = [];
  error: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private cancelled = false;
  private closed = false;
  private index: ResourceIndex | undefined;
  constructor(
    readonly configFile: string,
    readonly changed: () => void = () => {},
    readonly progress: (name: string, completed: number) => void = () => {},
  ) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async load(defaultRoot?: string) {
    let configured: string;
    try {
      configured = z
        .object({ root: z.string() })
        .parse(JSON.parse(await fs.readFile(this.configFile, "utf8"))).root;
    } catch (e) {
      if (!missing(e)) {
        this.error = message(e);
        return;
      }
      if (!defaultRoot) return;
      try {
        await fs.mkdir(defaultRoot, { recursive: true });
        await this.open(defaultRoot);
      } catch (failure) {
        this.root = defaultRoot;
        this.error = message(failure);
      }
      return;
    }
    this.root = configured;
    try {
      await this.open(configured);
    } catch (e) {
      this.error = message(e);
    }
  }
  snapshot(): ResourceSnapshot {
    return {
      root: this.root,
      libraryId: this.libraryId,
      directories: this.entries.filter((e) => !e.deleted && e.kind === "directory"),
      count: this.entries.filter((e) => !e.deleted && e.kind === "file").length,
      error: this.error,
    };
  }
  // Every ancestor is checked: directory symlinks must never escape the selected library.
  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (!this.root) throw new Error("Choose a resource folder first.");
    if (
      relative &&
      (path.isAbsolute(relative) ||
        relative.includes("\\") ||
        relative.split("/").some((p) => !p || p === "." || p === ".." || p === CONTROL))
    )
      throw new Error("Invalid resource path.");
    const rootStat = await fs.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new Error("Resource folder is unavailable.");
    let current = this.root;
    for (const segment of relative.split("/").filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink()) throw new Error("Symbolic links are not supported.");
      } catch (e) {
        if (!(allowMissing && missing(e))) throw e;
      }
    }
    return current;
  }
  private async controlRoot() {
    if (!this.root) throw new Error("Choose a resource folder first.");
    await this.resolve("");
    const dir = path.join(this.root, CONTROL);
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid resource metadata directory.");
    return dir;
  }
  async open(directory: string) {
    const next = await fs.realpath(directory);
    if (!(await fs.stat(next)).isDirectory()) throw new Error("Select a folder.");
    const managed = path.join(next, CONTROL);
    if (await exists(managed)) {
      const st = await fs.lstat(managed);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error("Invalid resource metadata directory.");
    }
    const manifest = path.join(managed, "library.json");
    let data: z.infer<typeof Metadata>;
    if (await exists(manifest)) {
      if ((await fs.lstat(manifest)).isSymbolicLink()) throw new Error("Invalid metadata file.");
      data = Metadata.parse(JSON.parse(await fs.readFile(manifest, "utf8")));
    } else {
      const loose = (await fs.readdir(next, { withFileTypes: true })).filter(
        (e) => e.isFile() && !e.name.startsWith("."),
      );
      if (loose.length)
        throw new Error("Move files at the library root into project folders before opening it.");
      await fs.mkdir(managed, { recursive: true });
      data = { version: 1, libraryId: randomUUID(), entries: [] };
      await atomicJson(manifest, data);
    }
    this.stopWatching();
    this.root = next;
    this.libraryId = data.libraryId;
    this.entries = data.entries;
    await fs.mkdir(path.dirname(this.configFile), { recursive: true });
    await atomicJson(this.configFile, { root: next });
    await this.scan();
    this.rebuildIndex();
    this.startWatching();
    return this.snapshot();
  }
  private rebuildIndex() {
    if (!this.index) this.index = new ResourceIndex(this.configFile + ".index.sqlite");
    this.index.replace(this.entries);
  }
  private async persist() {
    const directory = await this.controlRoot();
    await atomicJson(path.join(directory, "library.json"), {
      version: 1,
      libraryId: this.libraryId,
      entries: this.entries,
    });
    this.rebuildIndex();
  }
  private stopWatching() {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
    clearInterval(this.poll);
  }
  close() {
    this.closed = true;
    this.stopWatching();
    this.index?.close();
    this.index = undefined;
  }
  private startWatching() {
    if (!this.root || this.closed) return;
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.serial(() => this.scan()).catch(() => {});
      }, 400);
      this.timer.unref();
    };
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (
          filename &&
          (String(filename).split(path.sep)[0] === CONTROL ||
            path.basename(String(filename)).startsWith(".aha-import-"))
        )
          return;
        schedule();
      });
      this.watcher.on("error", schedule);
      this.watcher.unref();
    } catch {
      /* periodic reconciliation also covers unsupported watch platforms */
    }
    this.poll = setInterval(schedule, 15_000);
    this.poll.unref();
  }
  async scan() {
    if (!this.root) return this.snapshot();
    if (!this.libraryId) return this.open(this.root);
    try {
      await this.controlRoot();
      const found: ResourceEntry[] = [];
      const oldPath = new Map(
        this.entries
          .toSorted((a, b) => Number(!!b.deleted) - Number(!!a.deleted))
          .map((e) => [e.path, e]),
      );
      const oldKey = new Map<string, ResourceEntry[]>();
      for (const e of this.entries) oldKey.set(e.fileKey, [...(oldKey.get(e.fileKey) ?? []), e]);
      const visit = async (relative: string) => {
        const directory = await this.resolve(relative);
        for (const item of await fs.readdir(directory, { withFileTypes: true })) {
          if (
            item.name === CONTROL ||
            item.name.startsWith(".aha-import-") ||
            item.name === ".DS_Store"
          )
            continue;
          if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
          if (!relative && !item.isDirectory()) continue;
          const rel = relative ? `${relative}/${item.name}` : item.name;
          const full = await this.resolve(rel);
          let st;
          try {
            st = await fs.stat(full);
          } catch (e) {
            if (missing(e)) continue;
            throw e;
          }
          const key = `${st.dev}:${st.ino}`;
          const prior = oldPath.get(rel);
          const hash = item.isFile()
            ? prior &&
              prior.fileKey === key &&
              prior.modifiedAt === st.mtimeMs &&
              prior.bytes === st.size
              ? prior.hash
              : await hashFile(full)
            : "";
          found.push({
            id: "",
            path: rel,
            name: item.name,
            kind: item.isDirectory() ? "directory" : "file",
            bytes: st.size,
            modifiedAt: st.mtimeMs,
            fileKey: key,
            hash,
            tags: [],
            notes: "",
          });
          if (item.isDirectory()) await visit(rel);
        }
      };
      await visit("");
      const paths = new Set(found.map((e) => e.path));
      const used = new Set<string>();
      for (const e of found) {
        const samePath = oldPath.get(e.path);
        const byKey = (oldKey.get(e.fileKey) ?? []).filter(
          (p) =>
            p.kind === e.kind &&
            !used.has(p.id) &&
            (p.path === e.path || !paths.has(p.path)) &&
            (!p.deleted || p.hash === e.hash),
        );
        let prior = byKey.length === 1 ? byKey[0] : undefined;
        if (
          !prior &&
          samePath?.kind === e.kind &&
          !used.has(samePath.id) &&
          (!samePath.deleted || samePath.hash === e.hash)
        )
          prior = samePath;
        if (!prior && e.hash) {
          const byHash = this.entries.filter(
            (p) => p.hash === e.hash && !paths.has(p.path) && !used.has(p.id),
          );
          if (byHash.length === 1 && found.filter((f) => f.hash === e.hash).length === 1)
            prior = byHash[0];
        }
        if (prior) {
          e.id = prior.id;
          e.tags = [...prior.tags];
          e.notes = prior.notes;
          if (prior.origin) e.origin = prior.origin;
        } else e.id = randomUUID();
        used.add(e.id);
      }
      const next = [
        ...found,
        ...this.entries
          .filter((e) => !used.has(e.id))
          .map((e) => Object.assign({}, e, { deleted: true })),
      ];
      const changed = JSON.stringify(next) !== JSON.stringify(this.entries) || this.error !== null;
      this.entries = next;
      this.error = null;
      if (changed) {
        await this.persist();
        this.changed();
      }
    } catch (e) {
      this.error = message(e);
      this.changed();
      throw e;
    }
    return this.snapshot();
  }
  list(query: ResourceQuery): ResourcePage {
    if (!this.root) return { entries: [], total: 0 };
    if (!this.index) this.rebuildIndex();
    return this.index!.list(query);
  }
  entry(id: string) {
    const value = this.entries.find((e) => e.id === id && !e.deleted);
    if (!value) throw new Error("Resource no longer exists. Refresh the library.");
    return value;
  }
  async createDirectory(parent: string, name: string) {
    const rel = [parent, safeName(name)].filter(Boolean).join("/");
    await fs.mkdir(await this.resolve(rel, true));
    await this.scan();
    return this.entries.find((e) => e.path === rel)!;
  }
  private selected(ids: string[]) {
    const entries = [...new Set(ids)].map((id) => this.entry(id));
    return entries.filter(
      (e) => !entries.some((p) => p.id !== e.id && p.kind === "directory" && under(e.path, p.path)),
    );
  }
  private async available(
    parent: string,
    name: string,
    hash?: string,
  ): Promise<{ path: string; skipped: boolean }> {
    safeName(name);
    for (let n = 0; n < 10000; n++) {
      const ext = path.extname(name),
        base = ext ? name.slice(0, -ext.length) : name;
      const candidate = n ? `${base} (${n})${ext}` : name;
      const rel = [parent, candidate].filter(Boolean).join("/");
      const full = await this.resolve(rel, true);
      if (!(await exists(full))) return { path: rel, skipped: false };
      if (hash && (await fs.lstat(full)).isFile() && (await hashFile(full)) === hash)
        return { path: rel, skipped: true };
    }
    throw new Error("Too many files with this name.");
  }
  async relocate(ids: string[], target: string | null, name?: string) {
    const selected = this.selected(ids);
    if (name) safeName(name);
    for (const [i, entry] of selected.entries()) {
      const parent = target ?? entry.path.split("/").slice(0, -1).join("/");
      if (!parent && entry.kind === "file") throw new Error("Files must belong to a project.");
      if (entry.kind === "directory" && parent && under(parent, entry.path))
        throw new Error("A folder cannot be moved into itself.");
      const ext = entry.kind === "file" ? path.extname(entry.name) : "";
      const nextName = name
        ? selected.length > 1
          ? `${name}-${String(i + 1).padStart(3, "0")}${ext}`
          : name
        : entry.name;
      if ([parent, nextName].filter(Boolean).join("/") === entry.path) continue;
      const destination = await this.available(parent, nextName);
      const old = entry.path;
      await fs.rename(await this.resolve(old), await this.resolve(destination.path, true));
      for (const child of this.entries)
        if (!child.deleted && under(child.path, old)) {
          child.path = destination.path + child.path.slice(old.length);
          child.name = path.posix.basename(child.path);
        }
      await this.persist();
    }
    return this.scan();
  }
  async metadata(ids: string[], tags?: string[], notes?: string) {
    for (const id of ids) {
      const entry = this.entry(id);
      if (tags !== undefined) entry.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      if (notes !== undefined) entry.notes = notes;
    }
    await this.persist();
    this.changed();
  }
  async trash(ids: string[], remove: (file: string) => Promise<void>) {
    try {
      for (const entry of this.selected(ids)) {
        await remove(await this.resolve(entry.path));
        for (const child of this.entries) if (under(child.path, entry.path)) child.deleted = true;
        await this.persist();
      }
    } finally {
      await this.scan();
    }
  }
  cancelImport() {
    this.cancelled = true;
  }
  private async copyOne(
    source: string | Uint8Array,
    target: string,
    name: string,
    origin?: ResourceOrigin,
  ) {
    if (!target) throw new Error("Choose a project or folder.");
    const parent = await this.resolve(target);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error("Choose a folder.");
    const temp = path.join(parent, `.aha-import-${randomUUID()}`);
    try {
      if (typeof source === "string") await fs.copyFile(source, temp, 1);
      else await fs.writeFile(temp, source, { flag: "wx" });
      const hash = await hashFile(temp);
      const dest = await this.available(target, name, hash);
      if (dest.skipped) return false;
      // Exclusive link commits the completed file without overwriting an external concurrent write.
      await fs.link(temp, await this.resolve(dest.path, true));
      const st = await fs.stat(temp);
      this.entries.push({
        id: randomUUID(),
        path: dest.path,
        name: path.posix.basename(dest.path),
        kind: "file",
        bytes: st.size,
        modifiedAt: st.mtimeMs,
        hash,
        fileKey: `${st.dev}:${st.ino}`,
        tags: [],
        notes: "",
        ...(origin ? { origin } : {}),
      });
      await this.persist();
      return true;
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async importBytes(target: string, name: string, bytes: Uint8Array, origin?: ResourceOrigin) {
    const added = await this.copyOne(bytes, target, safeName(name), origin);
    await this.scan();
    return {
      added: added ? 1 : 0,
      skipped: added ? 0 : 1,
      failed: [],
      cancelled: false,
    } satisfies ResourceImportResult;
  }
  async importPaths(target: string, sources: string[], origin?: ResourceOrigin) {
    if (!target) throw new Error("Choose a project or folder.");
    await this.resolve(target);
    this.cancelled = false;
    const result: ResourceImportResult = { added: 0, skipped: 0, failed: [], cancelled: false };
    const visit = async (source: string, parent: string) => {
      if (this.cancelled) {
        result.cancelled = true;
        return;
      }
      try {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) throw new Error("Symbolic links are not imported.");
        const name = safeName(path.basename(source));
        if (stat.isDirectory()) {
          if (name === CONTROL) return;
          const real = await fs.realpath(source);
          const destination = await this.resolve(parent);
          if (destination === real || destination.startsWith(real + path.sep))
            throw new Error("Cannot import a folder into itself.");
          const dest = await this.available(parent, name);
          await fs.mkdir(await this.resolve(dest.path, true));
          for (const item of await fs.readdir(source)) {
            if (item === CONTROL || item === ".DS_Store" || item.startsWith(".aha-import-"))
              continue;
            await visit(path.join(source, item), dest.path);
            if (this.cancelled) break;
          }
        } else if (stat.isFile()) {
          if (await this.copyOne(source, parent, name, origin ?? { kind: "local" })) result.added++;
          else result.skipped++;
          this.progress(name, result.added + result.skipped + result.failed.length);
        }
      } catch (e) {
        result.failed.push({ name: path.basename(source), path: source, error: message(e) });
      }
    };
    for (const source of sources) {
      await visit(source, target);
      if (this.cancelled) break;
    }
    result.cancelled = this.cancelled;
    await this.scan();
    return result;
  }
  async read(id: string, thumbnail = false) {
    const e = this.entry(id);
    if (e.kind !== "file") throw new Error("Choose a file.");
    const full = await this.resolve(e.path);
    const extension = path.extname(e.name).toLowerCase();
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".avif": "image/avif",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".json": "application/json",
      ".pdf": "application/pdf",
    };
    if (thumbnail) {
      if (resourceType(e.name) !== "image") throw new Error("No image preview.");
      const cache = path.join(await this.controlRoot(), "thumbnails");
      await fs.mkdir(cache, { recursive: true });
      if ((await fs.lstat(cache)).isSymbolicLink()) throw new Error("Invalid cache directory.");
      const destination = path.join(cache, e.hash + ".webp");
      if (!(await exists(destination))) {
        const bytes = await sharp(full, { limitInputPixels: 64_000_000 })
          .rotate()
          .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        await fs.writeFile(destination, bytes, { flag: "wx" }).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
      }
      if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error("Invalid thumbnail.");
      return {
        name: e.name,
        mimeType: "image/webp",
        bytes: new Uint8Array(await fs.readFile(destination)),
      };
    }
    if ((await fs.stat(full)).size > 100 * 1024 * 1024)
      throw new Error("This file exceeds the 100 MiB attachment limit. Export it instead.");
    return {
      name: e.name,
      mimeType: mime[extension] ?? "application/octet-stream",
      bytes: new Uint8Array(await fs.readFile(full)),
    };
  }
  async export(ids: string[], destination: string) {
    const output = await fs.realpath(destination);
    if (this.root && (output === this.root || output.startsWith(this.root + path.sep)))
      throw new Error("Choose an export folder outside the resource library.");
    const copy = async (source: string, dest: string) => {
      const st = await fs.lstat(source);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        await fs.mkdir(dest);
        for (const name of await fs.readdir(source))
          if (name !== CONTROL && name !== ".DS_Store" && !name.startsWith(".aha-import-"))
            await copy(path.join(source, name), path.join(dest, name));
      } else if (st.isFile()) await fs.copyFile(source, dest, 1);
    };
    for (const entry of this.selected(ids)) {
      let dest = path.join(output, entry.name),
        n = 1;
      while (await exists(dest)) {
        const ext = path.extname(entry.name);
        dest = path.join(output, `${path.basename(entry.name, ext)} (${n++})${ext}`);
      }
      await copy(await this.resolve(entry.path), dest);
    }
  }
}
