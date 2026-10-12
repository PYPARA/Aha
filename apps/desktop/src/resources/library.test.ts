import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResourceLibrary, safeName } from "./library";
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
});
