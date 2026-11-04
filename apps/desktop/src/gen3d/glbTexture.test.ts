import { describe, expect, it } from "vitest";
import { baseColorImages, replaceBaseColor } from "./glbTexture";

const pad4 = (n: number) => (n + 3) & ~3;
function glb(json: object, bin: Uint8Array) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(text.length),
    binLength = pad4(bin.length);
  const out = new Uint8Array(28 + jsonLength + binLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}
function read(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength)));
  const bin = file.subarray(
    28 + jsonLength,
    28 + jsonLength + view.getUint32(20 + jsonLength, true),
  );
  const slice = (i: number) => {
    const v = json.bufferViews[i];
    return Array.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
  };
  return { json, slice, length: view.getUint32(8, true), actual: file.length };
}
// Two views before the colour image (one unaligned), the colour image, then a normal map.
const fixture = () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0, 9, 9, 9, 9, 0, 0, 0, 0, 7, 7, 7, 7]);
  return glb(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 7 },
        { buffer: 0, byteOffset: 8, byteLength: 4 },
        { buffer: 0, byteOffset: 12, byteLength: 3 },
        { buffer: 0, byteOffset: 16, byteLength: 4 },
      ],
      images: [
        { bufferView: 2, mimeType: "image/png" },
        { bufferView: 3, mimeType: "image/png" },
      ],
      textures: [{ source: 0 }, { source: 1 }],
      materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
      ],
    },
    bin,
  );
};

describe("replaceBaseColor", () => {
  it("swaps only the base colour image and keeps other data", () => {
    const input = fixture();
    expect(baseColorImages(input)).toEqual([0]);
    const out = read(replaceBaseColor(input, new Uint8Array([42, 43, 44, 45, 46])));
    expect(out.length).toBe(out.actual);
    expect(out.slice(0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.slice(1)).toEqual([9, 9, 9, 9]);
    expect(out.slice(2)).toEqual([42, 43, 44, 45, 46]);
    expect(out.slice(3)).toEqual([7, 7, 7, 7]);
    for (const view of out.json.bufferViews) expect(view.byteOffset % 4).toBe(0);
    expect(out.json.buffers[0].byteLength).toBe(8 + 4 + 8 + 4);
    expect(out.json.materials).toEqual(read(input).json.materials);
  });
  it("refuses models without an embedded PNG colour texture", () => {
    const input = fixture();
    const json = read(input).json;
    delete json.materials[0].pbrMetallicRoughness;
    expect(() => replaceBaseColor(glb(json, new Uint8Array(20)), new Uint8Array(1))).toThrow(
      /no base colour/,
    );
    const jpeg = read(input).json;
    jpeg.images[0].mimeType = "image/jpeg";
    expect(() => replaceBaseColor(glb(jpeg, new Uint8Array(20)), new Uint8Array(1))).toThrow(
      /embedded PNG/,
    );
    expect(() => replaceBaseColor(new Uint8Array(8), new Uint8Array(1))).toThrow(/glTF 2.0/);
  });
});
