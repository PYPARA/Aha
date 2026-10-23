import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import type { Model3DMaterialEdit, Model3DValidationReport } from "@synara/contracts";

export function disposeModel(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  textures.forEach((texture) => {
    texture.dispose();
    if (texture.image instanceof ImageBitmap) texture.image.close();
  });
}
export function modelMaterials(root: THREE.Object3D) {
  const result = new Map<string, THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      let id =
        typeof material.userData.ahaId === "string"
          ? material.userData.ahaId
          : material.name || "material-" + result.size;
      if (result.has(id) && result.get(id) !== material) {
        if (material.userData.ahaId) throw new Error("Duplicate stable material ID: " + id);
        let suffix = 1;
        while (result.has(id + "-" + suffix)) suffix++;
        id += "-" + suffix;
      }
      material.userData.ahaId = id;
      if (material instanceof THREE.MeshStandardMaterial) result.set(id, material);
    }
  });
  return result;
}
export function inspectModel(root: THREE.Object3D): Model3DValidationReport {
  root.updateMatrixWorld(true);
  const objects: {
      id: string;
      name: string;
      triangles: number;
      parentId: string | null;
      kind: "group" | "mesh";
      depth: number;
    }[] = [],
    warnings: string[] = [],
    errors: string[] = [];
  let vertices = 0,
    triangles = 0;
  const materials = modelMaterials(root),
    textures = new Map<string, { name: string; width: number; height: number }>();
  root.traverse((object) => {
    if (
      object === root ||
      (!(object instanceof THREE.Mesh) && !object.name && !object.userData.ahaId)
    )
      return;
    const id =
      typeof object.userData.ahaId === "string" ? object.userData.ahaId : "part-" + objects.length;
    if (objects.some((part) => part.id === id))
      throw new Error("Duplicate stable object ID: " + id);
    object.userData.ahaId = id;
    let parent = object.parent,
      depth = 0,
      parentId: string | null = null;
    while (parent && parent !== root) {
      if (parent.userData.ahaId) {
        parentId ??= String(parent.userData.ahaId);
        depth++;
      }
      parent = parent.parent;
    }
    objects.push({
      id,
      name: object.name || id,
      triangles: 0,
      parentId,
      kind: object instanceof THREE.Mesh ? "mesh" : "group",
      depth,
    });
  });
  let meshIndex = 0;
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh)
      errors.push("Skinned models are not supported in this release.");
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute("position");
    if (!position) {
      errors.push("A mesh has no positions.");
      return;
    }
    vertices += position.count;
    const count = (geometry.index?.count ?? position.count) / 3;
    triangles += count;
    const id =
      typeof object.userData.ahaId === "string" ? object.userData.ahaId : "part-" + objects.length;
    object.userData.ahaId = id;
    const part = objects.find((part) => part.id === id);
    if (part) part.triangles = count;
    meshIndex++;
    if (!geometry.hasAttribute("uv"))
      warnings.push((object.name || id) + ": UV coordinates are missing.");
    if (!geometry.hasAttribute("normal"))
      warnings.push((object.name || id) + ": Normals are missing.");
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial))
        errors.push("Only standard PBR materials are supported: " + material.type);
      for (const [slot, value] of Object.entries(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        const image = value.image as { width?: number; height?: number } | undefined;
        if (!image?.width || !image.height) errors.push("A texture image is missing: " + slot);
        else
          textures.set(value.uuid, {
            name: value.name || slot,
            width: image.width,
            height: image.height,
          });
      }
    }
  });
  const bounds = new THREE.Box3().setFromObject(root),
    dimensions = bounds.getSize(new THREE.Vector3()).toArray();
  if (!meshIndex || !triangles) errors.push("The model contains no triangles.");
  if (dimensions.some((n) => !Number.isFinite(n))) errors.push("Model dimensions are invalid.");
  if (triangles > 1_000_000) errors.push("The model exceeds 1,000,000 triangles.");
  if (objects.length > 5_000) errors.push("The model exceeds 5,000 objects.");
  return {
    triangles,
    vertices,
    bytes: 0,
    dimensions,
    objects,
    materials: [...materials].map(([id, m]) => ({
      id,
      name: m.name || id,
      color: "#" + m.color.getHexString(),
      roughness: m.roughness,
      metalness: m.metalness,
      opacity: m.opacity,
    })),
    textures: [...textures.values()],
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    validatorErrors: 0,
  };
}

