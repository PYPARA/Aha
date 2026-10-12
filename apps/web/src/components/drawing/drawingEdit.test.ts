import { describe, expect, it } from "vitest";
import { calculateImageSize, normalizeImageSize } from "./imageSize";
import { drawingPoint, fitDrawingView, zoomDrawingAt } from "./drawingViewport";
import {
  moveElement,
  transformElement,
  resizeBounds,
  snapToAngle,
  type SketchElement,
} from "./imageSketch";
describe("drawing sizes and editing coordinates", () => {
  it("uses the reference project's exact tier presets", () => {
    expect(
      ["1K", "2K", "4K"].map((t) => calculateImageSize(t as "1K" | "2K" | "4K", "16:9")),
    ).toEqual(["1280x720", "2560x1440", "3840x2160"]);
    expect(calculateImageSize("4K", "1:1")).toBe("2880x2880");
    expect(calculateImageSize("1K", "3:2")).toBe("1536x1024");
    expect(calculateImageSize("2K", "6:4")).toBe("2160x1440");
    expect(calculateImageSize("1K", "invalid")).toBeNull();
    expect(calculateImageSize("1K", "10:1")).toBeNull();
  });
  it("normalizes custom dimensions within the documented limits", () => {
    for (const input of ["1x1", "1234x567", "99999x99999", "99999x1", "3840x3840"]) {
      const [w, h] = normalizeImageSize(input).split("x").map(Number) as [number, number];
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
      expect(Math.max(w / h, h / w)).toBeLessThanOrEqual(3);
      expect(w * h).toBeGreaterThanOrEqual(655360);
      expect(w * h).toBeLessThanOrEqual(8294400);
    }
  });
  it("keeps the image coordinate under the cursor fixed while zooming", () => {
    const view = fitDrawingView({ width: 4096, height: 2048 }, { width: 800, height: 500 });
    const point = { x: 250, y: 120 };
    const before = drawingPoint(view, point);
    const after = drawingPoint(zoomDrawingAt(view, point, view.scale * 3), point);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it("moves and scales erase records together with their object", () => {
    const object: SketchElement = {
      id: "a",
      type: "shape",
      shape: "rect",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
      color: "#000000",
      width: 4,
      erase: [{ width: 10, points: [{ x: 50, y: 50 }] }],
    };
    expect(moveElement(object, 10, 20).erase?.[0]?.points).toEqual([{ x: 60, y: 70 }]);
    expect(
      transformElement(
        object,
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 200, height: 100 },
        "e",
      ).erase?.[0]?.points,
    ).toEqual([{ x: 100, y: 50 }]);
    expect(
      resizeBounds({ x: 0, y: 0, width: 100, height: 50 }, "se", { x: 200, y: 70 }, 8, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(snapToAngle({ x: 0, y: 0 }, { x: 100, y: 10 }).y).toBeCloseTo(0);
  });
});
