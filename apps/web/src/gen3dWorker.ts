// This bundle runs only in the 3D generation compiler's unprivileged Worker.
import * as THREE from "three";
import { SDF_LIBRARY, meshSdf, splitRegions, type SdfShape } from "@synara/shared/gen3dSdf";

interface MeshOptions {
  id?: string;
  name?: string;
  material?: THREE.Material;
  color?: string;
  /** Per named region (SDF.part): a material or a colour; others use material/color. */
  materials?: Record<string, THREE.Material>;
  colors?: Record<string, string>;
  resolution?: number;
}
const geometryOf = (piece: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(piece.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(piece.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(piece.indices, 1));
  return geometry;
};
const SDF = {
  ...SDF_LIBRARY,
  /**
   * Meshes an SDF shape. Without named parts this is one mesh; with SDF.part regions it is a
   * group whose children are one mesh per region, ids "<id>-<region>" ("<id>-rest" for the
   * unnamed surface), so each region is a part of its own.
   */
  mesh(shape: SdfShape, options: MeshOptions = {}) {
    const result = meshSdf(shape, options.resolution ?? 128);
    const base =
      options.material ??
      new THREE.MeshStandardMaterial({ color: options.color ?? "#c8c8c8", roughness: 0.7 });
    if (!result.regions) {
      const mesh = new THREE.Mesh(geometryOf(result), base);
      if (options.name) mesh.name = options.name;
      if (options.id) mesh.userData.ahaId = options.id;
      return mesh;
    }
    const group = new THREE.Group();
    if (options.name) group.name = options.name;
    const id = options.id ?? "sdf";
    group.userData.ahaId = id;
    for (const piece of splitRegions(result)) {
      const region = piece.name ?? "rest";
      const color = piece.name ? options.colors?.[piece.name] : undefined;
      const material =
        (piece.name ? options.materials?.[piece.name] : undefined) ??
        (color ? new THREE.MeshStandardMaterial({ color, roughness: 0.7 }) : base);
      const mesh = new THREE.Mesh(geometryOf(piece), material);
      mesh.name = `${options.name ?? id} ${region}`;
      mesh.userData.ahaId = `${id}-${region}`;
      // Regions are open where they meet; topology checks weld meshes sharing this key.
      mesh.userData.ahaWeld = id;
      group.add(mesh);
    }
    return group;
  },
};

globalThis.onmessage = (event: MessageEvent<{ source: string; skeleton: unknown[] | null }>) => {
  try {
    const build = new Function(
      '"use strict";\n' +
        event.data.source +
        '\n;return typeof buildModel === "function" ? buildModel : null;',
    )() as
      | ((input: {
          THREE: typeof THREE;
          SDF: typeof SDF;
          params: Record<string, unknown>;
        }) => THREE.Group)
      | null;
    if (!build)
      throw new Error("Define buildModel({ THREE, SDF, params }) and return a THREE.Group.");
    const root = build({
      THREE,
      SDF,
      params: event.data.skeleton ? { skeleton: event.data.skeleton } : {},
    });
    if (!(root instanceof THREE.Group)) throw new Error("buildModel must return a THREE.Group.");
    root.traverse((object) => {
      if (object instanceof THREE.Mesh)
        object.geometry = new THREE.BufferGeometry().copy(object.geometry);
    });
    // toJSON serializes `matrix`, which only follows position/rotation/scale after an update.
    root.updateMatrixWorld(true);
    const json = root.toJSON();
    if (JSON.stringify(json).length > 200 * 1024 * 1024)
      throw new Error("Model exceeds the memory limit.");
    globalThis.postMessage({ model: json });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
