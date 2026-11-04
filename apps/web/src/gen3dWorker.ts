// This bundle runs only in the 3D generation compiler's unprivileged Worker.
import * as THREE from "three";
import { SDF_LIBRARY, meshSdf, type SdfShape } from "@synara/shared/gen3dSdf";

interface MeshOptions {
  id?: string;
  name?: string;
  material?: THREE.Material;
  color?: string;
  resolution?: number;
}
const SDF = {
  ...SDF_LIBRARY,
  mesh(shape: SdfShape, options: MeshOptions = {}) {
    const result = meshSdf(shape, options.resolution ?? 128);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    const material =
      options.material ??
      new THREE.MeshStandardMaterial({ color: options.color ?? "#c8c8c8", roughness: 0.7 });
    const mesh = new THREE.Mesh(geometry, material);
    if (options.name) mesh.name = options.name;
    if (options.id) mesh.userData.ahaId = options.id;
    return mesh;
  },
};

globalThis.onmessage = (event: MessageEvent<{ source: string }>) => {
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
    const root = build({ THREE, SDF, params: {} });
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
