import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { type SpriteProjectData } from "@synara/contracts/spriteLibrary";
import { SpriteLibrary } from "./library";
let temp: string, lib: SpriteLibrary;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-sprite-library-")));
  lib = new SpriteLibrary(path.join(temp, "Sprite"));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
async function fixture(id = "fox") {
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 4, background: "red" } })
    .png()
    .toBuffer();
  const file = `images/${createHash("sha256").update(bytes).digest("hex")}.png`;
  const project: SpriteProjectData = {
    version: 1,
    id,
    name: "狐狸",
    updatedAt: new Date().toISOString(),
    width: 16,
    height: 16,
    sources: [
      { id: "source", name: "fox.png", width: 32, height: 16, file, mimeType: "image/png" },
    ],
    actions: [
      {
        id: "idle",
        name: "idle",
        fps: 12,
        loop: true,
        frames: [
          {
            id: "frame",
            sourceId: "source",
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            offsetX: 0,
            offsetY: 0,
          },
        ],
      },
    ],
    selectedActionId: "idle",
    threadIds: ["thread-fox"],
    activeThreadId: "thread-fox",
    providerId: "",
    model: "",
    referenceSourceId: "source",
    background: "chroma",
    chromaKey: "#00ff00",
    generationFrameCount: 8,
    adoptedCandidateIds: [],
    provenance: [],
  };
  return { project, images: [{ file, bytes }], bytes, file };
}
describe("sprite filesystem persistence", () => {
  it("starts empty and restores editable metadata, pictures and thumbnails from disk alone", async () => {
    expect((await lib.list()).projects).toEqual([]);
    const f = await fixture();
    await lib.save(f.project, f.images, f.bytes);
    const reopened = new SpriteLibrary(lib.root);
    expect(await reopened.get("fox")).toEqual(f.project);
    expect(Buffer.from(await reopened.readImage("fox", f.file))).toEqual(f.bytes);
    expect((await reopened.list()).projects[0]).toMatchObject({
      name: "狐狸",
      actionCount: 1,
      deleting: false,
    });
    expect(
      (await sharp(await reopened.readImage("fox", "thumbnail.png")).metadata()).width,
    ).toBeLessThanOrEqual(128);
    await fs.cp(lib.root, path.join(temp, "Backup"), { recursive: true });
    expect(await new SpriteLibrary(path.join(temp, "Backup")).get("fox")).toEqual(f.project);
    await reopened.rename("fox", "骑士");
    expect((await reopened.get("fox")).name).toBe("骑士");
    expect(await fs.readdir(lib.root)).toContain("fox");
  });
  it("keeps committed metadata intact when a new image is invalid", async () => {
    const f = await fixture();
    await lib.save(f.project, f.images, null);
    await expect(
      lib.save(
        { ...f.project, name: "Broken" },
        [{ file: f.file, bytes: Buffer.from("bad image") }],
        null,
      ),
    ).rejects.toThrow("hash");
    expect((await lib.get("fox")).name).toBe("狐狸");
    expect(Buffer.from(await lib.readImage("fox", f.file))).toEqual(f.bytes);
  });
  it("reports corrupt metadata and refuses to overwrite it", async () => {
    const f = await fixture();
    await lib.save(f.project, f.images, null);
    await fs.writeFile(path.join(lib.root, "fox/project.json"), "corrupt");
    expect((await lib.list()).projects[0]?.error).toBeTruthy();
    await expect(lib.get("fox")).rejects.toThrow();
    await expect(lib.save(f.project, f.images, null)).rejects.toThrow();
    expect(await fs.readFile(path.join(lib.root, "fox/project.json"), "utf8")).toBe("corrupt");
  });
  it("rejects traversal, forged image paths and symlink escapes", async () => {
    const f = await fixture();
    await lib.save(f.project, f.images, null);
    await expect(lib.get("../outside")).rejects.toThrow();
    await expect(lib.readImage("fox", "../outside")).rejects.toThrow();
    await expect(
      lib.save(
        { ...f.project, sources: [{ ...f.project.sources[0]!, file: "../outside" }] },
        f.images,
        null,
      ),
    ).rejects.toThrow();
    await fs.rename(path.join(lib.root, "fox/images"), path.join(temp, "images"));
    await fs.symlink(path.join(temp, "images"), path.join(lib.root, "fox/images"));
    await expect(lib.readImage("fox", f.file)).rejects.toThrow("symbolic");
  });
  it("persists deletion intent, allows retry and rejects late saves after a restart", async () => {
    const f = await fixture();
    await lib.save(f.project, f.images, null);
    await lib.beginDelete("fox");
    const restarted = new SpriteLibrary(lib.root);
    expect((await restarted.list()).projects[0]?.deleting).toBe(true);
    await expect(restarted.save(f.project, f.images, null)).rejects.toThrow("deleted");
    await restarted.finishDelete("fox");
    await restarted.beginDelete("fox");
    await restarted.finishDelete("fox");
    expect((await restarted.list()).projects).toEqual([]);
    await expect(new SpriteLibrary(lib.root).save(f.project, f.images, null)).rejects.toThrow(
      "deleted",
    );
  });
  it("deleting one project preserves another project's identical image", async () => {
    const a = await fixture("a"),
      b = await fixture("b");
    await lib.save(a.project, a.images, null);
    await lib.save(b.project, b.images, null);
    await lib.beginDelete("a");
    await lib.finishDelete("a");
    expect((await lib.list()).projects.map((p) => p.id)).toEqual(["b"]);
    expect(Buffer.from(await lib.readImage("b", b.file))).toEqual(b.bytes);
  });
  it("rejects a corrupted picture instead of opening it as a blank source", async () => {
    const f = await fixture();
    await lib.save(f.project, f.images, null);
    await fs.writeFile(path.join(lib.root, "fox", f.file), "corrupt");
    await expect(lib.readImage("fox", f.file)).rejects.toThrow("hash mismatch");
  });
  it("reports an unavailable save directory without replacing existing data", async () => {
    const f = await fixture();
    await fs.writeFile(lib.root, "existing file");
    await expect(lib.list()).rejects.toThrow();
    await expect(lib.save(f.project, f.images, null)).rejects.toThrow();
    expect(await fs.readFile(lib.root, "utf8")).toBe("existing file");
  });
});

