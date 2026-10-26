import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import sharp from "sharp";
import { Schema } from "effect";
import {
  Model3DBuild,
  Model3DProject,
  Model3DValidationReport,
  MODEL3D_LIMITS,
  type Model3DVersion,
} from "@synara/contracts";
import { modelPath, atomicModelFile, modelErrorText } from "@synara/shared/model3dFiles";
import { BlenderRuntime } from "./blender";

const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid model identity.");
  return value;
};
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function readModel(file: string) {
  if ((await fs.stat(file)).size > MODEL3D_LIMITS.fileBytes)
    throw new Error("Model exceeds 100 MiB.");
  return fs.readFile(file);
}
// Builds must answer before the server's 180 s request timeout gives up on them, so a
// stuck phase surfaces as a named error instead of a silent host timeout.
const BUILD_DEADLINE_MS = { threejs: 90_000, blender: 170_000 };
const DISPOSE_DEADLINE_MS = 5_000;
interface CompilerTask {
  id: string;
  build: typeof Model3DBuild.Type;
  input: Uint8Array | null;
  textures: { id: string; name: string; bytes: Uint8Array }[];
}
interface CompilerResult {
  bytes: Uint8Array;
  report: typeof Model3DValidationReport.Type;
  thumbnail: Uint8Array;
}

