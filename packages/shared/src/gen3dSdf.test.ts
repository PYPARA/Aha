import { describe, expect, it } from "vitest";
import {
  capsule,
  cappedCone,
  cylinder,
  ellipsoid,
  meshSdf,
  meshTopology,
  roundBox,
  roundCone,
  skeleton,
  smoothUnion,
  sphere,
  subtract,
  torus,
  validateSkeleton,
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

  it("measures round cones exactly at both ends and along the side", () => {
    const cone = roundCone([0, 0, 0], [0, 1, 0], 0.3, 0.1);
    expect(cone.f(0, -0.5, 0)).toBeCloseTo(0.2);
    expect(cone.f(0, 1.5, 0)).toBeCloseTo(0.4);
    expect(cone.f(0, 0.5, 0)).toBeLessThan(0);
    // The larger end sphere swallows the smaller one.
    expect(roundCone([0, 0, 0], [0, 0.1, 0], 0.5, 0.1).f(1, 0, 0)).toBeCloseTo(0.5);
  });

  it("grows a closed body along a skeleton graph", () => {
    const nodes = [
      { id: "hips", parent: null, position: [0, 0.5, 0] as const, radius: 0.12 },
      { id: "head", parent: "hips", position: [0, 0.95, 0] as const, radius: 0.1 },
      { id: "leg-l", parent: "hips", position: [-0.1, 0.05, 0] as const, radius: 0.05 },
      { id: "leg-r", parent: "hips", position: [0.1, 0.05, 0] as const, radius: 0.05 },
    ];
    const body = skeleton(nodes);
    expect(body.f(0, 0.95, 0)).toBeLessThan(0);
    expect(body.f(-0.1, 0.05, 0)).toBeLessThan(0);
    expect(body.f(0.5, 0.5, 0)).toBeGreaterThan(0);
    const mesh = meshSdf(body, 64);
    expect(meshTopology(mesh.indices)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 });
    // A single node is a sphere.
    expect(
      skeleton([{ id: "a", parent: null, position: [0, 0, 0], radius: 1 }]).f(2, 0, 0),
    ).toBeCloseTo(1);
  });

  it("rejects skeletons that cannot be grown or rigged", () => {
    const node = (id: string, parent: string | null) => ({
      id,
      parent,
      position: [0, 0, 0] as const,
      radius: 0.1,
    });
    expect(() => validateSkeleton([])).toThrow(/at least one/);
    expect(() => validateSkeleton([node("a", null), node("a", null)])).toThrow(/duplicated/);
    expect(() => validateSkeleton([node("a", "x")])).toThrow(/missing parent/);
    expect(() => validateSkeleton([node("a", "b"), node("b", "a")])).toThrow(/cycle/);
    expect(() => validateSkeleton([{ ...node("a", null), radius: 0 }])).toThrow(/positive/);
  });

  it("rejects invalid input", () => {
    expect(() => sphere([0, 0, 0], -1)).toThrow();
    expect(() => meshSdf(robot(), 1000)).toThrow();
    expect(() => smoothUnion(0)).toThrow();
  });
});
