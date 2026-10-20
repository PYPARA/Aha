import { describe, expect, it } from "vitest";
import {
  emptyResourceSelection,
  selectResource,
  reconcileResourceSelection,
  resourceRectsIntersect,
} from "./resourceSelection";
import { resourceQuery, resolveResourceLocation } from "./resourceNavigation";
import { drawingResourceError } from "@synara/contracts/resourceLibrary";
const order = ["a", "b", "c", "d"];
describe("resource selection semantics", () => {
  it("replaces ordinary clicks and keeps an already selected item selected", () => {
    const a = selectResource(emptyResourceSelection(), "a", order);
    const b = selectResource(a, "b", order);
    expect(b.ids).toEqual(["b"]);
    expect(selectResource(b, "b", order).ids).toEqual(["b"]);
  });
  it("adds, removes and extends ranges in display order", () => {
    const a = selectResource(emptyResourceSelection(), "a", order);
    const d = selectResource(a, "d", order, { metaKey: true });
    expect(d.ids).toEqual(["a", "d"]);
    expect(selectResource(d, "d", order, { ctrlKey: true }).ids).toEqual(["a"]);
    expect(selectResource(a, "c", order, { shiftKey: true }).ids).toEqual(["a", "b", "c"]);
    expect(selectResource(d, "c", order, { shiftKey: true, metaKey: true }).ids).toEqual([
      "a",
      "d",
      "c",
    ]);
  });
  it("toggles only in explicit multiple mode and prunes stale identities", () => {
    const a = selectResource(emptyResourceSelection(), "a", order);
    expect(selectResource(a, "b", order, {}, true).ids).toEqual(["a", "b"]);
    expect(reconcileResourceSelection(a, ["b"]).ids).toEqual([]);
    expect(reconcileResourceSelection(a, ["b"]).anchorId).toBeNull();
  });
  it("uses rectangle intersection, excluding touching edges", () => {
    const a = { left: 0, right: 100, top: 0, bottom: 100 };
    expect(resourceRectsIntersect(a, { left: 99, right: 120, top: 99, bottom: 120 })).toBe(true);
    expect(resourceRectsIntersect(a, { left: 100, right: 120, top: 0, bottom: 100 })).toBe(false);
  });
});
describe("resource browsing ranges", () => {
  it("aggregates only files without changing scope when filtering", () => {
    expect(
      resourceQuery(
        { mode: "directory", path: "Game", recursive: true },
        "hero",
        "",
        "all",
        "name",
        100,
      ),
    ).toMatchObject({ path: "Game", kind: "file", recursive: true, offset: 100 });
    expect(
      resourceQuery(
        { mode: "directory", path: "Game", recursive: false },
        "hero",
        "",
        "all",
        "name",
        0,
      ),
    ).toMatchObject({ path: "Game", recursive: false });
    expect(
      resourceQuery({ mode: "recent", path: "", recursive: false }, "", "", "all", "name", 0).sort,
    ).toBe("modified");
  });
  it("falls back from a missing location without inventing a new project", () => {
    expect(
      resolveResourceLocation({ mode: "directory", path: "missing/child", recursive: false }, []),
    ).toMatchObject({ mode: "directory", path: "", directoryId: null });
  });
  it("checks drawing occupancy as well as type and per-file size", () => {
    expect(drawingResourceError({ type: "image/png", size: 1 }, { count: 16, bytes: 0 })).toContain(
      "16 images",
    );
    expect(
      drawingResourceError({ type: "image/png", size: 1 }, { count: 0, bytes: 80 * 1024 * 1024 }),
    ).toContain("80 MiB");
    expect(
      drawingResourceError({ type: "application/pdf", size: 1 }, { count: 0, bytes: 0 }),
    ).toContain("PNG");
  });
});