export class Model3DHost {
  readonly token = randomBytes(32).toString("hex");
  readonly pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\aha-model3d-${process.pid}-${randomUUID()}`
      : path.join(os.tmpdir(), `aha-3d-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
  private server: http.Server | null = null;
  private compilers = new Map<string, () => void>();
  private cancelled = new Set<string>();
  private phases = new Map<string, { phase: string; started: number }>();
  private blender: BlenderRuntime;
  constructor(
    readonly root: string,
    private runtimeRoot: string,
    private runtimeUrl: () => string,
    private preload: string,
    private log: (message: string) => void = () => {},
  ) {
    this.blender = new BlenderRuntime(runtimeRoot, os.homedir());
  }
  private trace(jobId: string, phase: string) {
    const entry = this.phases.get(jobId);
    if (!entry) return;
    entry.phase = phase;
    this.log(`job ${jobId} ${phase} +${Date.now() - entry.started}ms`);
  }
  private stopJob(jobId: string) {
    this.cancelled.add(jobId);
    // Cancellations can arrive before dispatch or after completion; bound this tombstone.
    const expires = setTimeout(() => this.cancelled.delete(jobId), 180_000);
    expires.unref();
    this.compilers.get(jobId)?.();
    return this.blender.cancel(jobId);
  }
  async start() {
    this.server = http.createServer((request, response) => {
      const incoming = Buffer.from(request.headers.authorization ?? ""),
        expected = Buffer.from("Bearer " + this.token);
      if (
        request.method !== "POST" ||
        incoming.length !== expected.length ||
        !timingSafeEqual(incoming, expected)
      ) {
        response.writeHead(401).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16_384) request.destroy();
      });
      request.on("end", () => {
        void (async () => {
          try {
            const result = await this.handle(request.url?.slice(1) ?? "", JSON.parse(body || "{}"));
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(result));
          } catch (error) {
            response
              .writeHead(400, { "content-type": "application/json" })
              .end(JSON.stringify({ error: modelErrorText(error) }));
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.pipe, resolve);
    });
    if (process.platform !== "win32") await fs.chmod(this.pipe, 0o600);
  }
  private async handle(method: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === "environment") return this.blender.environment();
    if (method === "prepare-runtime") return this.blender.prepare();
    if (method === "check-runtime") return this.blender.check();
    if (method === "blender-settings") {
      const settings: { blenderPath?: string; uvxPath?: string } = {};
      for (const key of ["blenderPath", "uvxPath"] as const)
        if (input[key] !== undefined) {
          if (typeof input[key] !== "string") throw new Error("Invalid executable path.");
          if (input[key] === ":choose:") {
            const selection = await dialog.showOpenDialog({
              title: key === "blenderPath" ? "Choose Blender executable" : "Choose uvx executable",
              properties: ["openFile"],
            });
            if (!selection.canceled && selection.filePaths[0])
              settings[key] = selection.filePaths[0];
          } else settings[key] = input[key];
        }
      return this.blender.configure(settings);
    }
    if (method === "cancel") {
      const jobId = id(input.jobId);
      this.log(`job ${jobId} cancel requested`);
      await this.stopJob(jobId);
      return {};
    }
    const projectId = id(input.projectId);
    const projectFile = await modelPath(this.root, projectId, "project.json");
    const project = Schema.decodeUnknownSync(Model3DProject)(
      JSON.parse(await fs.readFile(projectFile, "utf8")),
    );
    if (project.id !== projectId) throw new Error("Model project identity mismatch.");
    if (method === "texture") {
      const selection = await dialog.showOpenDialog({
        title: "Import a local PBR texture",
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return { texture: null };
      const selected = selection.filePaths[0];
      if ((await fs.stat(selected)).size > 32 * 1024 * 1024)
        throw new Error("Texture exceeds 32 MiB.");
      const image = sharp(await fs.readFile(selected), { limitInputPixels: 4096 * 4096 });
      const { data, info } = await image.rotate().png().toBuffer({ resolveWithObject: true });
      const textureId = sha(data);
      await atomicModelFile(
        await modelPath(this.root, projectId, "textures", textureId + ".png"),
        data,
      );
      return {
        texture: {
          id: textureId,
          name: path.basename(selected),
          width: info.width,
          height: info.height,
        },
      };
    }
    if (method === "export")
      return this.export(
        project,
        id(input.versionId),
        input.includeSource === true,
        input.target === "godot" ? "godot" : "generic",
      );
    if (method !== "build" && method !== "import")
      throw new Error("Unsupported model host operation.");
    return this.runJob(method, project, id(input.jobId));
  }
  private async runJob(method: "build" | "import", project: Model3DProject, jobId: string) {
    this.phases.set(jobId, { phase: "received", started: Date.now() });
    this.log(`job ${jobId} ${method} received`);
    let timer: NodeJS.Timeout | undefined, expire!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => (expire = reject));
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const phase = this.phases.get(jobId)?.phase ?? "unknown";
        void this.stopJob(jobId).catch(() => {});
        expire(
          new Error(
            `Model host did not finish within ${ms / 1000} s (stuck at: ${phase}). The task was stopped.`,
          ),
        );
      }, ms);
    };
    try {
      const result = await Promise.race([this.job(method, project, jobId, arm), expired]);
      this.trace(jobId, "done");
      return result;
    } catch (error) {
      this.trace(jobId, `failed: ${modelErrorText(error).split("\n")[0]}`);
      throw error;
    } finally {
      clearTimeout(timer);
      this.phases.delete(jobId);
    }
  }
  private async job(
    method: "build" | "import",
    project: Model3DProject,
    jobId: string,
    arm: (ms: number) => void,
  ) {
    const projectId = project.id,
      job = project.jobs.find((j) => j.id === jobId);
    if (!job || !["queued", "running"].includes(job.status))
      throw new Error("Model task is not active.");
    this.trace(jobId, "reading input");
    const directory = await modelPath(this.root, projectId, "jobs", jobId);
    const frozen = JSON.parse(
      await fs.readFile(await modelPath(directory, "input.json"), "utf8"),
    ) as { build: unknown; parent: Model3DVersion | null; textures: Model3DProject["textures"] };
    const build = Schema.decodeUnknownSync(Model3DBuild)(frozen.build);
    if (Buffer.byteLength(build.source) > MODEL3D_LIMITS.sourceBytes)
      throw new Error("Model source exceeds 1 MiB.");
    if (method === "build")
      arm(build.mode === "blender" ? BUILD_DEADLINE_MS.blender : BUILD_DEADLINE_MS.threejs);
    const parent = build.parentVersionId
      ? project.versions.find((v) => v.id === build.parentVersionId)
      : null;
    if (build.parentVersionId && (!parent || frozen.parent?.id !== parent.id))
      throw new Error("Parent model identity mismatch.");
    let modelInput: Uint8Array | null = null;
    if (parent && (!build.source.trim() || build.mode === "blender")) {
      modelInput = await readModel(
        await modelPath(this.root, projectId, "versions", parent.id, "model.glb"),
      );
      if (sha(modelInput) !== parent.hash) throw new Error("Parent model checksum mismatch.");
    }
    if (method === "import") {
      // The deadline starts after the dialog: choosing a file is the user's time, not the host's.
      this.trace(jobId, "waiting for import selection");
      const selection = await dialog.showOpenDialog({
        title: "Import GLB or a complete glTF package",
        properties: ["openFile"],
        filters: [{ name: "3D models", extensions: ["glb", "gltf"] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
      arm(BUILD_DEADLINE_MS.threejs);
      this.trace(jobId, "reading import");
      modelInput = await importModelFile(selection.filePaths[0]);
    }
    let hasBlend = false;
    const textureFiles = await Promise.all(
      frozen.textures.map(async (t) => ({
        id: t.id,
        name: t.name,
        file: await modelPath(this.root, projectId, "textures", id(t.id) + ".png"),
      })),
    );
    try {
      if (build.mode === "blender" && method !== "import") {
        this.trace(jobId, "running Blender");
        await this.blender.build({
          projectId,
          jobId,
          directory,
          build,
          parentBlend: parent?.hasBlend
            ? await modelPath(this.root, projectId, "versions", parent.id, "model.blend")
            : null,
          parentGlb: parent
            ? await modelPath(this.root, projectId, "versions", parent.id, "model.glb")
            : null,
          textures: textureFiles,
        });
        modelInput = await readModel(await modelPath(directory, "blender-output.glb"));
        hasBlend = true;
      }
      if (this.cancelled.has(jobId)) throw new Error("Model task cancelled.");
      if (modelInput && modelInput.length > MODEL3D_LIMITS.fileBytes)
        throw new Error("Model exceeds 100 MiB.");
      this.trace(jobId, "reading textures");
      const result = await this.compile({
        id: jobId,
        build: hasBlend ? { ...build, materialEdits: [] } : build,
        input: modelInput,
        textures: await Promise.all(
          textureFiles.map(async (t) => {
            const bytes = await fs.readFile(t.file);
            if (sha(bytes) !== t.id) throw new Error("Texture checksum mismatch.");
            return { id: t.id, name: t.name, bytes };
          }),
        ),
      });
      if (this.cancelled.has(jobId)) throw new Error("Model task cancelled.");
      if (hasBlend) {
        const check = JSON.parse(
          await fs.readFile(await modelPath(directory, "blender-check.json"), "utf8"),
        ) as { warnings: string[] };
        result.report = {
          ...result.report,
          warnings: [...new Set([...result.report.warnings, ...check.warnings])],
        };
      }
      this.trace(jobId, "writing output");
      await atomicModelFile(await modelPath(directory, "model.glb"), result.bytes);
      await atomicModelFile(await modelPath(directory, "thumbnail.png"), result.thumbnail);
      return {
        report: result.report,
        hasBlend,
        runtime: {
          three: MODEL3D_LIMITS.threeVersion,
          blenderMcp: MODEL3D_LIMITS.blenderMcpVersion,
          blender: hasBlend ? (await this.blender.environment()).blenderVersion : null,
        },
      };
    } finally {
      this.cancelled.delete(jobId);
    }
  }
  private async compile(task: CompilerTask): Promise<CompilerResult> {
    this.trace(task.id, "opening compiler");
    const window = new BrowserWindow({
      show: false,
      width: 512,
      height: 512,
      webPreferences: {
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        partition: `aha-model3d-${task.id}`,
      },
    });
    const url = this.runtimeUrl();
    const target = new URL(url);
    const compilerSession = window.webContents.session;
    compilerSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    compilerSession.setPermissionCheckHandler(() => false);
    let ready = false;
    compilerSession.webRequest.onBeforeRequest((details, callback) => {
      const requested = new URL(details.url);
      const staticRequest =
        !ready &&
        requested.origin === target.origin &&
        (/\.(?:js|ts|html|css)(?:$|\?)/.test(requested.pathname) ||
          requested.pathname.startsWith("/@") ||
          requested.pathname.startsWith("/node_modules/"));
      callback({
        cancel: !(
          requested.protocol === "blob:" ||
          requested.protocol === "data:" ||
          staticRequest
        ),
      });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, destination) => {
      if (destination !== url) event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const compilerMessages: string[] = [];
    window.webContents.on("console-message", (details) => {
      if (details.level === "error") compilerMessages.push(details.message.slice(0, 2000));
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "Model compiler timed out. The isolated process was terminated. " +
                compilerMessages.slice(-3).join("\n"),
            ),
          ),
        60_000,
      );
      const finish = (error?: Error, result?: CompilerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ipcMain.off("model3d:ready", onReady);
        ipcMain.off("model3d:complete", onComplete);
        this.compilers.delete(task.id);
        if (!window.isDestroyed()) window.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      const onReady = (event: Electron.IpcMainEvent) => {
        if (event.sender !== window.webContents) return;
        ready = true;
        this.trace(task.id, "compiling");
        window.webContents.send("model3d:task", task);
      };
      const onComplete = (event: Electron.IpcMainEvent, value: unknown) => {
        if (event.sender !== window.webContents) return;
        this.trace(task.id, "checking compiler output");
        try {
          const data = value as {
            id?: string;
            error?: string;
            bytes?: Uint8Array;
            report?: unknown;
            thumbnail?: string;
          };
          if (data.id !== task.id) throw new Error("Compiler task identity mismatch.");
          if (data.error) throw new Error(data.error);
          if (
            !(data.bytes instanceof Uint8Array) ||
            data.bytes.length > MODEL3D_LIMITS.fileBytes ||
            data.bytes.length < 20
          )
            throw new Error("Invalid compiled model file.");
          const report = Schema.decodeUnknownSync(Model3DValidationReport)(data.report);
          if (report.errors.length || report.triangles > MODEL3D_LIMITS.triangles)
            throw new Error(report.errors.join("\n") || "Model exceeds triangle limit.");
          if (typeof data.thumbnail !== "string" || data.thumbnail.length > 4 * 1024 * 1024)
            throw new Error("Invalid model thumbnail.");
          finish(undefined, {
            bytes: data.bytes,
            report,
            thumbnail: Buffer.from(data.thumbnail, "base64"),
          });
        } catch (error) {
          finish(new Error(modelErrorText(error)));
        }
      };
      ipcMain.on("model3d:ready", onReady);
      ipcMain.on("model3d:complete", onComplete);
      this.compilers.set(task.id, () => finish(new Error("Model task cancelled.")));
      window.webContents.once("render-process-gone", () =>
        finish(new Error("The isolated model compiler stopped.")),
      );
      this.trace(task.id, "loading compiler page");
      void window.loadURL(url).catch((error: unknown) => finish(new Error(modelErrorText(error))));
    });
  }
  private async export(
    project: Model3DProject,
    versionId: string,
    includeSource: boolean,
    target: "godot" | "generic",
  ) {
    const version = project.versions.find((v) => v.id === versionId);
    if (!version || versionId !== project.adoptedVersionId)
      throw new Error("Only the adopted model version can be exported.");
    const bytes = await readModel(
      await modelPath(this.root, project.id, "versions", versionId, "model.glb"),
    );
    if (sha(bytes) !== version.hash || version.report.errors.length)
      throw new Error("Model validation failed.");
    const selection = await dialog.showOpenDialog({
      title: "Choose an export directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return {};
    const name = project.name.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80) || "model";
    const parent = await fs.realpath(selection.filePaths[0]);
    const destination = path.join(parent, `${name}-${version.name}-${randomUUID().slice(0, 8)}`),
      temporary = path.join(parent, `.aha-model-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      await atomicModelFile(path.join(temporary, "model.glb"), bytes);
      await fs.copyFile(
        await modelPath(this.root, project.id, "versions", versionId, "thumbnail.png"),
        path.join(temporary, "thumbnail.png"),
      );
      await atomicModelFile(
        path.join(temporary, "validation.json"),
        JSON.stringify(version.report, null, 2),
      );
      await atomicModelFile(
        path.join(temporary, "asset.json"),
        JSON.stringify(
          {
            format: 1,
            name: project.name,
            projectId: project.id,
            versionId,
            sha256: version.hash,
            target,
            units: "meters",
            upAxis: "Y",
            pivot: "bottom-center",
            lod: "not-provided",
            collision: "not-provided",
            source: version.build.mode,
            dependencies: version.runtime ?? {
              three: MODEL3D_LIMITS.threeVersion,
              blenderMcp: MODEL3D_LIMITS.blenderMcpVersion,
            },
          },
          null,
          2,
        ),
      );
      if (includeSource) {
        const history: Model3DVersion[] = [];
        let ancestor: Model3DVersion | undefined = version;
        while (ancestor && history.length <= project.versions.length) {
          history.unshift(ancestor);
          if (!ancestor.build.parentVersionId) break;
          ancestor = project.versions.find((v) => v.id === ancestor!.build.parentVersionId);
        }
        const source =
          history.toReversed().find((v) => v.build.mode === version.build.mode && v.build.source)
            ?.build.source ?? "";
        await atomicModelFile(
          path.join(temporary, "build.json"),
          JSON.stringify({ ...version.build, source }, null, 2),
        );
        await atomicModelFile(
          path.join(temporary, "history.json"),
          JSON.stringify(
            history.map((v) => ({ id: v.id, hash: v.hash, build: v.build, runtime: v.runtime })),
            null,
            2,
          ),
        );
        await atomicModelFile(
          path.join(temporary, version.build.mode === "blender" ? "source.py" : "source.js"),
          source,
        );
        const textureIds = new Set(
          history.flatMap((v) =>
            v.build.materialEdits.flatMap((edit) =>
              [edit.baseColor, edit.normal, edit.roughnessMap, edit.metalnessMap].filter(
                (id): id is string => !!id,
              ),
            ),
          ),
        );
        if (textureIds.size) {
          await fs.mkdir(path.join(temporary, "textures"));
          for (const textureId of textureIds)
            await fs.copyFile(
              await modelPath(this.root, project.id, "textures", id(textureId) + ".png"),
              path.join(temporary, "textures", textureId + ".png"),
            );
        }
        if (version.hasBlend)
          await fs.copyFile(
            await modelPath(this.root, project.id, "versions", versionId, "model.blend"),
            path.join(temporary, "model.blend"),
          );
      }
      await fs.rename(temporary, destination);
      return { exportPath: destination };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async dispose() {
    for (const cancel of this.compilers.values()) cancel();
    const server = this.server;
    this.server = null;
    // close() waits for in-flight requests; a stuck build must not hold quit open.
    const closed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    server?.closeAllConnections();
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.all([this.blender.stop().catch(() => {}), closed]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), DISPOSE_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) this.log(`dispose did not finish within ${DISPOSE_DEADLINE_MS / 1000} s`);
    if (process.platform !== "win32") await fs.rm(this.pipe, { force: true }).catch(() => {});
  }
}

export async function importModelFile(file: string): Promise<Uint8Array> {
  const stat = await fs.stat(file);
  if (stat.size > MODEL3D_LIMITS.fileBytes) throw new Error("Model exceeds 100 MiB.");
  if (path.extname(file).toLowerCase() === ".glb") return fs.readFile(file);
  if (path.extname(file).toLowerCase() !== ".gltf") throw new Error("Import a GLB or glTF file.");
  const base = await fs.realpath(path.dirname(file));
  const data = JSON.parse(await fs.readFile(file, "utf8")) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
  let total = stat.size;
  for (const item of [...(data.buffers ?? []), ...(data.images ?? [])]) {
    if (!item.uri) continue;
    if (item.uri.startsWith("data:")) {
      total += item.uri.length;
      continue;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(item.uri);
    } catch {
      throw new Error("Invalid glTF resource path.");
    }
    if (
      /^[a-z][a-z\d+.-]*:|[\\?#]/i.test(relative) ||
      relative.includes("\0") ||
      path.isAbsolute(relative)
    )
      throw new Error("Remote and absolute glTF resources are not downloaded.");
    const resource = await fs.realpath(path.resolve(base, relative));
    if (!resource.startsWith(base + path.sep))
      throw new Error("glTF resource escapes its import directory.");
    total += (await fs.stat(resource)).size;
    if (total > MODEL3D_LIMITS.fileBytes) throw new Error("Complete glTF package exceeds 100 MiB.");
    const bytes = await fs.readFile(resource);
    const extension = path.extname(resource).toLowerCase();
    if (![".bin", ".png", ".jpg", ".jpeg"].includes(extension))
      throw new Error("Unsupported glTF resource: " + extension);
    item.uri = `data:${extension === ".png" ? "image/png" : extension === ".bin" ? "application/octet-stream" : "image/jpeg"};base64,${bytes.toString("base64")}`;
  }
  const output = new TextEncoder().encode(JSON.stringify(data));
  if (output.length > MODEL3D_LIMITS.fileBytes * 1.4)
    throw new Error("glTF package exceeds capacity.");
  return output;
}
