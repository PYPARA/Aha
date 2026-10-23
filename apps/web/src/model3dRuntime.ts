import * as THREE from "three";
import ScriptWorker from "./model3dWorker?worker&inline";
import {
  applyMaterialEdits,
  disposeModel,
  exportModel,
  loadModel,
  normalizeModel,
  validateSceneJSON,
  type ModelTexture,
} from "./components/model3d/model3dScene";
import type { Model3DBuild } from "@synara/contracts";

interface Task {
  id: string;
  build: Model3DBuild;
  input: Uint8Array | null;
  textures: ModelTexture[];
}
const bridge = (
  window as unknown as {
    model3dCompiler: {
      onTask: (cb: (task: Task) => void) => void;
      complete: (result: unknown) => void;
      ready: () => void;
    };
  }
).model3dCompiler;
function buildScript(task: Task): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const worker = new ScriptWorker(),
      timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Three.js build timed out after 30 seconds."));
      }, 30_000);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.onmessage = (e) => {
      finish();
      try {
        if (e.data.error) throw new Error(String(e.data.error));
        validateSceneJSON(e.data.model);
        const root = new THREE.ObjectLoader().parse(e.data.model);
        if (!(root instanceof THREE.Group)) throw new Error("Invalid model root.");
        normalizeModel(root);
        resolve(root);
      } catch (error) {
        reject(error);
      }
    };
    worker.postMessage({ source: task.build.source, parameters: task.build.parameters });
  });
}
function thumbnail(root: THREE.Group) {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(512, 512);
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.8));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 5, 4);
  scene.add(light);
  const bounds = new THREE.Box3().setFromObject(root),
    center = bounds.getCenter(new THREE.Vector3()),
    size = bounds.getSize(new THREE.Vector3()).length();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.001, Math.max(100, size * 20));
  camera.position
    .copy(center)
    .add(new THREE.Vector3(0.9, 0.65, 1.2).normalize().multiplyScalar(Math.max(size, 0.01) * 1.8));
  camera.lookAt(center);
  renderer.render(scene, camera);
  const image = renderer.domElement.toDataURL("image/png").split(",")[1]!;
  renderer.dispose();
  scene.remove(root);
  return image;
}
bridge.onTask(async (task) => {
  let root: THREE.Group | undefined;
  try {
    root = task.input ? await loadModel(task.input) : await buildScript(task);
    if (task.input && task.build.prompt === "Imported model") normalizeModel(root);
    await applyMaterialEdits(root, task.build.materialEdits, task.textures);
    const output = await exportModel(root);
    const png = thumbnail(root);
    bridge.complete({ id: task.id, ...output, thumbnail: png });
  } catch (error) {
    bridge.complete({
      id: task.id,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 8000),
    });
  } finally {
    if (root) disposeModel(root);
  }
});
bridge.ready();
