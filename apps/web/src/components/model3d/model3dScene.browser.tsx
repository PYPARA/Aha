import { expect, it } from "vitest";
import * as THREE from "three";
import {
  applyMaterialEdits,
  disposeModel,
  exportModel,
  inspectModel,
  loadModel,
  validateSceneJSON,
  validateModelContainer,
} from "./model3dScene";

it("roundtrips actual geometry, stable part IDs and PBR textures through one GLB", async () => {
  const root = new THREE.Group(),
    material = new THREE.MeshStandardMaterial({ color: "#cc4422", roughness: 0.6, metalness: 0.2 });
  material.userData.ahaId = "wood";
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), material);
  mesh.name = "Body";
  mesh.userData.ahaId = "body";
  const group = new THREE.Group();
  group.name = "Body group";
  group.userData.ahaId = "body-group";
  group.add(mesh);
  root.add(group);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgb(64,64,64)";
  context.fillRect(0, 0, 2, 2);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/png"),
  );
  await applyMaterialEdits(
    root,
    [{ materialId: "wood", roughnessMap: "rough" }],
    [{ id: "rough", name: "rough", bytes: new Uint8Array(await blob.arrayBuffer()) }],
  );
  await applyMaterialEdits(
    root,
    [{ materialId: "wood", metalnessMap: "metal" }],
    [{ id: "metal", name: "metal", bytes: new Uint8Array(await blob.arrayBuffer()) }],
  );
  expect(material.roughnessMap).toBeTruthy();
  expect(material.metalnessMap).toBeTruthy();
  const exported = await exportModel(root);
  expect(new TextDecoder().decode(exported.bytes.subarray(0, 4))).toBe("glTF");
  const reopened = await loadModel(exported.bytes),
    report = inspectModel(reopened);
  expect(report.triangles).toBe(12);
  expect(report.dimensions).toEqual([2, 1, 3]);
  expect(report.objects.find((object) => object.id === "body")).toMatchObject({
    parentId: "body-group",
    depth: 1,
    kind: "mesh",
  });
  expect(report.materials[0]?.id).toBe("wood");
  expect(report.textures[0]?.width).toBe(2);
  disposeModel(root);
  disposeModel(reopened);
});
it("refuses to publish a model when an embedded texture fails to decode", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [] }],
      images: [{ uri: "data:image/png;base64,aW52YWxpZA==" }],
      textures: [{ source: 0 }],
    }),
  );
  await expect(loadModel(bytes)).rejects.toThrow("texture could not be decoded");
});
it("rejects oversized accessor declarations before loading model buffers", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(() =>
    validateModelContainer(encode({ asset: { version: "2.0" }, accessors: [{ count: 1e12 }] })),
  ).toThrow("accessor");
  expect(() => validateModelContainer(encode({ asset: { version: "2.0" }, skins: [{}] }))).toThrow(
    "skinned",
  );
  expect(() =>
    validateModelContainer(encode({ asset: { version: "2.0" }, accessors: [{ count: 3 }] })),
  ).not.toThrow();
});
it("rejects untrusted primitive reconstruction, invalid indices and non-model nodes", () => {
  const root = new THREE.Group(),
    mesh: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  root.add(mesh);
  expect(() => validateSceneJSON(root.toJSON())).toThrow("buffer geometry");
  mesh.geometry = new THREE.BufferGeometry().copy(mesh.geometry);
  const value = root.toJSON();
  expect(() => validateSceneJSON(value)).not.toThrow();
  const bad = structuredClone(value) as any;
  bad.geometries[0].data.index.array[0] = 1e20;
  expect(() => validateSceneJSON(bad)).toThrow("indices");
  const light = new THREE.DirectionalLight();
  root.add(light);
  expect(() => validateSceneJSON(root.toJSON())).toThrow("without lights");
  disposeModel(root);
});
