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