export function validateSceneJSON(value: unknown): asserts value is object {
  if (!value || typeof value !== "object") throw new Error("The script did not return a model.");
  const data = value as {
    geometries?: {
      uuid?: string;
      type: string;
      data?: {
        attributes?: Record<string, { array: unknown[]; type?: string; itemSize?: number }>;
        index?: { array: unknown[]; type?: string };
      };
    }[];
    materials?: { type: string }[];
    images?: unknown[];
    textures?: unknown[];
    object?: unknown;
  };
  if (data.images?.length || data.textures?.length)
    throw new Error(
      "Import textures through the material inspector instead of loading them in source code.",
    );
  for (const key of ["animations", "skeletons", "shapes"]) {
    if ((value as Record<string, unknown[]>)[key]?.length)
      throw new Error("Only static mesh data is accepted from the modeling worker.");
  }
  if ((data.geometries?.length ?? 0) > 5000 || (data.materials?.length ?? 0) > 5000)
    throw new Error("Too many model components.");
  let values = 0;
  let totalTriangles = 0;
  for (const geometry of data.geometries ?? []) {
    if (geometry.type !== "BufferGeometry")
      throw new Error("Only bounded buffer geometry is accepted from the worker.");
    for (const attribute of Object.values(geometry.data?.attributes ?? {})) {
      if (
        !Number.isInteger(attribute.itemSize) ||
        attribute.itemSize! < 1 ||
        attribute.itemSize! > 4 ||
        ![
          "Float32Array",
          "Float64Array",
          "Int8Array",
          "Uint8Array",
          "Int16Array",
          "Uint16Array",
          "Int32Array",
          "Uint32Array",
        ].includes(attribute.type ?? "")
      )
        throw new Error("Invalid geometry attribute type.");
      if (
        !Array.isArray(attribute.array) ||
        attribute.array.length > 9_000_000 ||
        !attribute.array.every((v) => typeof v === "number" && Number.isFinite(v))
      )
        throw new Error("Invalid or oversized geometry attribute.");
      if (attribute.array.length % attribute.itemSize! !== 0)
        throw new Error("Invalid geometry attribute length.");
      values += attribute.array.length;
    }
    const position = geometry.data?.attributes?.position;
    if (!position || position.itemSize !== 3)
      throw new Error("Mesh positions require three coordinates.");
    const index = geometry.data?.index;
    if (index) {
      if (
        !Array.isArray(index.array) ||
        index.array.length > 3_000_000 ||
        !["Uint16Array", "Uint32Array"].includes(index.type ?? "") ||
        !index.array.every(
          (v) =>
            typeof v === "number" &&
            Number.isSafeInteger(v) &&
            v >= 0 &&
            v < position.array.length / 3,
        )
      )
        throw new Error("Invalid geometry indices.");
      values += index.array.length;
    }
    const triangles = (index?.array.length ?? position.array.length / 3) / 3;
    if (!Number.isInteger(triangles)) throw new Error("Triangle geometry is incomplete.");
    totalTriangles += triangles;
  }
  if (values > 24_000_000) throw new Error("Geometry exceeds the memory limit.");
  if (totalTriangles > 1_000_000) throw new Error("The model exceeds 1,000,000 triangles.");
  for (const material of data.materials ?? [])
    if (material.type !== "MeshStandardMaterial" && material.type !== "MeshPhysicalMaterial")
      throw new Error("Use MeshStandardMaterial for game assets.");
  let nodes = 0;
  const visit = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || ++nodes > 5000)
      throw new Error("Invalid scene hierarchy.");
    const node = raw as { type?: string; children?: unknown[]; matrix?: unknown[] };
    if (!["Group", "Object3D", "Mesh"].includes(node.type ?? ""))
      throw new Error("Return only model meshes and groups, without lights or cameras.");
    if (
      node.matrix &&
      (!Array.isArray(node.matrix) ||
        node.matrix.length !== 16 ||
        !node.matrix.every((v) => typeof v === "number" && Number.isFinite(v)))
    )
      throw new Error("Invalid object transform.");
    node.children?.forEach(visit);
  };
  visit(data.object);
}
export async function loadModel(bytes: Uint8Array): Promise<THREE.Group> {
  validateModelContainer(bytes);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!/^(data:|blob:)/.test(url))
      throw new Error(
        "External model resources are not allowed. Import the complete glTF package.",
      );
    return url;
  });
  const copy = new Uint8Array(bytes),
    text = new TextDecoder().decode(copy.subarray(0, 4));
  const payload = text === "glTF" ? copy.buffer : new TextDecoder().decode(copy);
  const gltf = await new GLTFLoader(manager).parseAsync(payload, "");
  // GLTFLoader can resolve with null textures after a decode/CSP error. Publishing
  // that scene would silently turn a textured asset into an untextured version.
  const textures = await gltf.parser.getDependencies("texture");
  if (textures.some((texture) => !texture)) {
    disposeModel(gltf.scene);
    throw new Error("An embedded model texture could not be decoded.");
  }
  if (gltf.animations.length) {
    disposeModel(gltf.scene);
    throw new Error("Animated models are not supported in this release.");
  }
  const helpers: THREE.Object3D[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Camera || object instanceof THREE.Light) helpers.push(object);
  });
  helpers.forEach((object) => object.removeFromParent());
  return gltf.scene;
}

