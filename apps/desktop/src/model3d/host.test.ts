import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
vi.mock("electron", () => ({ BrowserWindow: vi.fn(), dialog: {}, ipcMain: {} }));
import { importModelFile } from "./host";
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-model-import-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("embeds a complete glTF package while refusing remote, missing and escaping resources", async () => {
  await fs.mkdir(path.join(root, "package"));
  const file = path.join(root, "package", "model.gltf");
  await fs.writeFile(path.join(root, "package", "mesh.bin"), Buffer.from([0, 1, 2]));
  const write = async (uri: string) =>
    fs.writeFile(
      file,
      JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 3, uri }] }),
    );
  await write("mesh.bin");
  const result = JSON.parse(new TextDecoder().decode(await importModelFile(file)));
  expect(result.buffers[0].uri).toBe("data:application/octet-stream;base64,AAEC");
  await write("https://example.com/mesh.bin");
  await expect(importModelFile(file)).rejects.toThrow("Remote");
  await write("missing.bin");
  await expect(importModelFile(file)).rejects.toThrow();
  await fs.writeFile(path.join(root, "secret.bin"), "secret");
  await write("../secret.bin");
  await expect(importModelFile(file)).rejects.toThrow("escapes");
  await fs.symlink(path.join(root, "secret.bin"), path.join(root, "package", "linked.bin"));
  await write("linked.bin");
  await expect(importModelFile(file)).rejects.toThrow("escapes");
  await write("%2Fetc%2Fpasswd");
  await expect(importModelFile(file)).rejects.toThrow("absolute");
});
it("refuses oversized imports before reading or decoding them", async () => {
  const file = path.join(root, "large.glb"),
    handle = await fs.open(file, "w");
  await handle.truncate(100 * 1024 * 1024 + 1);
  await handle.close();
  await expect(importModelFile(file)).rejects.toThrow("100 MiB");
});
