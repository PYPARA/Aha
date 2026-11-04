// Version-chain helpers for 3D generation. Optimized, repainted and rigged versions are fixed
// steps ("process" builds) on top of a modeled version; these walk back to what they came from.

interface ChainVersion {
  id: string;
  build: {
    mode?: string | undefined;
    parentVersionId: string | null;
    skeleton?: readonly unknown[] | undefined;
  };
}

/** The version and its ancestors, nearest first; stops at a missing parent or a cycle. */
export function versionChain<V extends ChainVersion>(versions: readonly V[], version: V): V[] {
  const chain: V[] = [];
  let current: V | undefined = version;
  while (current && !chain.includes(current) && chain.length <= versions.length) {
    chain.push(current);
    const parentId: string | null = current.build.parentVersionId;
    current = parentId ? versions.find((v) => v.id === parentId) : undefined;
  }
  return chain;
}

/** The nearest modeled (non-process) version in the chain, or undefined. */
export function modelingAncestor<V extends ChainVersion>(versions: readonly V[], version: V) {
  return versionChain(versions, version).find((v) => v.build.mode !== "process");
}

/** The nearest version in the chain that carries a skeleton graph, or undefined. */
export function skeletonSource<V extends ChainVersion>(versions: readonly V[], version: V) {
  return versionChain(versions, version).find((v) => !!v.build.skeleton?.length);
}

interface AttachedSkeleton {
  versionId: string;
  nodes: readonly unknown[];
  origin: string;
  confirmed: boolean;
}

/**
 * The joints a rig would use: walking the chain nearest first, a joint set attached to that
 * version (confirmed, unless `includeProposals`) wins over the skeleton its build carried.
 */
export function rigSkeleton<V extends ChainVersion, S extends AttachedSkeleton>(
  project: { versions: readonly V[]; skeletons?: readonly S[] | undefined },
  version: V,
  includeProposals = false,
): { version: V; nodes: readonly unknown[]; origin: string; attached: S | null } | undefined {
  for (const v of versionChain(project.versions, version)) {
    const attached = project.skeletons?.find(
      (s) => s.versionId === v.id && s.nodes.length && (s.confirmed || includeProposals),
    );
    if (attached) return { version: v, nodes: attached.nodes, origin: attached.origin, attached };
    if (v.build.skeleton?.length)
      return { version: v, nodes: v.build.skeleton, origin: "build", attached: null };
  }
  return undefined;
}
