import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResourceLibrary } from "./library";
import { ResourceIndex } from "./resourceIndex";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0)) await fn();
});
async function library() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-resource-v2-")));
  await fs.writeFile(path.join(root, "loose.txt"), "loose");
  const lib = new ResourceLibrary(path.join(root, ".aha-resources/config.json"));
  cleanup.push(async () => {
    lib.close();
    await lib.serial(async () => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  await lib.open(root);
  return lib;
}
it("opens a library with root files and manages them without a project", async () => {
  const lib = await library();
  const loose = lib.list({ path: "" }).entries[0]!;
  expect(loose.path).toBe("loose.txt");
  await lib.importBytes("", "another.txt", new TextEncoder().encode("another"));
  const project = await lib.createDirectory("", "Project");
  await lib.importBytes(project.path, "nested.txt", new TextEncoder().encode("nested"));
  const nested = lib.list({ path: "Project" }).entries[0]!;
  await expect(lib.prepareBatch("move", [nested.id])).rejects.toThrow("destination");
  const plan = await lib.prepareBatch("move", [nested.id], "");
  expect((await lib.executeBatch(plan.id)).items[0]?.status).toBe("succeeded");
  const rename = await lib.prepareBatch("rename", [loose.id], undefined, "renamed.txt");
  await lib.executeBatch(rename.id);
  expect(lib.entry(loose.id).path).toBe("renamed.txt");
  expect(lib.snapshot().count).toBe(3);
});
it("shares stable ordering between pages, counts and locating a resource", async () => {
  const lib = await library();
  await fs.mkdir(path.join(lib.root!, "Game/doctor"), { recursive: true });
  await fs.mkdir(path.join(lib.root!, "Game/Empty"));
  for (let i = 0; i < 201; i++)
    await fs.writeFile(path.join(lib.root!, `Game/doctor/${String(i).padStart(3, "0")}.txt`), "x");
  await lib.scan();
  const q = {
    path: "",
    kind: "file" as const,
    recursive: true,
    sort: "name" as const,
    query: "doctor",
    searchIn: "nameAndPath" as const,
  };
  const first = lib.list(q),
    second = lib.list({ ...q, offset: 100 }),
    last = lib.list({ ...q, offset: 200 });
  expect([first.entries.length, second.entries.length, last.entries.length]).toEqual([100, 100, 1]);
  expect(first.stats).toEqual({ scopeFiles: 202, matchedFiles: 201, matchedDirectories: 0 });
  expect(lib.list({ ...q, searchIn: undefined }).total).toBe(0);
  expect(
    new Set([...first.entries, ...second.entries, ...last.entries].map((e) => e.id)).size,
  ).toBe(201);
  const target = last.entries[0]!;
  expect((await lib.locate(target.id, "name")).offset).toBe(200);
  expect((await lib.locate(target.id, "name")).revision).toBe(first.revision);
  expect(lib.snapshot().directoryStats?.find((d) => d.path === "Game")).toMatchObject({
    directFiles: 0,
    directDirectories: 2,
    recursiveFiles: 201,
  });
  expect(lib.snapshot().directoryStats?.find((d) => d.path === "Game/Empty")?.recursiveFiles).toBe(
    0,
  );
});
it("retains the committed index during failed scans and blocks writes until recovery", async () => {
  const lib = await library();
  const before = lib.list({ path: "" });
  await fs.mkdir(path.join(lib.root!, "Blocked"));
  const resolve = lib.resolve.bind(lib);
  const mock = vi.spyOn(lib, "resolve").mockImplementation((relative, allowMissing) => {
    if (relative === "Blocked") return Promise.reject(new Error("Access denied"));
    return resolve(relative, allowMissing);
  });
  await expect(lib.scan()).rejects.toThrow("Access denied");
  expect(lib.list({ path: "" }).entries).toEqual(before.entries);
  expect(lib.snapshot().scan).toMatchObject({ phase: "failed", failedPath: "Blocked" });
  await expect(lib.importBytes("", "no.txt", new Uint8Array())).rejects.toThrow("not ready");
  mock.mockRestore();
  await lib.scan();
  expect(lib.snapshot().scan?.phase).toBe("ready");
});
it.each([100, 101, 200, 201])("covers every file at the %i-item page boundary", async (total) => {
  const lib = await library();
  await fs.mkdir(path.join(lib.root!, "Boundary"));
  await Promise.all(
    Array.from({ length: total }, (_, i) =>
      fs.writeFile(path.join(lib.root!, `Boundary/${String(i).padStart(3, "0")}.unknown`), "x"),
    ),
  );
  await lib.scan();
  const pages = Array.from({ length: Math.ceil(total / 100) }, (_, i) =>
    lib.list({ path: "Boundary", offset: i * 100, sort: "name" }),
  );
  expect(pages.map((p) => p.entries.length)).toEqual(
    total === 100 ? [100] : total === 101 ? [100, 1] : total === 200 ? [100, 100] : [100, 100, 1],
  );
  expect(pages.every((p) => p.total === total && p.stats?.matchedFiles === total)).toBe(true);
  expect(new Set(pages.flatMap((p) => p.entries.map((e) => e.id))).size).toBe(total);
});
it("does not publish partial metadata or permit more writes when index persistence fails", async () => {
  const lib = await library();
  const before = lib.list({ path: "" });
  const replace = vi.spyOn(ResourceIndex.prototype, "replace").mockImplementationOnce(() => {
    throw new Error("Index write failed");
  });
  await expect(lib.metadata([before.entries[0]!.id], ["new"])).rejects.toThrow(
    "Index write failed",
  );
  expect(lib.list({ path: "" })).toEqual(before);
  expect(lib.snapshot().scan).toMatchObject({
    phase: "failed",
    failedPath: ".aha-resources/library.json",
  });
  await expect(lib.createDirectory("", "no")).rejects.toThrow("not ready");
  replace.mockRestore();
  await lib.scan();
  expect(lib.snapshot().scan?.phase).toBe("ready");
});
it("rejects a locate request when its indexed file was removed externally", async () => {
  const lib = await library();
  const entry = lib.list({ path: "" }).entries[0]!;
  await fs.unlink(path.join(lib.root!, entry.path));
  await expect(lib.locate(entry.id, "name")).rejects.toThrow();
  expect(lib.list({ path: "" }).entries[0]?.id).toBe(entry.id);
});
it("keeps recursive scopes exact for non-BMP directory names and similarly prefixed siblings", async () => {
  const lib = await library();
  await fs.mkdir(path.join(lib.root!, "背景🎨/人物"), { recursive: true });
  await fs.mkdir(path.join(lib.root!, "背景🎨2"));
  await fs.writeFile(path.join(lib.root!, "背景🎨/人物/100%.txt"), "first");
  await fs.writeFile(path.join(lib.root!, "背景🎨2/sibling.txt"), "second");
  await lib.scan();
  const page = lib.list({
    path: "背景🎨",
    recursive: true,
    kind: "file",
    searchIn: "nameAndPath",
    query: "人物",
  });
  expect(page.entries.map((e) => e.path)).toEqual(["背景🎨/人物/100%.txt"]);
  expect(page.stats).toEqual({ scopeFiles: 1, matchedFiles: 1, matchedDirectories: 0 });
  expect(lib.list({ path: "背景🎨", recursive: true, kind: "file", query: "100%" }).total).toBe(1);
});
