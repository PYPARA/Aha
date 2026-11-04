import { describe, expect, it } from "vitest";
import {
  capsule,
  cappedCone,
  cylinder,
  ellipsoid,
  meshSdf,
  meshTopology,
  roundBox,
  smoothUnion,
  sphere,
  subtract,
  torus,
} from "./gen3dSdf";

const robot = () =>
  smoothUnion(
    0.02,
    smoothUnion(
      0.03,
      roundBox([0, 0.27, 0], [0.14, 0.105, 0.11], 0.07),
      ellipsoid([0, 0.45, 0], [0.13, 0.095, 0.11]),
      capsule([-0.06, 0.02, 0], [-0.06, 0.15, 0], 0.035),
      capsule([0.06, 0.02, 0], [0.06, 0.15, 0], 0.035),
    ),
    capsule([-0.17, 0.32, 0], [-0.2, 0.2, 0.01], 0.03),
    capsule([0.17, 0.32, 0], [0.2, 0.2, 0.01], 0.03),
    sphere([0, 0.605, 0], 0.022),
  );

describe("gen3dSdf", () => {
  it("returns exact distances for primitives", () => {
    expect(sphere([0, 0, 0], 1).f(2, 0, 0)).toBeCloseTo(1);
    expect(cylinder([0, 0, 0], [0, 1, 0], 0.5).f(0, 0.5, 0)).toBeCloseTo(-0.5);
    expect(cylinder([0, 0, 0], [0, 1, 0], 0.5).f(0, 2, 0)).toBeCloseTo(1);
    expect(cappedCone([0, 0, 0], [0, 1, 0], 0.5, 0).f(0, 0.5, 0)).toBeCloseTo(-0.2236, 3);
    expect(torus([0, 0, 0], 1, 0.25).f(1, 0, 0)).toBeCloseTo(-0.25);
    expect(subtract(sphere([0, 0, 0], 1), sphere([0, 0, 0], 0.5)).f(0, 0, 0)).toBeCloseTo(0.5);
  });

  it("prunes far primitives without changing nearby distances", () => {
    const shape = smoothUnion(0.05, sphere([0, 0, 0], 0.2), sphere([5, 0, 0], 0.2));
    const local = shape.prune([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5])!;
    expect(local.f(0.3, 0, 0)).toBeCloseTo(shape.f(0.3, 0, 0));
    expect(shape.prune([10, 10, 10, 11, 11, 11])).toBeNull();
  });

  it("meshes a closed, manifold surface at the requested scale", () => {
    const mesh = meshSdf(robot(), 96);
    expect(mesh.indices.length / 3).toBeGreaterThan(10_000);
    expect(meshTopology(mesh.indices)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 });
    let top = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) top = Math.max(top, mesh.positions[i]!);
    expect(top).toBeCloseTo(0.627, 1);
  });

  it("rejects invalid input", () => {
    expect(() => sphere([0, 0, 0], -1)).toThrow();
    expect(() => meshSdf(robot(), 1000)).toThrow();
    expect(() => smoothUnion(0)).toThrow();
  });
});
