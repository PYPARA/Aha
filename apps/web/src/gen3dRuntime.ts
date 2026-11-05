import * as THREE from "three";
import ScriptWorker from "./gen3dWorker?worker&inline";
import {
  disposeModel,
  exportModel,
  loadModel,
  normalizeModel,
  validateSceneJSON,
} from "./components/model3d/model3dScene";
import { meshTopology } from "@synara/shared/gen3dSdf";
import {
  BLUEPRINT_SIZE,
  BLUEPRINT_VIEWS,
  maskPixels,
  rasterSilhouette,
  type BlueprintView,
} from "@synara/shared/gen3dScore";

interface Task {
  id: string;
  source: string;
  /** GLB from the Blender route; inspected, scored and rendered instead of running source. */
  input: Uint8Array | null;
  skeleton: unknown[] | null;
  /** Blueprint scale; null when the project has no blueprint, so no silhouettes are made. */
  pxPerMetre: number | null;
  timeoutMs: number;
}
const bridge = (
  window as unknown as {
    gen3dCompiler: {
      onTask: (cb: (task: Task) => void) => void;
      complete: (result: unknown) => void;
      ready: () => void;
    };
  }
).gen3dCompiler;

function buildScript(task: Task): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const worker = new ScriptWorker(),
      timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Model build timed out after ${task.timeoutMs / 1000} seconds.`));
      }, task.timeoutMs);
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
    worker.postMessage({ source: task.source, skeleton: task.skeleton });
  });
}

/** World-space triangles of every mesh, welded by position so seams of primitives do not count as holes. */
function worldTriangles(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const positions: number[] = [],
    indices: number[] = [];
  let boundaryEdges = 0,
    nonManifoldEdges = 0;
  const point = new THREE.Vector3();
  // Each mesh is checked on its own, except meshes sharing userData.ahaWeld (the regions of
  // one SDF body), which are open where they meet and are welded together first.
  const units = new Map<string, THREE.Mesh[]>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const weld = object.userData.ahaWeld;
    const key = typeof weld === "string" ? "weld:" + weld : "mesh:" + object.uuid;
    units.set(key, [...(units.get(key) ?? []), object]);
  });
  for (const meshes of units.values()) {
    const welded = new Map<string, number>(),
      local: number[] = [];
    for (const object of meshes) {
      const geometry = object.geometry as THREE.BufferGeometry,
        position = geometry.getAttribute("position");
      const base = positions.length / 3;
      const remap = new Int32Array(position.count);
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        positions.push(point.x, point.y, point.z);
        const key = `${Math.round(point.x * 1e5)},${Math.round(point.y * 1e5)},${Math.round(point.z * 1e5)}`;
        let id = welded.get(key);
        if (id === undefined) welded.set(key, (id = base + i));
        remap[i] = id;
      }
      const count = geometry.index ? geometry.index.count : position.count;
      for (let i = 0; i < count; i++) {
        const v = geometry.index ? geometry.index.getX(i) : i;
        indices.push(base + v);
        local.push(remap[v]!);
      }
    }
    const topology = meshTopology(local);
    boundaryEdges += topology.boundaryEdges;
    nonManifoldEdges += topology.nonManifoldEdges;
  }
  return { positions, indices, topology: { boundaryEdges, nonManifoldEdges } };
}

function encodeMask(pixels: Uint8Array) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = BLUEPRINT_SIZE;
  const context = canvas.getContext("2d")!,
    image = context.createImageData(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  for (let i = 0; i < BLUEPRINT_SIZE * BLUEPRINT_SIZE; i++) {
    image.data[i * 4] = pixels[i * 3]!;
    image.data[i * 4 + 1] = pixels[i * 3 + 1]!;
    image.data[i * 4 + 2] = pixels[i * 3 + 2]!;
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1]!;
}

type Shot = "thumbnail" | "34" | BlueprintView;
/** Lit renders for the thumbnail, the 3/4 view and the three orthographic views. */
function renders(root: THREE.Group) {
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.6));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 5, 4);
  scene.add(light);
  const bounds = new THREE.Box3().setFromObject(root),
    center = bounds.getCenter(new THREE.Vector3()),
    size = bounds.getSize(new THREE.Vector3()),
    radius = Math.max(size.length() / 2, 0.01);
  const out = {} as Record<Shot, string>;
  for (const shot of ["thumbnail", "34", ...BLUEPRINT_VIEWS] as Shot[]) {
    let camera: THREE.Camera;
    if (shot === "thumbnail" || shot === "34") {
      const perspective = new THREE.PerspectiveCamera(36, 1, 0.001, radius * 40);
      perspective.position
        .copy(center)
        .add(new THREE.Vector3(0.9, 0.65, 1.2).normalize().multiplyScalar(radius * 3.6));
      perspective.lookAt(center);
      camera = perspective;
    } else {
      const half = Math.max(size.x, size.y, size.z) * 0.6;
      const ortho = new THREE.OrthographicCamera(-half, half, half, -half, 0.001, radius * 40);
      const direction =
        shot === "front"
          ? new THREE.Vector3(0, 0, 1)
          : shot === "back"
            ? new THREE.Vector3(0, 0, -1)
            : new THREE.Vector3(1, 0, 0);
      ortho.position.copy(center).add(direction.multiplyScalar(radius * 4));
      ortho.lookAt(center);
      camera = ortho;
    }
    renderer.render(scene, camera);
    out[shot] = renderer.domElement.toDataURL("image/png").split(",")[1]!;
  }
  renderer.dispose();
  scene.remove(root);
  return out;
}

bridge.onTask(async (task) => {
  let root: THREE.Group | undefined;
  try {
    if (task.input) {
      root = await loadModel(task.input);
      normalizeModel(root);
    } else root = await buildScript(task);
    const { positions, indices, topology } = worldTriangles(root);
    const silhouettes: Partial<Record<BlueprintView, string>> = {};
    if (task.pxPerMetre)
      for (const view of BLUEPRINT_VIEWS)
        silhouettes[view] = encodeMask(
          maskPixels(rasterSilhouette(positions, indices, view, task.pxPerMetre)),
        );
    const output = await exportModel(root);
    const images = renders(root);
    bridge.complete({ id: task.id, ...output, topology, silhouettes, renders: images });
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
