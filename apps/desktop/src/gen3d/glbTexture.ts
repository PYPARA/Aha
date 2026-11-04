// Replaces the base colour image inside a GLB without touching anything else: geometry, other
// textures and the JSON stay byte-for-byte except buffer offsets. Local repaint relies on this so
// that only texels inside the mask can differ from the parent version.
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const pad4 = (n: number) => (n + 3) & ~3;

interface GltfJson {
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

function parse(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2)
    throw new Error("Not a glTF 2.0 binary file.");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error("GLB JSON chunk is missing.");
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GltfJson;
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 > glb.byteLength || view.getUint32(binHeader + 4, true) !== BIN_CHUNK)
    throw new Error("GLB binary chunk is missing.");
  const binLength = view.getUint32(binHeader, true);
  const bin = glb.subarray(binHeader + 8, binHeader + 8 + binLength);
  if ((json.buffers?.length ?? 0) !== 1 || json.buffers![0]!.uri !== undefined)
    throw new Error("GLB must keep all data in its binary chunk.");
  return { json, bin };
}

/** Indices of the images used as a base colour texture by any material. */
export function baseColorImages(glb: Uint8Array) {
  const { json } = parse(glb);
  const images = new Set<number>();
  for (const material of json.materials ?? []) {
    const texture = material.pbrMetallicRoughness?.baseColorTexture?.index;
    const source = texture === undefined ? undefined : json.textures?.[texture]?.source;
    if (source !== undefined) images.add(source);
  }
  return [...images];
}

/** Returns a copy of `glb` whose base colour images hold `png`; throws when there is none. */
export function replaceBaseColor(glb: Uint8Array, png: Uint8Array) {
  const { json, bin } = parse(glb);
  const targets = new Set(baseColorImages(glb));
  if (!targets.size) throw new Error("The model has no base colour texture.");
  const replaced = new Map<number, number>();
  for (const index of targets) {
    const image = json.images?.[index];
    if (image?.bufferView === undefined || image.mimeType !== "image/png")
      throw new Error("The base colour texture is not an embedded PNG.");
    // A view shared with another image or accessor cannot be swapped safely.
    const sharedImage = json.images!.some(
      (other, i) => i !== index && !targets.has(i) && other.bufferView === image.bufferView,
    );
    if (sharedImage) throw new Error("The base colour texture shares data with another image.");
    replaced.set(image.bufferView, index);
  }
  const parts: Uint8Array[] = [];
  let offset = 0;
  json.bufferViews = (json.bufferViews ?? []).map((view, index) => {
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > bin.byteLength)
      throw new Error("GLB buffer view is out of range.");
    const data = replaced.has(index) ? png : bin.subarray(start, start + view.byteLength);
    const placed = { ...view, byteOffset: offset, byteLength: data.byteLength };
    parts.push(data);
    offset += data.byteLength;
    const padding = pad4(offset) - offset;
    if (padding) parts.push(new Uint8Array(padding));
    offset += padding;
    return placed;
  });
  json.buffers![0]!.byteLength = offset;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(text.byteLength);
  const total = 12 + 8 + jsonLength + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, BIN_CHUNK, true);
  let cursor = 28 + jsonLength;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
