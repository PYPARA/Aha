import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MODEL3D_LIMITS, type Model3DBuild, type Model3DEnvironment } from "@synara/contracts";
import { atomicModelFile, modelErrorText } from "@synara/shared/model3dFiles";

interface Settings {
  blenderPath?: string;
  uvxPath?: string;
}
const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Additional publication policy on top of upstream safe mode. Only Aha's fixed
// publisher may choose file paths; generated Python receives in-memory bpy data.
export const BLENDER_SOURCE_CHECK = `import ast, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
denied = {'save', 'save_render', 'save_mainfile', 'save_as_mainfile', 'save_homefile', 'open_mainfile', 'revert_mainfile', 'recover_last_session', 'recover_auto_save', 'filepath', 'filepath_raw', 'filepaths', 'load', 'write', 'write_text', 'write_bytes', 'open', 'export_scene', 'export_mesh', 'export_anim', 'import_scene', 'import_mesh', 'import_anim', 'alembic_export', 'usd_export', 'collada_export', 'obj_export', 'ply_export', 'stl_export', 'fbx_export', 'gltf_export', 'getattr', 'setattr', 'delattr', 'vars', 'globals', 'locals', 'wm'}
for node in ast.walk(tree):
    names = []
    if isinstance(node, ast.Attribute): names.append(node.attr)
    elif isinstance(node, ast.Name): names.append(node.id)
    elif isinstance(node, ast.keyword) and node.arg: names.append(node.arg)
    elif isinstance(node, ast.ImportFrom):
        names.extend((node.module or '').split('.'))
        names.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.Constant) and isinstance(node.value, str): names.append(node.value)
    if any(name in denied or name.startswith(('export_', 'import_', '__')) for name in names):
        raise ValueError('Aha modeling source cannot read/write model files or choose publication paths (line ' + str(getattr(node, 'lineno', '?')) + '). Use the workbench import, texture and export controls.')
print('AHA_SOURCE_POLICY_OK')
`;
async function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Runtime preparation timed out."));
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      output = (output + chunk).slice(-2_000_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = (output + chunk).slice(-2_000_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(output || `Process exited with ${code}.`));
    });
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export class BlenderRuntime {
  private child: ChildProcess | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private busy: string | null = null;
  private settings: Settings = {};
  private addon: string | null = null;
  constructor(
    readonly root: string,
    private home: string,
  ) {}
  private env(): NodeJS.ProcessEnv {
    // Keep the Python toolchain, addon, cache and Blender preferences private to Aha.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      TMPDIR: path.join(this.root, "tmp"),
      UV_TOOL_DIR: path.join(this.root, "tools"),
      UV_CACHE_DIR: path.join(this.root, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(this.root, "python"),
      BLENDER_MCP_SAFE_MODE: "1",
      BLENDER_MCP_DISABLE_TELEMETRY: "1",
      DISABLE_TELEMETRY: "1",
      BLENDER_USER_CONFIG: path.join(this.root, "blender-config"),
      BLENDER_USER_SCRIPTS: path.join(this.root, "blender-scripts"),
    };
    return env;
  }
  private args() {
    return ["--python", "3.11", "--from", `mcp-for-blender==${MODEL3D_LIMITS.blenderMcpVersion}`];
  }
  async environment(): Promise<Model3DEnvironment> {
    this.settings = JSON.parse(
      await fs.readFile(path.join(this.root, "settings.json"), "utf8").catch(() => "{}"),
    );
    const blenderCandidates = [
      this.settings.blenderPath,
      "/Applications/Blender.app/Contents/MacOS/Blender",
    ];
    const uvxCandidates = [
      this.settings.uvxPath,
      path.join(this.home, ".local/bin/uvx"),
      "/opt/homebrew/bin/uvx",
      "/usr/local/bin/uvx",
    ];
    const blenderPath =
      (
        await Promise.all(
          blenderCandidates
            .filter((v): v is string => !!v)
            .map(async (p) => ((await exists(p)) ? p : null)),
        )
      ).find(Boolean) ?? null;
    const uvxPath =
      (
        await Promise.all(
          uvxCandidates
            .filter((v): v is string => !!v)
            .map(async (p) => ((await exists(p)) ? p : null)),
        )
      ).find(Boolean) ?? null;
    const marker = JSON.parse(
      await fs.readFile(path.join(this.root, "runtime.json"), "utf8").catch(() => "{}"),
    ) as { addon?: string; version?: string };
    this.addon =
      marker.version === MODEL3D_LIMITS.blenderMcpVersion &&
      marker.addon &&
      (await exists(marker.addon))
        ? marker.addon
        : null;
    let blenderVersion: string | null = null;
    try {
      if (blenderPath)
        blenderVersion =
          (await run(blenderPath, ["--version"], this.env(), 10_000)).split("\n")[0] ?? null;
    } catch {
      /* reported by connection check */
    }
    return {
      desktop: true,
      blenderPath,
      uvxPath,
      prepared: !!this.addon,
      blenderVersion,
      error: !blenderPath
        ? "Blender was not found. Select its executable."
        : !uvxPath
          ? "uvx was not found. Select its executable."
          : null,
    };
  }
  async configure(settings: Settings) {
    if (this.busy)
      throw new Error("Wait for the Blender task to finish before changing its runtime.");
    for (const file of [settings.blenderPath, settings.uvxPath])
      if (file && !path.isAbsolute(file)) throw new Error("Select an absolute executable path.");
    await atomicModelFile(
      path.join(this.root, "settings.json"),
      JSON.stringify({ ...this.settings, ...settings }),
    );
    await this.stop();
    return this.environment();
  }
  async prepare() {
    if (this.busy) throw new Error("A Blender task is running.");
    await fs.mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
    const environment = await this.environment();
    if (!environment.uvxPath || !environment.blenderPath)
      throw new Error(environment.error ?? "Blender runtime is unavailable.");
    const output = await run(
      environment.uvxPath,
      [
        ...this.args(),
        "python",
        "-c",
        "from blender_mcp.addon_manager import get_bundled_addon_path; print('AHA_ADDON=' + str(get_bundled_addon_path()))",
      ],
      this.env(),
      180_000,
    );
    const addon = output.match(/AHA_ADDON=(.+)/)?.[1]?.trim();
    if (
      !addon ||
      !path.resolve(addon).startsWith(path.resolve(this.root) + path.sep) ||
      !(await exists(addon))
    )
      throw new Error("The pinned Blender addon could not be prepared.");
    await atomicModelFile(
      path.join(this.root, "runtime.json"),
      JSON.stringify({ version: MODEL3D_LIMITS.blenderMcpVersion, addon }),
    );
    this.addon = addon;
    return this.environment();
  }
  async check() {
    if (this.busy) throw new Error("A Blender task is running.");
    this.busy = "connection-check";
    const directory = path.join(this.root, "connection-check");
    await fs.mkdir(directory, { recursive: true });
    try {
      await this.connect("connection-check", directory);
      return await this.environment();
    } finally {
      await this.stop();
      this.busy = null;
    }
  }
  private async connect(projectId: string, logDirectory: string) {
    await this.stop();
    const environment = await this.environment();
    if (!environment.blenderPath || !environment.uvxPath || !this.addon)
      throw new Error(environment.error ?? "Prepare the Blender runtime first.");
    const port = await freePort();
    const bootstrap = path.join(logDirectory, "blender-start.py");
    await atomicModelFile(
      bootstrap,
      `import bpy, importlib.util, sys, os\nspec = importlib.util.spec_from_file_location("aha_blender_mcp", ${JSON.stringify(this.addon)})\naddon = importlib.util.module_from_spec(spec)\nsys.modules[spec.name] = addon\nspec.loader.exec_module(addon)\naddon.register()\nbpy.context.scene["aha_project_id"] = ${JSON.stringify(projectId)}\nbpy.context.scene.unit_settings.system = 'METRIC'\nbpy.context.scene.unit_settings.scale_length = 1.0\nfor key in dir(bpy.context.scene):\n    if key.startswith('blendermcp_use_'):\n        try: setattr(bpy.context.scene, key, False)\n        except: pass\nbpy.types.blendermcp_server = addon.BlenderMCPServer(host='127.0.0.1', port=${port})\nbpy.types.blendermcp_server.start()\n`,
    );
    const log = await fs.open(path.join(logDirectory, "blender.log"), "a");
    this.child = spawn(
      environment.blenderPath,
      ["--factory-startup", "--disable-autoexec", "--python", bootstrap],
      { env: this.env(), stdio: ["ignore", log.fd, log.fd] },
    );
    const launched = this.child;
    launched.on("error", () => {});
    await log.close();
    try {
      let connected = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (launched.exitCode !== null)
          throw new Error("The dedicated Blender instance exited. See the retained task log.");
        connected = await new Promise<boolean>((resolve) => {
          const socket = net.connect(port, "127.0.0.1");
          socket.setTimeout(250);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (connected) break;
        await delay(250);
      }
      if (!connected) throw new Error("Cannot connect to the dedicated Blender instance.");
      this.transport = new StdioClientTransport({
        command: environment.uvxPath,
        args: [...this.args(), "mcp-for-blender", "--port", String(port)],
        env: this.env() as Record<string, string>,
        stderr: "pipe",
      });
      this.transport.stderr?.on("data", (chunk) => {
        void fs.appendFile(path.join(logDirectory, "mcp.log"), chunk).catch(() => {});
      });
      this.client = new Client({ name: "aha-model3d", version: "1.0.0" });
      await this.client.connect(this.transport);
      const info = await this.call("get_scene_info", {});
      if (!info) throw new Error("Blender connection check failed.");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private async call(name: string, args: Record<string, unknown>) {
    if (!this.client) throw new Error("Blender is not connected.");
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: MODEL3D_LIMITS.blenderTimeoutMs,
    });
    const text =
      result.content && Array.isArray(result.content)
        ? result.content
            .filter((c) => c.type === "text")
            .map((c) => String(c.text))
            .join("\n")
        : "";
    if (
      result.isError ||
      /Rejected by safe mode|Error (?:executing code|getting scene info):|"status"\s*:\s*"error"|Traceback \(most recent call last\)/.test(
        text,
      )
    )
      throw new Error(text.slice(0, 8000));
    return text;
  }
  async build(input: {
    projectId: string;
    jobId: string;
    directory: string;
    build: Model3DBuild;
    parentBlend: string | null;
    parentGlb: string | null;
    textures: { id: string; file: string }[];
  }) {
    if (this.busy)
      throw new Error("Another Blender modeling task is running. Try again after it finishes.");
    this.busy = input.jobId;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.connect(input.projectId, input.directory);
          const setup = input.parentBlend
            ? `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(input.parentBlend)}, load_ui=False, use_scripts=False)`
            : `bpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\n${input.parentGlb ? `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(input.parentGlb)})` : ""}`;
          await this.call("execute_blender_code", {
            code: `import bpy\n${setup}\nbpy.context.scene['aha_project_id'] = ${JSON.stringify(input.projectId)}\n`,
          });
          if (input.build.source.trim()) {
            const sourceFile = path.join(input.directory, "source.py");
            await atomicModelFile(sourceFile, input.build.source);
            const environment = await this.environment();
            if (!environment.uvxPath) throw new Error("uvx is unavailable.");
            await run(
              environment.uvxPath,
              [...this.args(), "python", "-c", BLENDER_SOURCE_CHECK, sourceFile],
              this.env(),
              10_000,
            );
            const result = await this.call("execute_blender_code", {
              code:
                `import json\nparams = json.loads(${JSON.stringify(JSON.stringify(input.build.parameters))})\n` +
                input.build.source,
              user_prompt: input.build.prompt,
            });
            await atomicModelFile(path.join(input.directory, "python-result.txt"), result);
          }
          const exportCode = blenderExportCode(input);
          await atomicModelFile(path.join(input.directory, "aha-export.py"), exportCode);
          const result = await this.call("execute_blender_code", { code: exportCode });
          await atomicModelFile(path.join(input.directory, "export-result.txt"), result);
          const message = result;
          const warnings = JSON.parse(
            message.match(/AHA_CHECK=(\{[^\n]+\})/)?.[1] ?? '{"warnings":[]}',
          );
          await atomicModelFile(
            path.join(input.directory, "blender-check.json"),
            JSON.stringify(warnings),
          );
          if (
            !(await exists(path.join(input.directory, "blender-output.glb"))) ||
            !(await exists(path.join(input.directory, "model.blend")))
          )
            throw new Error(
              "Blender did not publish a model and checkpoint. Check the retained Python result.",
            );
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.stop();
            reject(new Error("Blender modeling timed out. The previous checkpoint is preserved."));
          }, 165_000);
        }),
      ]);
    } catch (error) {
      await this.stop();
      throw new Error(modelErrorText(error), { cause: error });
    } finally {
      clearTimeout(timer);
      this.busy = null;
    }
  }
  async cancel(jobId: string) {
    if (this.busy === jobId) await this.stop();
  }
  async stop() {
    const client = this.client;
    this.client = null;
    const transport = this.transport;
    this.transport = null;
    const child = this.child;
    this.child = null;
    // Only child handles created above are terminated. Never search by process name.
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}