// Check declared sizes before GLTFLoader allocates typed arrays for an imported file.
export function validateModelContainer(bytes: Uint8Array) {
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Model exceeds 100 MiB.");
  let document: Record<string, unknown>;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (
      bytes.byteLength < 20 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength ||
      view.getUint32(16, true) !== 0x4e4f534a
    )
      throw new Error("Invalid GLB container.");
    const length = view.getUint32(12, true);
    if (length > bytes.byteLength - 20) throw new Error("Invalid GLB JSON length.");
    document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  } else document = JSON.parse(new TextDecoder().decode(bytes));
  const accessors = (document.accessors ?? []) as { count?: number; sparse?: { count?: number } }[];
  if (!Array.isArray(accessors) || accessors.length > 50000)
    throw new Error("Too many model accessors.");
  let values = 0;
  for (const accessor of accessors) {
    if (
      !Number.isSafeInteger(accessor.count) ||
      accessor.count! < 0 ||
      accessor.count! > 3_000_000 ||
      (accessor.sparse && (accessor.sparse.count ?? 0) > accessor.count!)
    )
      throw new Error("Invalid or oversized model accessor.");
    values += accessor.count!;
  }
  if (values > 24_000_000) throw new Error("Model geometry exceeds capacity.");
  const nodes = document.nodes as unknown[] | undefined;
  if (nodes && (!Array.isArray(nodes) || nodes.length > 5000))
    throw new Error("Model exceeds 5,000 objects.");
  if (
    (document.skins as unknown[] | undefined)?.length ||
    (document.animations as unknown[] | undefined)?.length
  )
    throw new Error("Animated or skinned models are not supported in this release.");
}
export function normalizeModel(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root),
    center = bounds.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
  root.updateMatrixWorld(true);
}
export interface ModelTexture {
  id: string;
  name: string;
  bytes: Uint8Array;
}
async function textureCanvas(asset: ModelTexture) {
  const image = await createImageBitmap(
    new Blob([new Uint8Array(asset.bytes)], { type: "image/png" }),
  );
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Texture decoder unavailable.");
  context.drawImage(image, 0, 0);
  image.close();
  return canvas;
}
export async function applyMaterialEdits(
  root: THREE.Object3D,
  edits: readonly Model3DMaterialEdit[],
  assets: ModelTexture[],
) {
  const materials = modelMaterials(root);
  const get = async (id: string) => {
    const asset = assets.find((a) => a.id === id);
    if (!asset) throw new Error("A referenced texture is missing: " + id);
    return textureCanvas(asset);
  };
  for (const edit of edits) {
    const material = materials.get(edit.materialId);
    if (!material) throw new Error("Material no longer exists: " + edit.materialId);
    if (edit.color !== undefined) {
      if (!/^#[\da-f]{6}$/i.test(edit.color)) throw new Error("Invalid material color.");
      material.color.set(edit.color);
    }
    for (const key of ["roughness", "metalness", "opacity"] as const)
      if (edit[key] !== undefined) {
        if (edit[key]! < 0 || edit[key]! > 1)
          throw new Error("Material values must be between 0 and 1.");
        material[key] = edit[key]!;
      }
    material.transparent = material.opacity < 1;
    if (edit.baseColor !== undefined) {
      material.map = edit.baseColor ? new THREE.CanvasTexture(await get(edit.baseColor)) : null;
      if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
    }
    if (edit.normal !== undefined) {
      material.normalMap = edit.normal ? new THREE.CanvasTexture(await get(edit.normal)) : null;
    }
    if (edit.roughnessMap !== undefined || edit.metalnessMap !== undefined) {
      // Preserve a previously imported channel when only the other slot changes.
      const existing = (texture: THREE.Texture | null) =>
        texture?.image as HTMLCanvasElement | ImageBitmap | HTMLImageElement | undefined;
      const rough =
          edit.roughnessMap === undefined
            ? existing(material.roughnessMap)
            : edit.roughnessMap
              ? await get(edit.roughnessMap)
              : null,
        metal =
          edit.metalnessMap === undefined
            ? existing(material.metalnessMap)
            : edit.metalnessMap
              ? await get(edit.metalnessMap)
              : null;
      if (rough || metal) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(rough?.width ?? 1, metal?.width ?? 1);
        canvas.height = Math.max(rough?.height ?? 1, metal?.height ?? 1);
        const context = canvas.getContext("2d")!;
        const read = (c: CanvasImageSource | null | undefined) => {
          context.clearRect(0, 0, canvas.width, canvas.height);
          if (c) context.drawImage(c, 0, 0, canvas.width, canvas.height);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const r = read(rough),
          m = read(metal),
          out = context.createImageData(canvas.width, canvas.height);
        for (let i = 0; i < out.data.length; i += 4) {
          out.data[i] = 255;
          out.data[i + 1] = rough ? r[i + (edit.roughnessMap === undefined ? 1 : 0)]! : 255;
          out.data[i + 2] = metal ? m[i + (edit.metalnessMap === undefined ? 2 : 0)]! : 255;
          out.data[i + 3] = 255;
        }
        context.putImageData(out, 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        material.roughnessMap = rough ? texture : null;
        material.metalnessMap = metal ? texture : null;
      } else {
        if (edit.roughnessMap !== undefined) material.roughnessMap = null;
        if (edit.metalnessMap !== undefined) material.metalnessMap = null;
      }
    }
    material.needsUpdate = true;
  }
}
export async function exportModel(root: THREE.Group) {
  const report = inspectModel(root);
  if (report.errors.length) throw new Error(report.errors.join("\n"));
  const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer) || result.byteLength > 100 * 1024 * 1024)
    throw new Error("Model exceeds the 100 MiB file limit.");
  return { bytes: new Uint8Array(result), report: { ...report, bytes: result.byteLength } };
}
