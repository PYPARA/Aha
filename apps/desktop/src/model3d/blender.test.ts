import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BLENDER_SOURCE_CHECK, BlenderRuntime } from "./blender";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

it("reports unavailable local dependencies without starting a Blender process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aha-blender-missing-"));
  try {
    await vi.mocked(fs.stat).withImplementation(
      async () => {
        throw new Error("ENOENT");
      },
      async () => {
        const result = await new BlenderRuntime(root, root).environment();
        expect(result.blenderPath).toBeNull();
        expect(result.uvxPath).toBeNull();
        expect(result.prepared).toBe(false);
        expect(result.error).toContain("Blender was not found");
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps file publication in the trusted host while accepting procedural mesh code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aha-blender-policy-")),
    file = path.join(root, "source.py");
  const check = async (source: string) => {
    await fs.writeFile(file, source);
    return promisify(execFile)("python3", ["-c", BLENDER_SOURCE_CHECK, file]);
  };
  try {
    await expect(
      check(
        "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)\nbpy.context.object.name='body'\n",
      ),
    ).resolves.toBeDefined();
    for (const source of [
      "import bpy\nbpy.ops.wm.save_as_mainfile(filepath='/tmp/overwrite.blend')",
      "import bpy\nf = bpy.ops.wm.save_mainfile\nf()",
      "from bpy.ops.wm import save_as_mainfile as save\nsave()",
      "import bpy\ngetattr(bpy.ops.wm, 'save_as_mainfile')()",
      "import bpy\ngetattr(bpy.ops, 'w'+'m')['save_'+'as_mainfile'](**{'file'+'path':'/tmp/overwrite.blend'})",
      "import bpy\nbpy.data.images[0].save_render(filepath='/tmp/overwrite.png')",
      "import bpy\nbpy.ops.export_scene.gltf(filepath='/tmp/overwrite.glb')",
      "import bpy\nbpy.data.images.load('/tmp/image.png')",
    ])
      await expect(check(source)).rejects.toThrow("cannot read/write");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
