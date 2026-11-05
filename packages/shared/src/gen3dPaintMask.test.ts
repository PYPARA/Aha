import { describe, expect, it } from "vitest";
import {
  createPaintGrid,
  decodePaintGrid,
  encodePaintGrid,
  paintGridCell,
  paintSphere,
  paintedCells,
  samplePaintGrid,
} from "./gen3dPaintMask";

describe("paint mask grid", () => {
  it("covers the bounds with cubic cells and padding", () => {
    const grid = createPaintGrid([-0.3, 0, -0.2], [0.3, 0.6, 0.2]);
    const cell = paintGridCell(grid);
    expect(cell).toBeCloseTo(0.6 / 128, 9);
    expect(grid.dims).toEqual([130, 130, 88]);
    expect(grid.min[0]).toBeLessThan(-0.3);
    expect(grid.max[1]).toBeGreaterThan(0.6);
    for (const i of [0, 1, 2])
      expect((grid.max[i]! - grid.min[i]!) / grid.dims[i]!).toBeCloseTo(cell, 9);
  });
  it("paints a sphere whose half-threshold edge sits near 85 % of the radius", () => {
    const grid = createPaintGrid([0, 0, 0], [1, 1, 1]);
    expect(paintSphere(grid, [0.5, 0.5, 0.5], 0.1)).toBe(true);
    expect(samplePaintGrid(grid, [0.5, 0.5, 0.5])).toBeCloseTo(1, 5);
    expect(samplePaintGrid(grid, [0.5 + 0.07, 0.5, 0.5])).toBeGreaterThan(0.9);
    expect(samplePaintGrid(grid, [0.5 + 0.08, 0.5, 0.5])).toBeGreaterThan(0.5);
    expect(samplePaintGrid(grid, [0.5 + 0.09, 0.5, 0.5])).toBeLessThan(0.5);
    expect(samplePaintGrid(grid, [0.7, 0.5, 0.5])).toBe(0);
    // Painting the same sphere again changes nothing; erasing clears it.
    expect(paintSphere(grid, [0.5, 0.5, 0.5], 0.1)).toBe(false);
    paintSphere(grid, [0.5, 0.5, 0.5], 0.12, true);
    expect(paintedCells(grid)).toBe(0);
  });
  it("round-trips through the run-length encoding", () => {
    const grid = createPaintGrid([0, 0, 0], [0.5, 1, 0.25]);
    paintSphere(grid, [0.2, 0.7, 0.1], 0.05);
    paintSphere(grid, [0.4, 0.2, 0.2], 0.08);
    const encoded = encodePaintGrid(grid);
    expect(encoded.data.length).toBeLessThan(20_000);
    const decoded = decodePaintGrid(JSON.parse(JSON.stringify(encoded)));
    expect(decoded.dims).toEqual(grid.dims);
    expect(Buffer.from(decoded.data).equals(Buffer.from(grid.data))).toBe(true);
  });
  it("rejects malformed grids", () => {
    const encoded = encodePaintGrid(createPaintGrid([0, 0, 0], [1, 1, 1]));
    expect(() => decodePaintGrid({ ...encoded, dims: [500, 1, 1] })).toThrow();
    expect(() => decodePaintGrid({ ...encoded, max: [2, 1, 1] })).toThrow(/cubes/);
    expect(() => decodePaintGrid({ ...encoded, data: btoa("\u0001\u0000") })).toThrow();
    expect(() => decodePaintGrid({ ...encoded, data: btoa("\u0000\u0000") })).toThrow();
  });
});
