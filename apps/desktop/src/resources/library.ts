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
  type ResourceScanState,
  type ResourceDirectoryStats,
  type ResourceLocateResult,
  type ResourcePage,
  type ResourceQuery,
  type ResourceImportResult,
  type ResourceTagMode,
  type ResourceBatchAction,
  type ResourceBatchPlan,
  type ResourceBatchItemResult,
  type ResourceBatchResult,
  type ResourceCollectionOperation,
  type ResourceCollectionItem,
  type ResourceCollectionConflict,
  type ResourceCollectionConflicts,
  type ResourceChangeScope,
  type ResourceLinkState,
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
          kind: z.enum(["drawing", "chat", "local", "game", "image-batch", "sprite", "model3d"]),
          threadId: z.string().optional(),
          messageId: z.string().optional(),
          jobId: z.string().optional(),
          batchId: z.string().optional(),
          taskId: z.string().optional(),
          attemptId: z.string().optional(),
          resultId: z.string().optional(),
          projectId: z.string().optional(),
          versionId: z.string().optional(),
          prompt: z.string().optional(),
          model: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    }),
  ),
});
const CollectionOperations = z.array(
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    libraryId: z.string(),
    directoryId: z.string().nullable(),
    directoryKey: z.string(),
    createdAt: z.string(),
    released: z.boolean().optional(),
    onConflict: z.enum(["replace", "keep-both"]).optional(),
    items: z.array(
      z.object({
        resultId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        assetId: z.string().regex(/^[a-f0-9]{64}$/),
        name: z.string(),
        folder: z.string().optional(),
        origin: Metadata.shape.entries.element.shape.origin.unwrap(),
        status: z.enum(["queued", "writing", "committed", "linked", "failed", "superseded"]),
        resourceId: z.string().optional(),
        path: z.string().optional(),
        fileKey: z.string().optional(),
        replaced: z.boolean().optional(),
        error: z.string().optional(),
      }),
    ),
  }),
);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Relative folder path made of safe names; empty segments, "." and ".." are rejected. */
export function folderSegments(value: string) {
  const segments = value.split("/");
  if (segments.length > 16) throw new Error("Folder path is too deep.");
  return segments.map(safeName);
}
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
/** JSON with object keys sorted, so field order alone never counts as a change. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
/** Same entries regardless of order: a rescan must not rewrite what the app itself just wrote. */
export const sameEntries = (a: ResourceEntry[], b: ResourceEntry[]) =>
  a.length === b.length &&
  a.map(canonical).toSorted().join("\n") === b.map(canonical).toSorted().join("\n");
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + "/");
const parentPath = (relative: string) => relative.split("/").slice(0, -1).join("/");
async function copyResourceExclusive(source: string, destination: string) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be exported.");
  if (stat.isDirectory()) {
    await fs.mkdir(destination);
    try {
      for (const name of await fs.readdir(source))
        if (name !== CONTROL && name !== ".DS_Store" && !name.startsWith(".aha-import-"))
          await copyResourceExclusive(path.join(source, name), path.join(destination, name));
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true });
      throw error;
    }
  } else if (stat.isFile()) await fs.copyFile(source, destination, 1);
  else throw new Error("Choose a file or folder.");
}
async function moveResourceExclusive(
  source: string,
  destination: string,
  kind: ResourceEntry["kind"],
) {
  if (kind === "file") {
    // link() reserves the exact destination without replacing anything, and preserves identity.
    await fs.link(source, destination);
    try {
      await fs.unlink(source);
    } catch (error) {
      await fs.unlink(destination);
      throw error;
    }
  } else {
    // Reserve an empty directory. rename cannot replace one that another process populated.
    await fs.mkdir(destination);
    const reservation = await fs.lstat(destination);
    try {
      await fs.rename(source, destination);
    } catch (error) {
      const current = await fs.lstat(destination).catch(() => null);
      if (current?.ino === reservation.ino && current.dev === reservation.dev)
        await fs.rmdir(destination).catch(() => {});
      throw error;
    }
  }
}
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
  private collections: ResourceCollectionOperation[] | null = null;
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
  private revision = 0;
  /** Revision the renderer was last told about; a quiet rescan reports only newer revisions. */
  private notifiedRevision = -1;
  private published: ResourceEntry[] = [];
  private directoryStats: ResourceDirectoryStats[] = [];
  private scanState: ResourceScanState = {
    phase: "loading",
    lastCompletedAt: null,
    failedPath: null,
    skipped: { system: 0, temporary: 0, symbolicLinks: 0, unsupported: 0 },
  };
  assertWritable() {
    if (this.error || this.scanState.phase !== "ready")
      throw new Error("The library is not ready for changes. Rescan it first.");
  }
  private fail(error: unknown, failedPath: string | null = this.scanState.failedPath) {
    this.error = message(error);
    this.scanState = { ...this.scanState, phase: "failed", failedPath };
    this.notify();
  }
  private updateStats() {
    const active = this.published.filter((e) => !e.deleted);
    const stats = new Map<string, ResourceDirectoryStats>([
      ["", { id: null, path: "", directFiles: 0, directDirectories: 0, recursiveFiles: 0 }],
    ]);
    for (const e of active)
      if (e.kind === "directory")
        stats.set(e.path, {
          id: e.id,
          path: e.path,
          directFiles: 0,
          directDirectories: 0,
          recursiveFiles: 0,
        });
    for (const e of active) {
      const parent = parentPath(e.path),
        direct = stats.get(parent);
      if (e.kind === "directory") {
        if (direct) direct.directDirectories++;
        continue;
      }
      if (direct) direct.directFiles++;
      let current = parent;
      for (;;) {
        const value = stats.get(current);
        if (value) value.recursiveFiles++;
        if (!current) break;
        current = parentPath(current);
      }
    }
    this.directoryStats = [...stats.values()];
  }
  private batch: {
    plan: ResourceBatchPlan;
    sources: Map<string, Pick<ResourceEntry, "path" | "fileKey" | "hash">>;
    trees: Map<string, string>;
    parents: Map<string, { path: string; fileKey: string }>;
    results: Map<string, ResourceBatchItemResult>;
  } | null = null;
  constructor(
    readonly configFile: string,
    readonly changed: (scope?: ResourceChangeScope) => void = () => {},
    readonly progress: (name: string, completed: number) => void = () => {},
  ) {}
  private notify(scope: ResourceChangeScope = "library") {
    if (scope === "library") this.notifiedRevision = this.revision;
    this.changed(scope);
  }
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
        this.fail(e);
        return;
      }
      if (!defaultRoot) {
        this.scanState = { ...this.scanState, phase: "ready" };
        this.notify();
        return;
      }
      try {
        await fs.mkdir(defaultRoot, { recursive: true });
        await this.open(defaultRoot);
      } catch (failure) {
        this.root = defaultRoot;
        this.fail(failure);
      }
      return;
    }
    this.root = configured;
    try {
      await this.open(configured);
    } catch (e) {
      this.fail(e);
    }
  }
  snapshot(): ResourceSnapshot {
    return {
      root: this.root,
      libraryId: this.libraryId,
      directories: this.published.filter((e) => !e.deleted && e.kind === "directory"),
      count: this.published.filter((e) => !e.deleted && e.kind === "file").length,
      error: this.error,
      revision: this.revision,
      directoryStats: this.directoryStats,
      scan: this.scanState,
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
    this.batch = null;
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
      await fs.mkdir(managed, { recursive: true });
      data = { version: 1, libraryId: randomUUID(), entries: [] };
      await atomicJson(manifest, data);
    }
    this.stopWatching();
    this.root = next;
    this.libraryId = data.libraryId;
    this.closed = false;
    this.entries = structuredClone(data.entries);
    this.published = structuredClone(data.entries);
    this.error = null;
    this.scanState = {
      phase: "loading",
      lastCompletedAt: null,
      failedPath: null,
      skipped: { system: 0, temporary: 0, symbolicLinks: 0, unsupported: 0 },
    };
    try {
      await fs.mkdir(path.dirname(this.configFile), { recursive: true });
      this.rebuildIndex();
      this.notify();
      await atomicJson(this.configFile, { root: next });
      this.startWatching();
      await this.scan();
    } catch (error) {
      if (this.scanState.phase !== "failed") this.fail(error, this.configFile);
      throw error;
    }
    return this.snapshot();
  }
  private rebuildIndex() {
    if (!this.index) this.index = new ResourceIndex(this.configFile + ".index.sqlite");
    this.index.replace(this.published);
    this.index.revision = ++this.revision;
    this.updateStats();
  }
  private async persist(next = this.entries) {
    try {
      const directory = await this.controlRoot();
      await atomicJson(path.join(directory, "library.json"), {
        version: 1,
        libraryId: this.libraryId,
        entries: next,
      });
      if (!this.index) this.index = new ResourceIndex(this.configFile + ".index.sqlite");
      this.index.replace(next);
      this.entries = next;
      this.published = structuredClone(next);
      this.index.revision = ++this.revision;
      this.updateStats();
    } catch (error) {
      this.entries = structuredClone(this.published);
      this.fail(error, CONTROL + "/library.json");
      throw error;
    }
  }
  private stopWatching() {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
    clearInterval(this.poll);
  }
  close() {
    this.batch = null;
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
            path.basename(String(filename)) === ".DS_Store" ||
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
  /**
   * Reconciles the index with the folder. Watcher, poll and post-write scans run quietly: the
   * library stays "ready" and the renderer hears only about real changes, so an idle page does
   * not flash a scanning state every few seconds. Opening and an explicit rescan are visible.
   */
  async scan({ visible = false }: { visible?: boolean } = {}) {
    if (!this.root) return this.snapshot();
    if (!this.libraryId) return this.open(this.root);
    const shown = visible || this.scanState.phase !== "ready";
    if (shown) {
      this.scanState = { ...this.scanState, phase: "scanning", failedPath: null };
      this.notify();
    }
    let scanningPath = "";
    const skipped = { system: 0, temporary: 0, symbolicLinks: 0, unsupported: 0 };
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
        scanningPath = relative;
        const directory = await this.resolve(relative);
        for (const item of await fs.readdir(directory, { withFileTypes: true })) {
          if (item.name === CONTROL || item.name === ".DS_Store") {
            skipped.system++;
            continue;
          }
          if (item.name.startsWith(".aha-import-")) {
            skipped.temporary++;
            continue;
          }
          if (item.isSymbolicLink()) {
            skipped.symbolicLinks++;
            continue;
          }
          if (!item.isDirectory() && !item.isFile()) {
            skipped.unsupported++;
            continue;
          }
          const rel = relative ? `${relative}/${item.name}` : item.name;
          scanningPath = rel;
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
      const changed = !sameEntries(next, this.entries) || this.error !== null;
      if (changed) await this.persist(next);
      this.error = null;
      this.scanState = { phase: "ready", lastCompletedAt: Date.now(), failedPath: null, skipped };
      if (shown || this.revision !== this.notifiedRevision) this.notify();
    } catch (e) {
      this.fail(e, this.scanState.failedPath ?? scanningPath);
      throw e;
    }
    return this.snapshot();
  }
  list(query: ResourceQuery): ResourcePage {
    if (!this.root) return { entries: [], total: 0 };
    if (!this.index) this.rebuildIndex();
    return this.index!.list(query);
  }
  async locate(id: string, sort: ResourceQuery["sort"]): Promise<ResourceLocateResult> {
    const entry = this.published.find((entry) => entry.id === id && !entry.deleted);
    if (!entry || !this.index) throw new Error("Resource no longer exists. Refresh the library.");
    const stat = await fs.lstat(await this.resolve(entry.path));
    if (`${stat.dev}:${stat.ino}` !== entry.fileKey || stat.isSymbolicLink())
      throw new Error("The resource changed while locating it. Try again.");
    const parent = parentPath(entry.path);
    return {
      entry: structuredClone(entry),
      parentId:
        this.published.find((e) => !e.deleted && e.kind === "directory" && e.path === parent)?.id ??
        null,
      parentPath: parent,
      offset: this.index!.locate(entry, sort),
      revision: this.revision,
    };
  }
  entry(id: string) {
    const value = this.entries.find((e) => e.id === id && !e.deleted);
    if (!value) throw new Error("Resource no longer exists. Refresh the library.");
    return value;
  }
  async resourceState(libraryId: string, id: string): Promise<ResourceLinkState> {
    if (libraryId !== this.libraryId) return { status: "other-library" };
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry || entry.deleted) return { status: "removed" };
    try {
      const stat = await fs.lstat(await this.resolve(entry.path));
      if (stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== entry.fileKey)
        return { status: "unavailable", error: "Resource identity changed. Refresh the library." };
      return { status: "available", name: entry.name };
    } catch (error) {
      return missing(error)
        ? { status: "removed" }
        : { status: "unavailable", error: message(error) };
    }
  }
  async createDirectory(parent: string, name: string) {
    this.assertWritable();
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
  /** Creates and indexes a collection subfolder without following links outside the library. */
  private async ensureFolder(parent: string, folder: string | undefined) {
    let rel = parent;
    const added: ResourceEntry[] = [];
    for (const segment of folder === undefined ? [] : folderSegments(folder)) {
      rel = [rel, segment].filter(Boolean).join("/");
      const full = await this.resolve(rel, true);
      if (!(await exists(full))) await fs.mkdir(full);
      const stat = await fs.lstat(full);
      if (!stat.isDirectory()) throw new Error("A file already uses this folder name.");
      if (!this.entries.some((entry) => entry.path === rel && !entry.deleted))
        added.push({
          id: randomUUID(),
          path: rel,
          name: segment,
          kind: "directory",
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
          fileKey: `${stat.dev}:${stat.ino}`,
          hash: "",
          tags: [],
          notes: "",
        });
    }
    if (added.length) await this.persist([...this.entries, ...added]);
    return rel;
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
    this.assertWritable();
    const selected = this.selected(ids);
    if (name) safeName(name);
    for (const [i, entry] of selected.entries()) {
      const parent = target ?? entry.path.split("/").slice(0, -1).join("/");
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
  async metadata(
    ids: string[],
    tags?: string[],
    notes?: string,
    mode: ResourceTagMode = "replace",
  ) {
    this.assertWritable();
    const before = this.entries;
    // Build the next manifest separately: a failed write must not mutate the live index.
    const wanted = new Set(ids);
    for (const id of wanted) this.entry(id);
    const normalized = [...new Set(tags?.map((t) => t.trim()).filter(Boolean) ?? [])];
    this.entries = before.map((entry) => {
      if (!wanted.has(entry.id)) return entry;
      const nextTags =
        tags === undefined
          ? entry.tags
          : mode === "add"
            ? [...new Set([...entry.tags, ...normalized])]
            : mode === "remove"
              ? entry.tags.filter((tag) => !normalized.includes(tag))
              : normalized;
      if (nextTags.length > 100) throw new Error("A resource can have at most 100 tags.");
      return { ...entry, tags: nextTags, ...(notes === undefined ? {} : { notes }) };
    });
    try {
      await this.persist();
    } catch (error) {
      this.entries = before;
      throw error;
    }
    this.notify();
  }
  async prepareBatch(
    action: ResourceBatchAction,
    ids: string[],
    target?: string,
    name?: string,
  ): Promise<ResourceBatchPlan> {
    if (!this.libraryId || !this.root) throw new Error("Choose a project or folder.");
    this.batch = null;
    await this.scan();
    this.assertWritable();
    if (action === "move" && target === undefined) throw new Error("Choose a destination folder.");
    const ordered = [...new Set(ids)];
    const entries = ordered.flatMap((id) => {
      const entry = this.entries.find((e) => e.id === id && !e.deleted);
      return entry ? [entry] : [];
    });
    const roots = entries.filter(
      (entry) =>
        !entries.some(
          (parent) =>
            parent.id !== entry.id && parent.kind === "directory" && under(entry.path, parent.path),
        ),
    );
    const rootIds = new Set(roots.map((entry) => entry.id));
    const sources = new Map<string, Pick<ResourceEntry, "path" | "fileKey" | "hash">>();
    const reserved = new Set<string>();
    const trees = new Map<string, string>();
    const parents = new Map<string, { path: string; fileKey: string }>();
    const plan: ResourceBatchPlan = {
      id: randomUUID(),
      libraryId: this.libraryId,
      action,
      items: [],
      affectedCount: this.entries.filter(
        (entry) => !entry.deleted && roots.some((parent) => under(entry.path, parent.path)),
      ).length,
    };
    let exportRoot: string | undefined;
    if (action === "export") {
      if (!target) throw new Error("Choose an export folder outside the resource library.");
      exportRoot = await fs.realpath(target);
      if (under(exportRoot, this.root))
        throw new Error("Choose an export folder outside the resource library.");
    }
    for (const id of ordered) {
      const entry = entries.find((e) => e.id === id);
      const item: ResourceBatchPlan["items"][number] = {
        id,
        source: entry?.path ?? id,
        status: "ready",
      };
      plan.items.push(item);
      if (!entry) {
        item.status = "failed";
        item.error = "Resource no longer exists. Refresh the library.";
        continue;
      }
      if (!rootIds.has(id)) {
        item.status = "skipped";
        continue;
      }
      sources.set(id, { path: entry.path, fileKey: entry.fileKey, hash: entry.hash });
      if (entry.kind === "directory") trees.set(id, this.batchTree(entry.path));
      try {
        if (action === "trash") continue;
        const parent = action === "rename" ? parentPath(entry.path) : (target ?? "");
        let proposed = entry.name;
        if (action === "rename") {
          safeName(name ?? "");
          proposed =
            roots.length > 1
              ? `${name}-${String(roots.findIndex((e) => e.id === id) + 1).padStart(3, "0")}${entry.kind === "file" ? path.extname(entry.name) : ""}`
              : name!;
        }
        safeName(proposed);
        if (action !== "export") {
          if (entry.kind === "directory" && parent && under(parent, entry.path))
            throw new Error("A folder cannot be moved into itself.");
          const destinationParent = await this.resolve(parent);
          if (!(await fs.stat(destinationParent)).isDirectory())
            throw new Error("Choose a folder.");
          if ([parent, proposed].filter(Boolean).join("/") === entry.path) {
            item.target = entry.path;
            item.status = "skipped";
            continue;
          }
        }
        for (let suffix = 0; suffix < 10000; suffix++) {
          const ext = entry.kind === "file" ? path.extname(proposed) : "";
          const candidate = suffix
            ? `${proposed.slice(0, proposed.length - ext.length)} (${suffix})${ext}`
            : proposed;
          const destination =
            action === "export"
              ? path.join(exportRoot!, candidate)
              : [parent, candidate].filter(Boolean).join("/");
          const full = action === "export" ? destination : await this.resolve(destination, true);
          if (!reserved.has(destination) && !(await exists(full))) {
            const directory = await fs.realpath(path.dirname(full));
            const stat = await fs.stat(directory);
            item.target = destination;
            reserved.add(destination);
            parents.set(id, { path: directory, fileKey: `${stat.dev}:${stat.ino}` });
            break;
          }
        }
        if (!item.target) throw new Error("Too many files with this name.");
      } catch (error) {
        item.status = "failed";
        item.error = message(error);
      }
    }
    this.batch = { plan, sources, trees, parents, results: new Map() };
    return structuredClone(plan);
  }
  batchPlan(id: string): ResourceBatchPlan {
    if (!this.batch || this.batch.plan.id !== id || this.batch.plan.libraryId !== this.libraryId)
      throw new Error("This operation preview has expired. Prepare it again.");
    return structuredClone(this.batch.plan);
  }
  private batchTree(relative: string) {
    return JSON.stringify(
      this.entries
        .filter((entry) => !entry.deleted && under(entry.path, relative))
        .map((entry) => [entry.id, entry.path, entry.fileKey, entry.hash])
        .toSorted((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  }
  batchPendingItems(id: string, retryFailed = false) {
    const plan = this.batchPlan(id);
    return plan.items.filter(
      (item) =>
        item.status === "ready" &&
        (!this.batch!.results.has(item.id) ||
          (retryFailed && this.batch!.results.get(item.id)?.status === "failed")),
    );
  }
  async executeBatch(
    id: string,
    retryFailed = false,
    trash?: (file: string) => Promise<void>,
  ): Promise<ResourceBatchResult> {
    this.assertWritable();
    const plan = this.batchPlan(id),
      batch = this.batch!;
    let halted: string | null = null;
    try {
      try {
        await this.scan();
      } catch (cause) {
        halted = message(cause);
      }
      for (const item of plan.items) {
        const previous = batch.results.get(item.id);
        if (previous && (previous.status !== "failed" || !retryFailed)) continue;
        if (item.status !== "ready") {
          batch.results.set(item.id, { ...item, status: item.status });
          continue;
        }
        const result: ResourceBatchItemResult = { ...item, status: "failed" };
        batch.results.set(item.id, result);
        if (halted) {
          result.error = halted;
          continue;
        }
        let changed = false;
        try {
          await this.controlRoot();
          const entry = this.entry(item.id),
            expected = batch.sources.get(item.id)!;
          const source = await this.resolve(entry.path),
            stat = await fs.lstat(source);
          if (
            entry.path !== expected.path ||
            `${stat.dev}:${stat.ino}` !== expected.fileKey ||
            (entry.kind === "file" && (await hashFile(source)) !== expected.hash)
          )
            throw new Error("The resource changed after the preview. Prepare it again.");
          if (entry.kind === "directory" && batch.trees.get(item.id) !== this.batchTree(entry.path))
            throw new Error("The resource changed after the preview. Prepare it again.");
          const parent = batch.parents.get(item.id);
          if (parent && item.target) {
            const destination =
              plan.action === "export" ? item.target : await this.resolve(item.target, true);
            const realParent = await fs.realpath(path.dirname(destination)),
              parentStat = await fs.stat(realParent);
            if (
              realParent !== parent.path ||
              `${parentStat.dev}:${parentStat.ino}` !== parent.fileKey ||
              (plan.action === "export" && under(realParent, this.root!))
            )
              throw new Error("The resource changed after the preview. Prepare it again.");
          }
          if (plan.action === "export") {
            await copyResourceExclusive(source, item.target!);
          } else if (plan.action === "trash") {
            if (!trash) throw new Error("System trash is unavailable.");
            await trash(source);
            changed = true;
            for (const child of this.entries)
              if (under(child.path, entry.path)) child.deleted = true;
          } else {
            const destination = await this.resolve(item.target!, true);
            await moveResourceExclusive(source, destination, entry.kind);
            changed = true;
            const old = entry.path;
            for (const child of this.entries)
              if (!child.deleted && under(child.path, old)) {
                child.path = item.target! + child.path.slice(old.length);
                child.name = path.posix.basename(child.path);
              }
          }
          result.status = "succeeded";
          if (changed) await this.persist();
          delete result.error;
        } catch (error) {
          result.error = message(error);
          // A completed filesystem change must never be replayed after a manifest failure.
          if (changed) {
            result.status = "succeeded";
            halted = result.error;
          } else if (this.error) halted = result.error;
        }
      }
    } finally {
      if (plan.action !== "export") {
        try {
          await this.scan();
        } catch (error) {
          for (const result of batch.results.values()) result.error ??= message(error);
        }
      }
      this.notify();
    }
    return { planId: plan.id, items: structuredClone([...batch.results.values()]) };
  }
  async trash(ids: string[], remove: (file: string) => Promise<void>) {
    this.assertWritable();
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
  async listCollections(): Promise<ResourceCollectionOperation[]> {
    if (!this.collections) {
      try {
        this.collections = CollectionOperations.parse(
          JSON.parse(await fs.readFile(this.configFile + ".collections.json", "utf8")),
        );
      } catch (error) {
        if (!missing(error)) throw error;
        this.collections = [];
      }
    }
    return structuredClone(this.collections!);
  }
  private async persistCollections() {
    await fs.mkdir(path.dirname(this.configFile), { recursive: true });
    await atomicJson(this.configFile + ".collections.json", this.collections);
    this.notify("collections");
  }
  private async collection(id: string) {
    await this.listCollections();
    const operation = this.collections!.find((item) => item.id === id);
    if (!operation) throw new Error("Collection operation is unavailable.");
    return operation;
  }
  private async collectionTarget(operation: ResourceCollectionOperation) {
    this.assertWritable();
    if (operation.libraryId !== this.libraryId)
      throw new Error("The target library changed. Choose the destination again.");
    const directory = operation.directoryId === null ? "" : this.entry(operation.directoryId).path;
    if (operation.directoryId !== null && this.entry(operation.directoryId).kind !== "directory")
      throw new Error("Choose a folder.");
    const stat = await fs.lstat(await this.resolve(directory));
    if (`${stat.dev}:${stat.ino}` !== operation.directoryKey)
      throw new Error("The target folder changed. Choose the destination again.");
    return directory;
  }
  /** Counts destinations already taken by a file, before the user chooses how to handle them. */
  collectionConflicts(input: {
    libraryId: string;
    directoryId: string | null;
    items: Pick<ResourceCollectionItem, "assetId" | "name" | "folder">[];
  }): ResourceCollectionConflicts {
    if (input.libraryId !== this.libraryId)
      throw new Error("The target library changed. Choose the destination again.");
    const directory = input.directoryId === null ? "" : this.entry(input.directoryId).path;
    const result = { different: 0, identical: 0 };
    for (const item of input.items) {
      const rel = [directory, item.folder, item.name].filter(Boolean).join("/");
      const existing = this.entries.find(
        (entry) => entry.path === rel && entry.kind === "file" && !entry.deleted,
      );
      if (existing) result[existing.hash === item.assetId ? "identical" : "different"]++;
    }
    return result;
  }
  async prepareCollection(input: {
    id: string;
    libraryId: string;
    directoryId: string | null;
    items: Pick<ResourceCollectionItem, "resultId" | "assetId" | "name" | "folder" | "origin">[];
    onConflict?: ResourceCollectionConflict | undefined;
  }) {
    await this.listCollections();
    const existing = this.collections!.find((operation) => operation.id === input.id);
    if (existing) {
      if (
        existing.libraryId !== input.libraryId ||
        existing.directoryId !== input.directoryId ||
        (existing.onConflict ?? "keep-both") !== (input.onConflict ?? "keep-both") ||
        JSON.stringify(
          existing.items.map(({ resultId, assetId, name, folder, origin }) => ({
            resultId,
            assetId,
            name,
            ...(folder ? { folder } : {}),
            origin,
          })),
        ) !== JSON.stringify(input.items)
      )
        throw new Error("Collection request ID was reused with different content.");
      return structuredClone(existing);
    }
    this.assertWritable();
    if (input.libraryId !== this.libraryId)
      throw new Error("The target library changed. Choose the destination again.");
    const directory = input.directoryId === null ? "" : this.entry(input.directoryId).path;
    if (input.directoryId !== null && this.entry(input.directoryId).kind !== "directory")
      throw new Error("Choose a folder.");
    const stat = await fs.lstat(await this.resolve(directory));
    if (new Set(input.items.map((item) => item.resultId)).size !== input.items.length)
      throw new Error("Duplicate collection result.");
    for (const item of input.items) {
      safeName(item.name);
      if (item.folder !== undefined) folderSegments(item.folder);
      if (
        !(
          (item.origin.kind === "image-batch" &&
            item.origin.resultId === item.resultId &&
            item.origin.batchId &&
            item.origin.taskId &&
            item.origin.attemptId) ||
          (item.origin.kind === "model3d" &&
            item.origin.projectId &&
            item.origin.versionId &&
            item.resultId === item.origin.projectId + "_" + item.origin.versionId)
        )
      )
        throw new Error("Invalid collection source.");
    }
    const operation: ResourceCollectionOperation = {
      id: input.id,
      libraryId: input.libraryId,
      directoryId: input.directoryId,
      directoryKey: `${stat.dev}:${stat.ino}`,
      createdAt: new Date().toISOString(),
      ...(input.onConflict ? { onConflict: input.onConflict } : {}),
      items: input.items.map((item) => ({ ...item, status: "queued" })),
    };
    for (const previous of this.collections!)
      for (const item of previous.items)
        if (item.status === "failed" && input.items.some((next) => next.resultId === item.resultId))
          item.status = "superseded";
    this.collections!.push(operation);
    await this.persistCollections();
    return structuredClone(operation);
  }
  async commitCollection(
    operationId: string,
    resultId: string,
    bytes: Uint8Array,
    trash?: (file: string) => Promise<void>,
  ) {
    const operation = await this.collection(operationId),
      item = operation.items.find((item) => item.resultId === resultId);
    if (!item) throw new Error("Collection result is unavailable.");
    try {
      const target = await this.collectionTarget(operation);
      if (createHash("sha256").update(bytes).digest("hex") !== item.assetId)
        throw new Error("Original asset checksum does not match the result.");
      const prior = this.entries.find(
        (entry) =>
          (entry.origin?.kind === "image-batch" && entry.origin.resultId === resultId) ||
          (entry.origin?.kind === "model3d" &&
            entry.origin.projectId === item.origin.projectId &&
            entry.origin.versionId === item.origin.versionId),
      );
      const replace = operation.onConflict === "replace";
      // Replacing collects a removed result again instead of asking to restore the old copy.
      if (prior?.deleted && !replace)
        throw new Error(
          "This result was removed from the library. Restore it from the system trash first.",
        );
      if (prior && !prior.deleted) {
        const stat = await fs.lstat(await this.resolve(prior.path));
        if (
          stat.isSymbolicLink() ||
          `${stat.dev}:${stat.ino}` !== prior.fileKey ||
          (await hashFile(await this.resolve(prior.path))) !== item.assetId
        )
          throw new Error("The collected result changed. Refresh the library.");
        item.resourceId = prior.id;
        item.status = "committed";
        delete item.error;
        await this.persistCollections();
        return structuredClone(item);
      }
      const control = await this.controlRoot(),
        temp = path.join(control, `collect-${operation.id}-${resultId}.pending`);
      let destination = item.path ? await this.resolve(item.path, true) : null;
      let committed = false;
      if (destination && (await exists(destination))) {
        const stat = await fs.lstat(destination);
        committed =
          !stat.isSymbolicLink() &&
          `${stat.dev}:${stat.ino}` === item.fileKey &&
          (await hashFile(destination)) === item.assetId;
        // A replacement journaled before the old file reached the Trash replaces it again.
        if (!committed && !(item.replaced && replace))
          throw new Error("The collection destination changed. Choose the destination again.");
      }
      if (!committed) {
        const folder = await this.ensureFolder(target, item.folder);
        const exact = [folder, item.name].filter(Boolean).join("/");
        const taken = await fs.lstat(await this.resolve(exact, true)).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        await fs.rm(temp, { force: true });
        await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        const stat = await fs.lstat(temp);
        // Each result keeps its own entry and provenance, so even equal bytes from another result
        // replace the file (or are numbered) instead of being merged into the existing entry.
        const replacing = replace && !!taken?.isFile();
        if (replacing && !trash) throw new Error("System trash is unavailable.");
        item.path = replacing ? exact : (await this.available(folder, item.name)).path;
        item.fileKey = `${stat.dev}:${stat.ino}`;
        item.resourceId ??= randomUUID();
        item.status = "writing";
        if (replacing) item.replaced = true;
        // Journal the identity before committing the file. A lost receipt recovers this exact inode.
        await this.persistCollections();
        destination = await this.resolve(item.path, true);
        // The replaced file goes to the system Trash, so an overwrite can still be undone.
        if (replacing) await trash!(destination);
        await fs.link(temp, destination);
      }
      const stat = await fs.lstat(destination!);
      const recovered = this.entries.find((entry) => entry.path === item.path && !entry.deleted);
      // The entry of a replaced file stays as removed, so its own result reports the removal.
      const displaced =
        recovered && recovered.fileKey !== item.fileKey && item.replaced ? recovered : undefined;
      if (recovered && !displaced && recovered.fileKey !== item.fileKey)
        throw new Error("The collection destination changed. Choose the destination again.");
      const entry: ResourceEntry = {
        id: item.resourceId!,
        path: item.path!,
        name: path.posix.basename(item.path!),
        kind: "file",
        bytes: stat.size,
        modifiedAt: stat.mtimeMs,
        hash: item.assetId,
        fileKey: item.fileKey!,
        tags: recovered?.tags ?? [],
        notes: recovered?.notes ?? "",
        origin: item.origin,
      };
      await this.persist([
        ...this.entries
          .filter((existing) => existing.id !== entry.id && existing !== recovered)
          .concat(displaced ? [{ ...displaced, deleted: true }] : []),
        entry,
      ]);
      this.notify();
      item.status = "committed";
      delete item.error;
      await this.persistCollections();
      await fs.rm(temp, { force: true });
      return structuredClone(item);
    } catch (error) {
      item.status = "failed";
      item.error = message(error);
      await this.persistCollections();
      throw error;
    }
  }
  async linkCollection(operationId: string, resultId: string) {
    const operation = await this.collection(operationId),
      item = operation.items.find((item) => item.resultId === resultId);
    if (!item || !["committed", "linked"].includes(item.status))
      throw new Error("Copy has not been committed.");
    item.status = "linked";
    delete item.error;
    await this.persistCollections();
  }
  async failCollection(operationId: string, resultId: string, error: string) {
    const operation = await this.collection(operationId),
      item = operation.items.find((item) => item.resultId === resultId);
    if (!item || ["committed", "linked"].includes(item.status)) return;
    item.status = "failed";
    item.error = error;
    await this.persistCollections();
  }
  async retryCollection(operationId: string) {
    const operation = await this.collection(operationId);
    await this.collectionTarget(operation);
    for (const item of operation.items)
      if (item.status === "failed") {
        item.status = "queued";
        delete item.error;
      }
    await this.persistCollections();
    return structuredClone(operation);
  }
  async finishCollection(operationId: string) {
    const operation = await this.collection(operationId);
    if (!operation.items.every((item) => ["linked", "superseded"].includes(item.status)))
      throw new Error("Collection is still pending.");
    operation.released = true;
    await this.persistCollections();
  }
  private async copyOne(
    source: string | Uint8Array,
    target: string,
    name: string,
    origin?: ResourceOrigin,
  ) {
    this.assertWritable();
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
    this.assertWritable();
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
      if (this.error) {
        result.failed.push({ name: path.basename(source), path: source, error: this.error });
        continue;
      }
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
      ".glb": "model/gltf-binary",
      ".gltf": "model/gltf+json",
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
