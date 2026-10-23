// This bundle runs only in the dedicated compiler's unprivileged Worker.
import * as THREE from "three";
globalThis.onmessage = (
  event: MessageEvent<{ source: string; parameters: Record<string, unknown> }>,
) => {
  try {
    const build = new Function(
      '"use strict";\n' +
        event.data.source +
        '\n;return typeof buildModel === "function" ? buildModel : null;',
    )() as
      | ((input: { THREE: typeof THREE; params: Record<string, unknown> }) => THREE.Group)
      | null;
    if (!build) throw new Error("Define buildModel({ THREE, params }) and return a THREE.Group.");
    const root = build({ THREE, params: event.data.parameters });
    if (!(root instanceof THREE.Group)) throw new Error("buildModel must return a THREE.Group.");
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry = new THREE.BufferGeometry().copy(object.geometry);
      }
    });
    const json = root.toJSON();
    if (JSON.stringify(json).length > 100 * 1024 * 1024)
      throw new Error("Model exceeds the memory limit.");
    globalThis.postMessage({ model: json });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
