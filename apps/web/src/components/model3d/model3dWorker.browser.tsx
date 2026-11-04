import { expect, it } from "vitest";
import * as THREE from "three";
import ScriptWorker from "../../model3dWorker?worker&inline";
import { validateSceneJSON } from "./model3dScene";

function compile(source: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const worker = new ScriptWorker();
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = (event) => {
      worker.terminate();
      try {
        if (event.data.error) throw new Error(String(event.data.error));
        validateSceneJSON(event.data.model);
        const root = new THREE.ObjectLoader().parse(event.data.model);
        if (!(root instanceof THREE.Group)) throw new Error("Invalid model root.");
        resolve(root);
      } catch (error) {
        reject(error);
      }
    };
    worker.postMessage({ source, parameters: {} });
  });
}

it("keeps child transforms set through position/rotation/scale after Worker serialization", async () => {
  const root = await compile(`
    function buildModel({ THREE }) {
      const root = new THREE.Group();
      const body = new THREE.Group();
      body.name = "Body";
      body.position.set(0, 5, 0);
      root.add(body);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), new THREE.MeshStandardMaterial());
      panel.name = "Panel";
      panel.position.set(1, 2, 3);
      panel.rotation.set(0, Math.PI / 2, 0);
      panel.scale.set(2, 2, 2);
      body.add(panel);
      return root;
    }
  `);
  const body = root.getObjectByName("Body")!,
    panel = root.getObjectByName("Panel")!;
  expect(body.position.toArray()).toEqual([0, 5, 0]);
  expect(panel.position.toArray()).toEqual([1, 2, 3]);
  expect(panel.rotation.y).toBeCloseTo(Math.PI / 2);
  expect(panel.scale.x).toBeCloseTo(2);
  root.updateMatrixWorld(true);
  const world = panel.getWorldPosition(new THREE.Vector3());
  expect(world.x).toBeCloseTo(1);
  expect(world.y).toBeCloseTo(7);
  expect(world.z).toBeCloseTo(3);
});
