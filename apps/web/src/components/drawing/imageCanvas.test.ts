import { describe, expect, it } from "vitest";
import { imagePoint, selectionToMask } from "./imageCanvas";
import { normalizeRailItemOrder, railItemForPathname, railItemShowsPanel } from "~/appRail.logic";
describe("drawing coordinates and API mask semantics", () => {
  it("uses image coordinates regardless of displayed scale/high DPI", () => {
    expect(
      imagePoint(
        { x: 150, y: 100 },
        { left: 50, top: 50, width: 200, height: 100 },
        { width: 1600, height: 800 },
      ),
    ).toEqual({ x: 800, y: 400 });
    expect(
      imagePoint(
        { x: 250, y: 150 },
        { left: 50, top: 50, width: 400, height: 200 },
        { width: 1600, height: 800 },
      ),
    ).toEqual({ x: 800, y: 400 });
  });
  it("makes painted pixels transparent and preserves unpainted pixels; reopens the same mask", () => {
    const selection = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 128]);
    const mask = selectionToMask(selection);
    expect([...mask]).toEqual([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 127]);
    expect([...selectionToMask(mask)].filter((_, i) => i % 4 === 3)).toEqual([255, 0, 128]);
  });
  it("adds Drawing after Home to a saved rail layout and uses a full-width route", () => {
    expect(normalizeRailItemOrder(["home", "spaces", "inbox"]).slice(0, 2)).toEqual([
      "home",
      "drawing",
    ]);
    expect(railItemForPathname("/drawing")).toBe("drawing");
    expect(railItemShowsPanel("drawing")).toBe(false);
  });
});
