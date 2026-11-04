import { describe, expect, it } from "vitest";
import { modelingAncestor, rigSkeleton, skeletonSource, versionChain } from "./gen3dVersions";

const v = (id: string, parentVersionId: string | null, mode?: string, skeleton?: unknown[]) => ({
  id,
  build: { parentVersionId, ...(mode ? { mode } : {}), ...(skeleton ? { skeleton } : {}) },
});

describe("gen3dVersions", () => {
  const versions = [
    v("a", null, "blender", [{}]),
    v("b", "a", "threejs"),
    v("c", "b", "process"),
    v("d", "c", "process"),
  ];
  it("walks optimized and repainted steps back to the modeled version", () => {
    expect(versionChain(versions, versions[3]!).map((x) => x.id)).toEqual(["d", "c", "b", "a"]);
    expect(modelingAncestor(versions, versions[3]!)?.id).toBe("b");
    expect(skeletonSource(versions, versions[3]!)?.id).toBe("a");
    expect(skeletonSource(versions, versions[1]!)?.id).toBe("a");
  });
  it("stops at missing parents and cycles", () => {
    const loop = [v("x", "y", "process"), v("y", "x", "process")];
    expect(versionChain(loop, loop[0]!).map((x) => x.id)).toEqual(["x", "y"]);
    expect(modelingAncestor(loop, loop[0]!)).toBeUndefined();
    expect(skeletonSource([v("z", "gone", "process")], v("z", "gone", "process"))).toBeUndefined();
  });
  it("prefers confirmed attached joints nearest in the chain", () => {
    const plain = [v("m", null, "threejs"), v("o", "m", "process")];
    const attached = (confirmed: boolean) => ({
      versionId: "m",
      nodes: [{ id: "hips" }],
      origin: "ai",
      confirmed,
    });
    expect(rigSkeleton({ versions: plain }, plain[1]!)).toBeUndefined();
    expect(
      rigSkeleton({ versions: plain, skeletons: [attached(false)] }, plain[1]!),
    ).toBeUndefined();
    expect(
      rigSkeleton({ versions: plain, skeletons: [attached(false)] }, plain[1]!, true)?.origin,
    ).toBe("ai");
    const found = rigSkeleton({ versions: plain, skeletons: [attached(true)] }, plain[1]!);
    expect(found?.version.id).toBe("m");
    expect(rigSkeleton({ versions }, versions[3]!)?.origin).toBe("build");
  });
});
