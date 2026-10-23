import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResourceEntry } from "@synara/contracts/resourceLibrary";
import { ResourceLibrary, safeName, sameEntries } from "./library";
let directory: string;
const libraries: ResourceLibrary[] = [];
async function make(name = "library", onProgress?: (name: string, count: number) => void) {
  const root = path.join(directory, name);
  await fs.mkdir(root, { recursive: true });
  const library = new ResourceLibrary(
    path.join(directory, `${name}-config.json`),
    undefined,
    onProgress,
  );
  libraries.push(library);
  await library.open(root);
  return library;
}
const bytes = (value: string) => new TextEncoder().encode(value);
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-resources-test-")));
});
afterEach(async () => {
  for (const lib of libraries.splice(0)) {
    lib.close();
    await lib.serial(async () => {});
  }
  await fs.rm(directory, { recursive: true, force: true });
});
describe("resource library filesystem lifecycle", () => {
  it("stores independent copies and portable origin metadata", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.createDirectory("Game", "Characters");
    const source = path.join(directory, "hero.png");
    await fs.writeFile(source, "original");
    expect(
      (
        await lib.importPaths("Game/Characters", [source], {
          kind: "drawing",
          jobId: "job-1",
          prompt: "hero",
        })
      ).added,
    ).toBe(1);
    await fs.unlink(source);
    const asset = lib.list({ path: "Game/Characters" }).entries[0]!;
    expect(new TextDecoder().decode((await lib.read(asset.id)).bytes)).toBe("original");
    await lib.metadata([asset.id], ["hero", "pixel", "hero"], "Walk animation");
    await lib.createDirectory("", "Second");
    await lib.importPaths("Second", [path.join(lib.root!, asset.path)]);
    await fs.writeFile(path.join(lib.root!, "Second/hero.png"), "changed");
    expect(await fs.readFile(path.join(lib.root!, asset.path), "utf8")).toBe("original");
    lib.close();
    const copied = path.join(directory, "copy");
    await fs.cp(lib.root!, copied, { recursive: true });
    const reopened = new ResourceLibrary(path.join(directory, "copy-config.json"));
    libraries.push(reopened);
    await reopened.open(copied);
    const restored = reopened.entry(asset.id);
    expect(restored.tags).toEqual(["hero", "pixel"]);
    expect(restored.notes).toBe("Walk animation");
    expect(restored.origin?.jobId).toBe("job-1");
  });
  it("skips equal content and preserves different same-name files", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    expect((await lib.importBytes("Game", "hero.png", bytes("one"))).added).toBe(1);
    expect((await lib.importBytes("Game", "hero.png", bytes("one"))).skipped).toBe(1);
    expect((await lib.importBytes("Game", "hero.png", bytes("two"))).added).toBe(1);
    expect(lib.list({ path: "Game" }).entries.map((e) => e.name)).toEqual([
      "hero (1).png",
      "hero.png",
    ]);
    expect(await fs.readFile(path.join(lib.root!, "Game/hero.png"), "utf8")).toBe("one");
  });
  it("preserves identity and metadata through external rename and content edits", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.importBytes("Game", "hero.json", bytes("{}"));
    const before = lib.list({ path: "Game" }).entries[0]!;
    await lib.metadata([before.id], ["config"], "important");
    await fs.rename(
      path.join(lib.root!, "Game/hero.json"),
      path.join(lib.root!, "Game/actor.json"),
    );
    await fs.writeFile(path.join(lib.root!, "Game/actor.json"), '{ "frame": 3 }');
    await lib.scan();
    expect(lib.entry(before.id).path).toBe("Game/actor.json");
    expect(lib.entry(before.id).notes).toBe("important");
    expect(lib.entry(before.id).hash).not.toBe(before.hash);
  });
  it("updates nested paths after moving a directory across projects", async () => {
    const lib = await make();
    await lib.createDirectory("", "One");
    await lib.createDirectory("", "Two");
    const folder = await lib.createDirectory("One", "Frames");
    await lib.importBytes("One/Frames", "one.json", bytes("1"));
    const asset = lib.list({ path: "One/Frames" }).entries[0]!;
    await lib.relocate([folder.id, asset.id], "Two");
    expect(lib.entry(asset.id).path).toBe("Two/Frames/one.json");
    expect(await fs.readFile(path.join(lib.root!, "Two/Frames/one.json"), "utf8")).toBe("1");
    await expect(lib.relocate([folder.id], "Two/Frames")).rejects.toThrow("itself");
  });
  it("never permanently deletes when system trash fails; restores metadata after recovery", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.importBytes("Game", "hero.json", bytes("data"));
    const asset = lib.list({ path: "Game" }).entries[0]!;
    await lib.metadata([asset.id], ["restore"], "saved");
    await expect(
      lib.trash([asset.id], async () => {
        throw new Error("trash failed");
      }),
    ).rejects.toThrow("trash failed");
    expect(lib.entry(asset.id).path).toBe(asset.path);
    expect(await fs.readFile(path.join(lib.root!, asset.path), "utf8")).toBe("data");
    const trash = path.join(directory, "trash-file");
    await lib.trash([asset.id], (file) => fs.rename(file, trash));
    expect(lib.list({ path: "Game" }).total).toBe(0);
    await fs.rename(trash, path.join(lib.root!, asset.path));
    await lib.scan();
    expect(lib.entry(asset.id).tags).toEqual(["restore"]);
  });
  it("imports folder hierarchy, skips symbolic links and reports failures per item", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    const source = path.join(directory, "sprites");
    await fs.mkdir(path.join(source, "walk"), { recursive: true });
    await fs.writeFile(path.join(source, "walk/01.json"), "1");
    await fs.symlink(directory, path.join(source, "outside"));
    const result = await lib.importPaths("Game", [source, path.join(directory, "missing")]);
    expect(result.added).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(await fs.readFile(path.join(lib.root!, "Game/sprites/walk/01.json"), "utf8")).toBe("1");
    expect((await lib.importPaths("Game", [lib.root!])).failed[0]?.error).toMatch(/itself/);
  });
  it("cancels between files and keeps completed imports", async () => {
    let lib: ResourceLibrary;
    lib = await make("cancel", () => lib.cancelImport());
    await lib.createDirectory("", "Game");
    const sources = [path.join(directory, "a.txt"), path.join(directory, "b.txt")];
    for (const file of sources) await fs.writeFile(file, file);
    const result = await lib.importPaths("Game", sources);
    expect(result.cancelled).toBe(true);
    expect(result.added).toBe(1);
    expect(lib.list({ path: "Game" }).total).toBe(1);
  });
  it("rejects traversal, reserved names, directory symlinks and forged metadata", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    for (const name of ["../escape", "CON", "..", "a/b", ".aha-resources"])
      expect(() => safeName(name)).toThrow();
    await expect(lib.resolve("Game/../../outside", true)).rejects.toThrow();
    await fs.symlink(directory, path.join(lib.root!, "Game/link"));
    await expect(lib.importBytes("Game/link", "file.txt", bytes("x"))).rejects.toThrow("Symbolic");
    await lib.scan();
    expect(lib.list({ path: "Game" }).total).toBe(0);
    const bad = path.join(directory, "bad");
    await fs.mkdir(bad);
    await fs.symlink(directory, path.join(bad, ".aha-resources"));
    await expect(lib.open(bad)).rejects.toThrow("metadata");
    expect(lib.root).not.toBe(bad);
  });
  it("keeps the configured library and index when its disk disappears", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.importBytes("Game", "a.txt", bytes("a"));
    const original = lib.root!;
    lib.close();
    await fs.rename(original, original + "-offline");
    await expect(lib.scan()).rejects.toThrow();
    expect(lib.snapshot().count).toBe(1);
    expect(lib.snapshot().error).not.toBeNull();
    const reopened = new ResourceLibrary(lib.configFile);
    libraries.push(reopened);
    await reopened.load();
    expect(reopened.root).toBe(original);
    expect(reopened.error).not.toBeNull();
    await fs.rename(original + "-offline", original);
    await lib.scan();
    expect(lib.snapshot().count).toBe(1);
    expect(lib.error).toBeNull();
    await reopened.scan();
    expect(reopened.libraryId).toBe(lib.libraryId);
    expect(reopened.snapshot().count).toBe(1);
  });
  it("exports directories without overwriting files or exporting internal metadata", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    const folder = await lib.createDirectory("Game", "Frames");
    await lib.importBytes("Game/Frames", "01.txt", bytes("a"));
    const out = path.join(directory, "export");
    await fs.mkdir(out);
    await lib.export([folder.id], out);
    await lib.export([folder.id], out);
    expect(await fs.readFile(path.join(out, "Frames/01.txt"), "utf8")).toBe("a");
    expect(await fs.readFile(path.join(out, "Frames (1)/01.txt"), "utf8")).toBe("a");
    await expect(lib.export([folder.id], lib.root!)).rejects.toThrow("outside");
  });
  it("reacts to filesystem changes through the watcher", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await fs.writeFile(path.join(lib.root!, "Game/new.txt"), "new");
    await vi.waitFor(() => expect(lib.list({ path: "Game" }).total).toBe(1), { timeout: 6000 });
  });
  it("filters tags and file types, and batches renames with preserved extensions", async () => {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.importBytes("Game", "a.json", bytes("a"));
    await lib.importBytes("Game", "b.png", bytes("b"));
    const entries = lib.list({ path: "Game" }).entries;
    await lib.metadata(
      entries.map((e) => e.id),
      ["player"],
      "notes",
    );
    expect(lib.list({ path: "", recursive: true, tag: "player", type: "image" }).total).toBe(1);
    await lib.relocate(
      entries.map((e) => e.id),
      null,
      "frame",
    );
    expect(lib.list({ path: "Game" }).entries.map((e) => e.name)).toEqual([
      "frame-001.json",
      "frame-002.png",
    ]);
  });
  it("creates a default Resource library only when no configuration exists", async () => {
    const defaultRoot = path.join(directory, "Documents/Aha/Resource");
    const lib = new ResourceLibrary(path.join(directory, "default-config.json"));
    libraries.push(lib);
    await lib.load(defaultRoot);
    expect(lib.root).toBe(defaultRoot);
    expect(lib.libraryId).toBeTruthy();
    const custom = path.join(directory, "custom");
    await fs.mkdir(custom);
    await lib.open(custom);
    lib.close();
    const reopened = new ResourceLibrary(lib.configFile);
    libraries.push(reopened);
    await reopened.load(defaultRoot);
    expect(reopened.root).toBe(custom);
  });
  it("never replaces an unavailable chosen resource library with the default", async () => {
    const lib = await make();
    const original = lib.root!;
    lib.close();
    await fs.rename(original, original + "-offline");
    const defaultRoot = path.join(directory, "Documents/Aha/Resource");
    const reopened = new ResourceLibrary(lib.configFile);
    libraries.push(reopened);
    await reopened.load(defaultRoot);
    expect(reopened.root).toBe(original);
    expect(reopened.error).toBeTruthy();
    await expect(fs.stat(defaultRoot)).rejects.toThrow();
  });
  it("reports default-root creation failures and supports selecting a different root", async () => {
    const parentFile = path.join(directory, "blocked");
    await fs.writeFile(parentFile, "file");
    const lib = new ResourceLibrary(path.join(directory, "blocked-config.json"));
    libraries.push(lib);
    await lib.load(path.join(parentFile, "Resource"));
    expect(lib.error).toBeTruthy();
    const custom = path.join(directory, "recovered");
    await fs.mkdir(custom);
    await lib.open(custom);
    expect(lib.root).toBe(custom);
    expect(lib.error).toBeNull();
  });
});

