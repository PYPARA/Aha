import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ResourceCollectionItem } from "@synara/contracts/resourceLibrary";
import { ResourceLibrary } from "./library";
let directory: string;
const libs: ResourceLibrary[] = [];
const bytes = new TextEncoder().encode("independent generated original");
const assetId = createHash("sha256").update(bytes).digest("hex");
const source = (
  id = "result",
): Pick<ResourceCollectionItem, "resultId" | "assetId" | "name" | "folder" | "origin"> => ({
  resultId: id,
  assetId,
  name: "image.png",
  origin: {
    kind: "image-batch",
    batchId: "batch",
    taskId: "task",
    attemptId: "attempt",
    resultId: id,
  },
});
async function open() {
  const lib = new ResourceLibrary(path.join(directory, "config.json"));
  libs.push(lib);
  await fs.mkdir(path.join(directory, "library"), { recursive: true });
  await lib.open(path.join(directory, "library"));
  return lib;
}
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-collection-test-")));
});
afterEach(async () => {
  for (const lib of libs.splice(0)) {
    lib.close();
    await lib.serial(async () => {});
  }
  await fs.rm(directory, { recursive: true, force: true });
});
it("persists operation receipts across reload, deduplicates by result identity and retains portable provenance", async () => {
  const lib = await open();
  const folder = await lib.createDirectory("", "Chosen");
  const op = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: folder.id,
    items: [source()],
  });
  const item = await lib.commitCollection(op.id, "result", bytes);
  expect(item.status).toBe("committed");
  lib.close();
  const restored = await open();
  expect((await restored.listCollections())[0]!.items[0]!.resourceId).toBe(item.resourceId);
  await restored.relocate([item.resourceId!], null, "renamed.png");
  const repeat = await restored.prepareCollection({
    id: randomUUID(),
    libraryId: restored.libraryId!,
    directoryId: null,
    items: [source()],
  });
  expect((await restored.commitCollection(repeat.id, "result", bytes)).resourceId).toBe(
    item.resourceId,
  );
  expect(restored.list({ path: "", recursive: true }).total).toBe(2);
  await restored.linkCollection(repeat.id, "result");
  expect(restored.entry(item.resourceId!).origin).toEqual(source().origin);
  await restored.trash([item.resourceId!], (file) => fs.rm(file));
  expect((await restored.resourceState(restored.libraryId!, item.resourceId!)).status).toBe(
    "removed",
  );
  await expect(restored.commitCollection(repeat.id, "result", bytes)).rejects.toThrow("removed");
});
it("recovers a committed file after metadata or index failure without copying again", async () => {
  const lib = await open();
  const op = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: null,
    items: [source()],
  });
  const spy = vi
    .spyOn(lib as unknown as { persist: (...args: unknown[]) => Promise<void> }, "persist")
    .mockRejectedValueOnce(new Error("index failed"));
  await expect(lib.commitCollection(op.id, "result", bytes)).rejects.toThrow("index failed");
  spy.mockRestore();
  const files = (await fs.readdir(lib.root!)).filter((name) => name !== ".aha-resources");
  expect(files).toEqual(["image.png"]);
  const before = await fs.stat(path.join(lib.root!, "image.png"));
  lib.close();
  const restored = await open();
  await restored.retryCollection(op.id);
  const result = await restored.commitCollection(op.id, "result", bytes);
  expect(result.status).toBe("committed");
  expect((await fs.stat(path.join(restored.root!, "image.png"))).ino).toBe(before.ino);
  expect(restored.list({ path: "" }).entries).toHaveLength(1);
});
it("keeps identical bytes from separate result IDs separate, validates checksum, and pins the destination identity", async () => {
  const lib = await open();
  const folder = await lib.createDirectory("", "Target");
  const op = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: folder.id,
    items: [source("one"), source("two")],
  });
  await expect(lib.commitCollection(op.id, "one", new Uint8Array([0]))).rejects.toThrow("checksum");
  await lib.retryCollection(op.id);
  await lib.commitCollection(op.id, "one", bytes);
  await lib.commitCollection(op.id, "two", bytes);
  const entries = lib.list({ path: "Target", originKind: "image-batch" });
  expect(entries.total).toBe(2);
  expect(new Set(entries.entries.map((entry) => entry.id)).size).toBe(2);
  await lib.trash([folder.id], (file) => fs.rm(file, { recursive: true }));
  await lib.createDirectory("", "Target");
  await expect(lib.commitCollection(op.id, "two", bytes)).rejects.toThrow(
    /no longer exists|target folder changed/,
  );
});

