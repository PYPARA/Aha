// Trusted scene helpers for the 3D generation viewer. Unlike the 3D workshop's loader this one
// accepts skins and animations: it only ever loads GLBs Aha published itself (checked by the glTF
// Validator before publishing) and still refuses external resources.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const DISPLAY_MODES = [
  "material",
  "color",
  "normal",
  "roughness",
  "metalness",
  "occlusion",
  "uv",
  "wireframe",
  "solid",
] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number] | "weights";

const MAX_BYTES = 200 * 1024 * 1024;
export async function loadGen3DModel(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BYTES) throw new Error("Model exceeds 200 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error("Invalid GLB container.");
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!/^(data:|blob:)/.test(url)) throw new Error("External model resources are not allowed.");
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(new Uint8Array(bytes).buffer, "");
  const textures = await gltf.parser.getDependencies("texture");
  if (textures.some((texture) => !texture))
    throw new Error("An embedded model texture could not be decoded.");
  const helpers: THREE.Object3D[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Camera || object instanceof THREE.Light) helpers.push(object);
  });
  helpers.forEach((object) => object.removeFromParent());
  return { scene: gltf.scene, animations: gltf.animations };
}

export function disposeScene(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of [object.material].flat() as THREE.Material[]) {
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

/**
 * One texture channel as greyscale, with skinning and morphs left to three.js. glTF keeps
 * roughness in G, metalness in B and occlusion in R; values are shown as stored (linear).
 */
export function channelMaterial(
  texture: THREE.Texture | null,
  channel: "r" | "g" | "b" | "rgb",
  factor: number,
) {
  const material = new THREE.MeshBasicMaterial({
    color: texture ? 0xffffff : new THREE.Color().setScalar(factor),
    map: texture,
  });
  // MeshBasicMaterial is converted to sRGB on output; undo that so 0.5 reads as mid grey.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      texture
        ? `vec4 sampledValue = texture2D( map, vMapUv );
           diffuseColor.rgb = pow( vec3( ${channel === "rgb" ? "sampledValue.rgb" : `sampledValue.${channel}`} ) * ${factor.toFixed(4)}, vec3( 2.2 ) );`
        : "diffuseColor.rgb = pow( diffuseColor.rgb, vec3( 2.2 ) );",
    );
  };
  material.customProgramCacheKey = () => `aha-channel-${channel}-${factor}-${!!texture}`;
  return material;
}

let checker: THREE.CanvasTexture | null = null;
/** An 8 × 8 numbered checker, shared by every UV view. */
export function checkerTexture() {
  if (checker) return checker;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d")!;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      context.fillStyle = (x + y) % 2 ? "#3a3f4b" : "#d8dbe2";
      context.fillRect(x * 64, y * 64, 64, 64);
      context.fillStyle = (x + y) % 2 ? "#d8dbe2" : "#3a3f4b";
      context.font = "20px sans-serif";
      context.fillText(`${String.fromCharCode(65 + x)}${8 - y}`, x * 64 + 8, y * 64 + 26);
    }
  checker = new THREE.CanvasTexture(canvas);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.anisotropy = 4;
  return checker;
}

/** Blue (0) -> green -> yellow -> red (1). */
export function heat(weight: number): [number, number, number] {
  const w = Math.min(1, Math.max(0, weight));
  if (w < 1 / 3) return [0, w * 3, 1 - w * 3];
  if (w < 2 / 3) return [(w - 1 / 3) * 3, 1, 0];
  return [1, 1 - (w - 2 / 3) * 3, 0];
}

/** Per-vertex colours for one bone's skin weights (four influences per vertex). */
export function weightColors(
  skinIndex: ArrayLike<number>,
  skinWeight: ArrayLike<number>,
  bone: number,
) {
  const count = skinIndex.length / 4;
  const colors = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (skinIndex[v * 4 + k] === bone) w += skinWeight[v * 4 + k]!;
    colors.set(heat(w), v * 3);
  }
  return colors;
}

export const BLUEPRINT_VIEWS = ["front", "side", "back"] as const;
export type BlueprintView = (typeof BLUEPRINT_VIEWS)[number];
const BLUEPRINT = 256,
  GROUND = Math.round(BLUEPRINT * 0.95);

/**
 * The orthographic frame in which the blueprint image lines up with the model, using the same
 * registration as the score: shared px/m, ground line, centring on the model's u range, the
 * registered shift and, for a mirrored match, a horizontally flipped image.
 * u is the image's horizontal axis: front x, back -x, side -z (camera on +X).
 */