describe("resource batch previews", () => {
  async function fixture() {
    const lib = await make();
    await lib.createDirectory("", "Game");
    await lib.createDirectory("Game", "Nested");
    await lib.importBytes("Game", "a.txt", bytes("a"));
    await lib.importBytes("Game/Nested", "b.txt", bytes("b"));
    return lib;
  }
  it("counts only files in aggregated queries, preserving mixed legacy queries", async () => {
    const lib = await fixture();
    expect(lib.list({ path: "Game", recursive: true, kind: "file" }).total).toBe(2);
    expect(lib.list({ path: "Game", recursive: true }).total).toBe(3);
    expect(lib.list({ path: "Game", kind: "directory" }).entries[0]?.name).toBe("Nested");
  });
  it("uses the same file predicate for SQLite totals and both sides of the 100-item page boundary", async () => {
    const lib = await fixture();
    await Promise.all(
      Array.from({ length: 105 }, async (_, index) => {
        await fs.writeFile(
          path.join(lib.root!, `Game/Nested/file-${String(index).padStart(3, "0")}.txt`),
          String(index),
        );
      }),
    );
    await lib.scan();
    const query = { path: "Game", recursive: true, kind: "file", sort: "name" } as const;
    const first = lib.list(query),
      second = lib.list({ ...query, offset: 100 });
    expect(first.total).toBe(107);
    expect(first.entries).toHaveLength(100);
    expect(second.entries).toHaveLength(7);
    expect(second.total).toBe(107);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(107);
    expect(lib.list({ ...query, query: "file-" }).total).toBe(105);
  });
  it("adds and removes tags without replacing unrelated per-file tags", async () => {
    const lib = await fixture();
    const [a, b] = lib.list({ path: "Game", recursive: true, kind: "file", sort: "name" }).entries;
    await lib.metadata([a!.id], ["a"]);
    await lib.metadata([b!.id], ["b"]);
    await lib.metadata([a!.id, b!.id], ["common"], undefined, "add");
    expect(lib.entry(a!.id).tags).toEqual(["a", "common"]);
    expect(lib.entry(b!.id).tags).toEqual(["b", "common"]);
    await lib.metadata([a!.id, b!.id], ["common"], undefined, "remove");
    expect(lib.entry(a!.id).tags).toEqual(["a"]);
    expect(lib.entry(b!.id).tags).toEqual(["b"]);
  });
  it("freezes numbering and destinations across partial failures and retries", async () => {
    const lib = await fixture();
    const entries = lib.list({ path: "Game", recursive: true, kind: "file", sort: "name" }).entries;
    const plan = await lib.prepareBatch(
      "rename",
      entries.map((entry) => entry.id),
      undefined,
      "frame",
    );
    expect(plan.items.map((item) => item.target)).toEqual([
      "Game/frame-001.txt",
      "Game/Nested/frame-002.txt",
    ]);
    await fs.writeFile(path.join(lib.root!, "Game/Nested/frame-002.txt"), "external");
    const first = await lib.executeBatch(plan.id);
    expect(first.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(await fs.readFile(path.join(lib.root!, "Game/Nested/frame-002.txt"), "utf8")).toBe(
      "external",
    );
    await fs.unlink(path.join(lib.root!, "Game/Nested/frame-002.txt"));
    const retry = await lib.executeBatch(plan.id, true);
    expect(retry.items.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    expect(lib.entry(entries[1]!.id).path).toBe("Game/Nested/frame-002.txt");
    expect((await lib.executeBatch(plan.id)).items).toEqual(retry.items);
  });
  it("rejects changed sources and expires older previews", async () => {
    const lib = await fixture();
    const entry = lib.list({ path: "Game", kind: "file" }).entries[0]!;
    const plan = await lib.prepareBatch("rename", [entry.id], undefined, "renamed.txt");
    await fs.writeFile(path.join(lib.root!, entry.path), "changed");
    expect((await lib.executeBatch(plan.id)).items[0]?.error).toContain(
      "changed after the preview",
    );
    await lib.prepareBatch("trash", [entry.id]);
    await expect(lib.executeBatch(plan.id)).rejects.toThrow("expired");
  });
  it("deduplicates child selections and rejects recursive directory moves", async () => {
    const lib = await fixture();
    const folder = lib.list({ path: "Game", kind: "directory" }).entries[0]!;
    const child = lib.list({ path: folder.path }).entries[0]!;
    const plan = await lib.prepareBatch("move", [folder.id, child.id], "Game/Nested");
    expect(plan.items.map((item) => item.status)).toEqual(["failed", "skipped"]);
  });
  it("moves directories with stable identities and exports without overwriting", async () => {
    const lib = await fixture();
    const folder = lib.list({ path: "Game", kind: "directory" }).entries[0]!;
    const child = lib.list({ path: folder.path }).entries[0]!;
    await lib.createDirectory("", "Second");
    const move = await lib.prepareBatch("move", [folder.id], "Second");
    expect((await lib.executeBatch(move.id)).items[0]?.status).toBe("succeeded");
    expect(lib.entry(child.id).path).toBe("Second/Nested/b.txt");
    const output = path.join(directory, "output");
    await fs.mkdir(output);
    const plan = await lib.prepareBatch("export", [child.id], output);
    await fs.writeFile(plan.items[0]!.target!, "occupied");
    expect((await lib.executeBatch(plan.id)).items[0]?.status).toBe("failed");
    expect(await fs.readFile(plan.items[0]!.target!, "utf8")).toBe("occupied");
  });
  it("stops after metadata persistence fails without replaying the completed filesystem move", async () => {
    const lib = await fixture();
    const entries = lib.list({ path: "Game", recursive: true, kind: "file", sort: "name" }).entries;
    const plan = await lib.prepareBatch(
      "rename",
      entries.map((entry) => entry.id),
      undefined,
      "frame",
    );
    const writable = lib as unknown as { persist: () => Promise<void> };
    const persist = writable.persist.bind(lib);
    let failed = false;
    const spy = vi.spyOn(writable, "persist").mockImplementation(async () => {
      if (!failed && lib.entry(entries[0]!.id).path === "Game/frame-001.txt") {
        failed = true;
        throw new Error("Manifest disk is full");
      }
      await persist();
    });
    const result = await lib.executeBatch(plan.id);
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(result.items[0]?.error).toContain("disk is full");
    expect(await fs.readFile(path.join(lib.root!, "Game/frame-001.txt"), "utf8")).toBe("a");
    expect(await fs.readFile(path.join(lib.root!, "Game/Nested/b.txt"), "utf8")).toBe("b");
    spy.mockRestore();
    const retried = await lib.executeBatch(plan.id, true);
    expect(retried.items.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    expect(lib.entry(entries[1]!.id).path).toBe("Game/Nested/frame-002.txt");
  });
  it("rejects a destination directory replaced after its preview", async () => {
    const lib = await fixture();
    const file = lib.list({ path: "Game", kind: "file" }).entries[0]!;
    await lib.createDirectory("", "Second");
    const plan = await lib.prepareBatch("move", [file.id], "Second");
    await fs.rename(path.join(lib.root!, "Second"), path.join(lib.root!, "OriginalSecond"));
    await fs.mkdir(path.join(lib.root!, "Second"));
    const result = await lib.executeBatch(plan.id);
    expect(result.items[0]?.status).toBe("failed");
    expect(result.items[0]?.error).toContain("changed after the preview");
    expect(await fs.readFile(path.join(lib.root!, file.path), "utf8")).toBe("a");
  });
});

describe("quiet rescans", () => {
  it("compares entries regardless of field and list order", () => {
    const a = {
      id: "a",
      path: "a.png",
      name: "a.png",
      kind: "file",
      bytes: 1,
      modifiedAt: 1,
      hash: "",
      fileKey: "1:1",
      tags: [],
      notes: "",
    } satisfies ResourceEntry;
    const b = { ...a, id: "b", path: "b.png", name: "b.png" };
    const { fileKey, hash, ...rest } = a;
    const reordered: ResourceEntry = { fileKey, hash, ...rest };
    expect(sameEntries([a, b], [b, reordered])).toBe(true);
    expect(sameEntries([a, b], [a, { ...b, notes: "changed" }])).toBe(false);
  });
  it("tells the renderer only about scans that changed something", async () => {
    const changed = vi.fn();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aha-quiet-scan-"));
    const lib = new ResourceLibrary(path.join(root, "config.json"), changed);
    await fs.mkdir(path.join(root, "library"));
    await lib.open(path.join(root, "library"));
    try {
      changed.mockClear();
      await lib.serial(() => lib.scan());
      expect(changed).not.toHaveBeenCalled();
      expect(lib.snapshot().scan?.phase).toBe("ready");
      await fs.writeFile(path.join(root, "library", "new.png"), "x");
      await lib.serial(() => lib.scan());
      expect(changed.mock.calls).toEqual([["library"]]);
      changed.mockClear();
      await lib.serial(() => lib.scan({ visible: true }));
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      lib.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