it("retains 3D version provenance and recovers copies using the same durable receipts", async () => {
  const lib = await open();
  const item = {
    resultId: "project_version",
    assetId,
    name: "prop.glb",
    origin: { kind: "model3d" as const, projectId: "project", versionId: "version" },
  };
  const operation = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: null,
    items: [item],
  });
  const committed = await lib.commitCollection(operation.id, item.resultId, bytes);
  await lib.linkCollection(operation.id, item.resultId);
  await lib.finishCollection(operation.id);
  lib.close();
  const restored = await open();
  const entry = restored.entry(committed.resourceId!);
  expect(entry.origin).toEqual(item.origin);
  expect(
    restored.list({ path: "", type: "model3d", originKind: "model3d" }).entries.map((e) => e.id),
  ).toContain(entry.id);
  const repeat = await restored.prepareCollection({
    id: randomUUID(),
    libraryId: restored.libraryId!,
    directoryId: null,
    items: [item],
  });
  expect((await restored.commitCollection(repeat.id, item.resultId, bytes)).resourceId).toBe(
    entry.id,
  );
});
it("creates and indexes output subfolders, reuses them and rejects escaping folders", async () => {
  const lib = await open();
  const chosen = await lib.createDirectory("", "Delivery");
  const op = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: chosen.id,
    items: [
      { ...source("ember"), name: "ember.png", folder: "heroes" },
      { ...source("blade"), name: "blade.png", folder: "icons/weapons" },
    ],
  });
  expect((await lib.commitCollection(op.id, "ember", bytes)).path).toBe(
    "Delivery/heroes/ember.png",
  );
  expect((await lib.commitCollection(op.id, "blade", bytes)).path).toBe(
    "Delivery/icons/weapons/blade.png",
  );
  expect(await fs.readFile(path.join(directory, "library/Delivery/heroes/ember.png"))).toEqual(
    Buffer.from(bytes),
  );
  const folders = lib
    .list({ path: "", recursive: true })
    .entries.filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path);
  expect(folders).toEqual(
    expect.arrayContaining(["Delivery/heroes", "Delivery/icons", "Delivery/icons/weapons"]),
  );
  const again = await lib.prepareCollection({
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: chosen.id,
    items: [{ ...source("ember-2"), name: "ember-2.png", folder: "heroes" }],
  });
  expect((await lib.commitCollection(again.id, "ember-2", bytes)).path).toBe(
    "Delivery/heroes/ember-2.png",
  );
  for (const folder of ["../outside", "a//b", "heroes/.", "/abs"])
    await expect(
      lib.prepareCollection({
        id: randomUUID(),
        libraryId: lib.libraryId!,
        directoryId: chosen.id,
        items: [{ ...source("bad"), folder }],
      }),
    ).rejects.toThrow("Invalid");
});

it("replaces a same-named file with different content by default choice, or keeps both", async () => {
  const lib = await open();
  const folder = await lib.createDirectory("", "Delivery");
  const collect = async (id: string, content: Uint8Array, onConflict?: "replace" | "keep-both") => {
    const asset = createHash("sha256").update(content).digest("hex");
    const op = await lib.prepareCollection({
      id: randomUUID(),
      libraryId: lib.libraryId!,
      directoryId: folder.id,
      items: [{ ...source(id), assetId: asset, folder: "heroes" }],
      ...(onConflict ? { onConflict } : {}),
    });
    return lib.commitCollection(op.id, id, content, trash);
  };
  const trashed: string[] = [];
  const trash = vi.fn(async (file: string) => {
    trashed.push(await fs.readFile(file, "utf8"));
    await fs.rm(file);
  });
  const first = await collect("first", bytes);
  await lib.metadata([first.resourceId!], ["hero"], "keep me");
  const next = new TextEncoder().encode("regenerated original");
  expect(
    lib.collectionConflicts({
      libraryId: lib.libraryId!,
      directoryId: folder.id,
      items: [
        {
          assetId: createHash("sha256").update(next).digest("hex"),
          name: "image.png",
          folder: "heroes",
        },
        { assetId, name: "image.png", folder: "heroes" },
        { assetId, name: "other.png", folder: "heroes" },
      ],
    }),
  ).toEqual({ different: 1, identical: 1 });

  const replaced = await collect("second", next, "replace");
  expect(replaced).toMatchObject({ path: "Delivery/heroes/image.png", replaced: true });
  expect(trashed).toEqual([new TextDecoder().decode(bytes)]);
  expect(await fs.readFile(path.join(directory, "library/Delivery/heroes/image.png"), "utf8")).toBe(
    "regenerated original",
  );
  const entry = lib.entry(replaced.resourceId!);
  expect(entry).toMatchObject({ tags: ["hero"], notes: "keep me" });
  expect(entry.origin?.resultId).toBe("second");
  expect((await lib.resourceState(lib.libraryId!, first.resourceId!)).status).toBe("removed");

  const kept = await collect("third", new TextEncoder().encode("third original"), "keep-both");
  expect(kept.path).toBe("Delivery/heroes/image (1).png");
  expect(trash).toHaveBeenCalledTimes(1);
});

it("does not reuse a request ID with a different same-name choice", async () => {
  const lib = await open();
  const request = {
    id: randomUUID(),
    libraryId: lib.libraryId!,
    directoryId: null,
    items: [source()],
  };
  await lib.prepareCollection({ ...request, onConflict: "replace" });
  await expect(lib.prepareCollection({ ...request, onConflict: "keep-both" })).rejects.toThrow(
    "reused",
  );
});
