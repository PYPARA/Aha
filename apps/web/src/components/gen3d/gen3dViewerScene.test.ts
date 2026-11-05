import { describe, expect, it } from "vitest";
import { frameColumnRow, heat, overlayFrame, weightColors } from "./gen3dViewerScene";

// The score's convention (gen3dScore / process.py): bx = 128 + (u - cu) * ppm; x = mirrored ?
// 256 - bx + dx : bx + dx; y = GROUND - (v - y0) * ppm, with GROUND = 243 and y0 = 0.
const score = (u: number, v: number, cu: number, ppm: number, dx: number, mirrored: boolean) => {
  const bx = 128 + (u - cu) * ppm;
  return { column: (mirrored ? 256 - bx : bx) + dx, row: 243 - v * ppm };
};
const bounds = { min: [-0.2, 0, -0.1], max: [0.3, 0.8, 0.2] };

describe("overlayFrame", () => {
  for (const mirrored of [false, true])
    it(`matches the score registration (${mirrored ? "mirrored" : "direct"})`, () => {
      const ppm = 250,
        dx = 7;
      for (const view of ["front", "side", "back"] as const) {
        const frame = overlayFrame(view, bounds, ppm, { shiftPx: dx, mirrored });
        const [uMin, uMax] =
          view === "front" ? [-0.2, 0.3] : view === "back" ? [-0.3, 0.2] : [-0.2, 0.1];
        const cu = (uMin + uMax) / 2;
        for (const p of [
          [0.1, 0.5, 0.05],
          [-0.2, 0, -0.1],
          [0.3, 0.8, 0.2],
        ]) {
          const u = view === "front" ? p[0]! : view === "back" ? -p[0]! : -p[2]!;
          const expected = score(u, p[1]!, cu, ppm, dx, mirrored);
          const got = frameColumnRow(view, frame, p);
          expect(got.column).toBeCloseTo(expected.column, 6);
          expect(got.row).toBeCloseTo(expected.row, 6);
        }
      }
    });
});

describe("weights", () => {
  it("colours by the summed weight of one bone", () => {
    const colors = weightColors([2, 0, 0, 0, 1, 2, 0, 0], [1, 0, 0, 0, 0.5, 0.5, 0, 0], 2);
    expect(Array.from(colors.slice(0, 3))).toEqual(heat(1));
    expect(Array.from(colors.slice(3, 6))).toEqual(heat(0.5));
    expect(heat(0)).toEqual([0, 0, 1]);
  });
});
