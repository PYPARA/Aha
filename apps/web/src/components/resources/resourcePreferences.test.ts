import { afterEach, expect, it, vi } from "vitest";
import type { ResourceEntry } from "@synara/contracts/resourceLibrary";
import {
  readResourcePreferences,
  resolveResourceLocation,
  expandedResourceAncestors,
} from "./resourceNavigation";

afterEach(() => vi.unstubAllGlobals());
const directories = [
  { id: "project", path: "Game", kind: "directory" },
  { id: "nested", path: "Game/Nested", kind: "directory" },
] as ResourceEntry[];
it("migrates old project aggregates and retains old recursive directory preferences", () => {
  let value = {
    version: 1,
    location: { mode: "project", path: "Game", recursive: false },
    view: "list",
    sort: "name",
  };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(value) });
  expect(readResourcePreferences("test", directories)).toMatchObject({
    version: 2,
    location: { mode: "directory", directoryId: "project", path: "Game", recursive: true },
    view: "list",
    sort: "name",
    sidebarRem: 15,
  });
  value = { ...value, location: { mode: "directory", path: "Game/Nested", recursive: true } };
  expect(readResourcePreferences("test", directories).location).toMatchObject({
    directoryId: "nested",
    recursive: true,
  });
});
it("follows stable directory identity through renames and returns to valid ancestors after deletion", () => {
  const location = {
    mode: "directory" as const,
    path: "Game/Nested",
    directoryId: "nested",
    recursive: true,
  };
  expect(
    resolveResourceLocation(location, [
      ...directories.filter((d) => d.id !== "nested"),
      { ...directories[1]!, path: "Game/Renamed" },
    ]),
  ).toMatchObject({ path: "Game/Renamed", directoryId: "nested", recursive: true });
  expect(resolveResourceLocation(location, [directories[0]!])).toMatchObject({
    path: "Game",
    directoryId: "project",
    recursive: false,
  });
  expect(resolveResourceLocation(location, [])).toMatchObject({ path: "", directoryId: null });
  expect(expandedResourceAncestors(location.path, directories)).toEqual(["$root", "project"]);
});
it("restores per-library layout and expansion without restoring resource selection or session searches", () => {
  const values = new Map([
    [
      "aha:resources:one",
      JSON.stringify({
        version: 2,
        location: { mode: "directory", path: "Game", directoryId: "project", recursive: false },
        view: "list",
        sort: "name",
        expandedIds: ["$root", "project"],
        sidebarRem: 50,
        query: "do not restore",
        selection: ["a"],
      }),
    ],
  ]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
  const first = readResourcePreferences("one", directories);
  expect(first).toMatchObject({ sidebarRem: 20, expandedIds: ["$root", "project"] });
  expect(first).not.toHaveProperty("selection");
  expect(first).not.toHaveProperty("query");
  expect(readResourcePreferences("two", directories)).toMatchObject({
    location: { mode: "all" },
    sidebarRem: 15,
    view: "grid",
  });
});