export function overlayFrame(
  view: BlueprintView,
  bounds: { min: readonly number[]; max: readonly number[] },
  pxPerMetre: number,
  registration: { shiftPx: number; mirrored?: boolean | undefined },
) {
  const [uMin, uMax] =
    view === "front"
      ? [bounds.min[0]!, bounds.max[0]!]
      : view === "back"
        ? [-bounds.max[0]!, -bounds.min[0]!]
        : [-bounds.max[2]!, -bounds.min[2]!];
  const centreU =
    (uMin + uMax) / 2 + ((registration.mirrored ? 1 : -1) * registration.shiftPx) / pxPerMetre;
  const half = BLUEPRINT / 2 / pxPerMetre,
    centreY = (GROUND - BLUEPRINT / 2) / pxPerMetre;
  // Back to world: front u = x, back u = -x, side u = -z; depth is the bounds centre.
  const mid = (i: number) => (bounds.min[i]! + bounds.max[i]!) / 2;
  const centre: [number, number, number] =
    view === "front"
      ? [centreU, centreY, mid(2)]
      : view === "back"
        ? [-centreU, centreY, mid(2)]
        : [mid(0), centreY, -centreU];
  return {
    centre,
    /** Half the square frame's side in metres. */
    half,
    flipImage: registration.mirrored === true,
    /** From the model towards the camera. */
    direction: (view === "front" ? [0, 0, 1] : view === "back" ? [0, 0, -1] : [1, 0, 0]) as [
      number,
      number,
      number,
    ],
  };
}

/** Where a world point lands in the 256 px blueprint image of that frame (for tests and labels). */
export function frameColumnRow(
  view: BlueprintView,
  frame: ReturnType<typeof overlayFrame>,
  point: readonly number[],
) {
  const u = view === "front" ? point[0]! : view === "back" ? -point[0]! : -point[2]!;
  const centreU =
    view === "front" ? frame.centre[0] : view === "back" ? -frame.centre[0] : -frame.centre[2];
  const scale = BLUEPRINT / 2 / frame.half;
  const column = BLUEPRINT / 2 + (u - centreU) * scale;
  return {
    column: frame.flipImage ? BLUEPRINT - column : column,
    row: BLUEPRINT / 2 - (point[1]! - frame.centre[1]) * scale,
  };
}

/** A geometry's UV triangles as flat [u0, v0, u1, v1, u2, v2, …], or null without UVs. */
export function uvTriangles(geometry: THREE.BufferGeometry): Float32Array | null {
  const uv = geometry.getAttribute("uv");
  if (!uv) return null;
  const index = geometry.getIndex();
  const count = index ? index.count : uv.count;
  const out = new Float32Array(Math.floor(count / 3) * 6);
  for (let i = 0; i < out.length / 2; i++) {
    const vertex = index ? index.getX(i) : i;
    out[i * 2] = uv.getX(vertex);
    out[i * 2 + 1] = uv.getY(vertex);
  }
  return out;
}

/**
 * How the UV layout uses the texture, sampled at pixel centres of a size × size raster over the
 * unit square: the share covered at least once, and the share covered by more than one triangle
 * (overlapping or mirrored islands, which baking cannot tell apart). UVs outside 0–1 wrap.
 */
export function uvUsage(layouts: readonly Float32Array[], size = 256) {
  const hits = new Uint16Array(size * size);
  const wrap = (n: number) => n - Math.floor(n);
  for (const tris of layouts)
    for (let t = 0; t + 5 < tris.length; t += 6) {
      // Wrap each triangle by its first vertex's tile so it stays in one piece.
      const tu = Math.floor(tris[t]!),
        tv = Math.floor(tris[t + 1]!);
      const ax = (tris[t]! - tu) * size,
        ay = (tris[t + 1]! - tv) * size,
        bx = (tris[t + 2]! - tu) * size,
        by = (tris[t + 3]! - tv) * size,
        cx = (tris[t + 4]! - tu) * size,
        cy = (tris[t + 5]! - tv) * size;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (!area) continue;
      const x0 = Math.floor(Math.min(ax, bx, cx)),
        x1 = Math.ceil(Math.max(ax, bx, cx)),
        y0 = Math.floor(Math.min(ay, by, cy)),
        y1 = Math.ceil(Math.max(ay, by, cy));
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          // Just off the pixel centre, so a centre on an edge shared by two triangles (such as a
          // quad's diagonal) is not counted by both.
          const px = x + 0.5013,
            py = y + 0.4987;
          const w0 = (bx - px) * (cy - py) - (cx - px) * (by - py),
            w1 = (cx - px) * (ay - py) - (ax - px) * (cy - py),
            w2 = (ax - px) * (by - py) - (bx - px) * (ay - py);
          const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
          if (!inside) continue;
          const i = Math.floor(wrap(py / size) * size) * size + Math.floor(wrap(px / size) * size);
          if (hits[i]! < 65535) hits[i]!++;
        }
    }
  let covered = 0,
    overlapped = 0;
  for (const h of hits) {
    if (h) covered++;
    if (h > 1) overlapped++;
  }
  return { coverage: covered / hits.length, overlap: overlapped / hits.length };
}