it("normalizes existing single-chat projects and persists multiple conversations", async () => {
  const f = await fixture();
  await lib.save(f.project, f.images, null);
  const { threadIds: _ids, activeThreadId: _active, ...rest } = f.project;
  await fs.writeFile(
    path.join(lib.root, "fox/project.json"),
    JSON.stringify({ ...rest, threadId: "legacy" }),
  );
  const old = await lib.get("fox");
  expect(old).toMatchObject({ threadIds: ["legacy"], activeThreadId: "legacy" });
  await lib.save({ ...old, threadIds: ["legacy", "second"], activeThreadId: "second" }, [], null);
  expect(await new SpriteLibrary(lib.root).get("fox")).toMatchObject({
    threadIds: ["legacy", "second"],
    activeThreadId: "second",
  });
});
it("reclaims a deleted source after committing metadata and can restore its bytes on undo", async () => {
  const f = await fixture();
  await lib.save(f.project, f.images, null);
  const empty = {
    ...f.project,
    sources: [],
    referenceSourceId: null,
    actions: f.project.actions.map((a) => ({ ...a, frames: [] })),
  };
  await lib.save(empty, [], null);
  await expect(fs.stat(path.join(lib.root, "fox", f.file))).rejects.toThrow();
  expect((await lib.get("fox")).actions[0]!.frames).toEqual([]);
  await lib.save(f.project, f.images, null);
  expect(Buffer.from(await lib.readImage("fox", f.file))).toEqual(f.bytes);
});