function blenderExportCode(input: {
  projectId: string;
  directory: string;
  build: Model3DBuild;
  textures: { id: string; file: string }[];
}) {
  const config = JSON.stringify({
    projectId: input.projectId,
    output: input.directory,
    edits: input.build.materialEdits,
    textures: input.textures,
  });
  return `import bpy, json, math\nfrom mathutils import Vector\ncfg = json.loads(${JSON.stringify(config)})\nif bpy.context.scene.get('aha_project_id') != cfg['projectId']: raise RuntimeError('Aha project identity mismatch')\nscene = bpy.context.scene\nscene.unit_settings.system = 'METRIC'\nscene.unit_settings.scale_length = 1.0\nallowed = {'ShaderNodeOutputMaterial', 'ShaderNodeBsdfPrincipled', 'ShaderNodeTexImage', 'ShaderNodeNormalMap', 'ShaderNodeSeparateColor', 'ShaderNodeSeparateRGB', 'ShaderNodeMapping', 'ShaderNodeTexCoord', 'ShaderNodeRGB', 'ShaderNodeValue'}\nissues = []\nmeshes = [o for o in scene.objects if o.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'} and not o.hide_render]\nif not meshes: raise RuntimeError('The model contains no meshes')\nfor o in meshes:\n    o['ahaId'] = o.get('ahaId', o.name)\n    if o.type == 'MESH' and not o.data.uv_layers: issues.append(o.name + ': UV coordinates are missing.')\n    for slot in o.material_slots:\n        m = slot.material\n        if not m: continue\n        m['ahaId'] = m.get('ahaId', m.name)\n        if m.use_nodes:\n            unsupported = [n.bl_idname for n in m.node_tree.nodes if n.bl_idname not in allowed]\n            if unsupported: raise RuntimeError(m.name + ': unsupported material nodes: ' + ', '.join(unsupported))\nfor edit in cfg['edits']:\n    m = next((m for m in bpy.data.materials if m.get('ahaId', m.name) == edit['materialId']), None)\n    if not m: raise RuntimeError('Material not found: ' + edit['materialId'])\n    m.use_nodes = True\n    bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)\n    if not bsdf: raise RuntimeError('Use a Principled BSDF material')\n    if 'color' in edit:\n        value = edit['color'].lstrip('#')\n        rgb = [int(value[i:i+2], 16) / 255 for i in (0, 2, 4)]\n        rgb = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]\n        bsdf.inputs['Base Color'].default_value = (*rgb, 1)\n    for key, socket in [('roughness', 'Roughness'), ('metalness', 'Metallic'), ('opacity', 'Alpha')]:\n        if key in edit: bsdf.inputs[socket].default_value = edit[key]\n    for key, socket in [('baseColor', 'Base Color'), ('normal', 'Normal'), ('roughnessMap', 'Roughness'), ('metalnessMap', 'Metallic')]:\n        if key not in edit: continue\n        for link in list(bsdf.inputs[socket].links): m.node_tree.links.remove(link)\n        if not edit[key]: continue\n        item = next((t for t in cfg['textures'] if t['id'] == edit[key]), None)\n        if not item: raise RuntimeError('Texture missing')\n        image = bpy.data.images.load(item['file'], check_existing=True)\n        image.colorspace_settings.name = 'sRGB' if key == 'baseColor' else 'Non-Color'\n        image.pack()\n        node = m.node_tree.nodes.new('ShaderNodeTexImage'); node.image = image\n        out = node.outputs['Color']\n        if key == 'normal':\n            normal = m.node_tree.nodes.new('ShaderNodeNormalMap'); m.node_tree.links.new(out, normal.inputs['Color']); out = normal.outputs['Normal']\n        elif key in ('roughnessMap', 'metalnessMap'):\n            sep = m.node_tree.nodes.new('ShaderNodeSeparateColor'); m.node_tree.links.new(out, sep.inputs['Color']); out = sep.outputs['Red']\n        m.node_tree.links.new(out, bsdf.inputs[socket])\n# Normalize static props to a bottom-center origin, in Blender Z-up before glTF Y-up conversion.\nroots = [o for o in meshes if o.parent is None]\nbounds = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]\nminimum = Vector(tuple(min(v[i] for v in bounds) for i in range(3)))\nmaximum = Vector(tuple(max(v[i] for v in bounds) for i in range(3)))\noffset = Vector(((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, minimum.z))\nfor o in scene.objects:\n    if o.parent is None: o.location -= offset\nbpy.context.view_layer.update()\nbpy.ops.wm.save_as_mainfile(filepath=cfg['output'] + '/model.blend', check_existing=False)\nbpy.ops.object.select_all(action='DESELECT')\nfor o in meshes:\n    o.select_set(True)\n    parent = o.parent\n    while parent:\n        if parent.type == 'EMPTY': parent.select_set(True)\n        parent = parent.parent\nbpy.ops.export_scene.gltf(filepath=cfg['output'] + '/blender-output.glb', export_format='GLB', use_selection=True, export_extras=True, export_animations=False, export_yup=True, export_apply=True, export_cameras=False, export_lights=False)\nprint('AHA_CHECK=' + json.dumps({'warnings': issues}))\nprint('Aha model checkpoint and GLB published')\n`;
}
