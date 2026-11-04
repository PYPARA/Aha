import { describe, expect, it } from "vitest";
import { capsule, ellipsoid, meshSdf, roundBox, smoothUnion, sphere } from "./gen3dSdf";
import {
  BLUEPRINT_SIZE,
  compareSilhouettes,
  extractBlueprint,
  rasterSilhouette,
  registerSilhouette,
  silhouetteScore,
} from "./gen3dScore";

const robot = (wrong = false) =>
  smoothUnion(
    0.02,
    roundBox([0, 0.27, 0], [0.14, 0.105, 0.11], 0.07),
    ellipsoid([0, 0.45, 0], [0.13, 0.095, 0.11]),
    capsule([-0.06, 0.02, 0], [-0.06, 0.15, 0], 0.035),
    capsule([0.06, 0.02, 0], [0.06, 0.15, 0], 0.035),
    capsule([-0.17, 0.32, 0], [-0.2, 0.2, 0.01], wrong ? 0.042 : 0.03),
    capsule([0.17, 0.32, 0], [0.2, 0.2, 0.01], wrong ? 0.042 : 0.03),
    ...(wrong ? [ellipsoid([0, 0.29, -0.1], [0.09, 0.08, 0.06])] : []),
    sphere([0, 0.6, 0], 0.025),
  );
const SCALE = (BLUEPRINT_SIZE * 0.9) / 0.625;
const views = ["front", "side", "back"] as const;

describe("gen3dScore", () => {
  const reference = meshSdf(robot(), 96);
  const refMasks = views.map((v) =>
    rasterSilhouette(reference.positions, reference.indices, v, SCALE),
  );

  it("scores an identical model as a perfect match", () => {
    const comparisons = views.map((v, i) =>
      compareSilhouettes(
        rasterSilhouette(reference.positions, reference.indices, v, SCALE),
        refMasks[i]!,
      ),
    );
    expect(silhouetteScore(comparisons)).toBe(100);
    expect(comparisons.every((c) => c.regions.length === 0)).toBe(true);
  });

  it("locates planted deviations after registration", () => {
    const candidate = meshSdf(robot(true), 96);
    const comparisons = views.map((v, i) => {
      const reg = registerSilhouette(
        rasterSilhouette(candidate.positions, candidate.indices, v, SCALE),
        refMasks[i]!,
        v === "side",
      );
      return compareSilhouettes(reg.mask, refMasks[i]!);
    });
    expect(silhouetteScore(comparisons)).toBeLessThan(100);
    expect(comparisons[0]!.regions.filter((r) => r.kind === "extra").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(comparisons[1]!.regions[0]).toMatchObject({ kind: "extra" });
    expect(comparisons[1]!.regions[0]!.pct).toBeGreaterThan(4);
  });

  it("matches a mirrored side view", () => {
    const side = refMasks[1]!;
    const mirrored = new Uint8Array(side.length);
    for (let y = 0; y < BLUEPRINT_SIZE; y++)
      for (let x = 0; x < BLUEPRINT_SIZE; x++)
        mirrored[x + y * BLUEPRINT_SIZE] = side[BLUEPRINT_SIZE - 1 - x + y * BLUEPRINT_SIZE]!;
    const reg = registerSilhouette(mirrored, side, true);
    expect(reg.mirrored).toBe(true);
    expect(reg.iou).toBeGreaterThan(0.95);
  });

  it("splits a three-view sheet into masks on a shared scale", () => {
    const width = 300,
      height = 120,
      rgb = new Uint8Array(width * height * 3).fill(255);
    const fill = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) rgb.fill(40, (x + y * width) * 3, (x + y * width) * 3 + 3);
    };
    fill(20, 80, 20, 100);
    fill(130, 160, 20, 100);
    fill(210, 270, 40, 100);
    const sheet = extractBlueprint(rgb, width, height);
    expect(sheet.boxes.front).toEqual({ x0: 20, x1: 80, y0: 20, y1: 100 });
    expect(sheet.boxes.back.y0).toBe(40);
    expect(sheet.masks.side.reduce((s, v) => s + v, 0)).toBeLessThan(
      sheet.masks.front.reduce((s, v) => s + v, 0),
    );
    expect(() =>
      extractBlueprint(new Uint8Array(width * height * 3).fill(255), width, height),
    ).toThrow();
  });
});
