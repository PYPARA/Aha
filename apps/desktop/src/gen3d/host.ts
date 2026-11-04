import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import sharp from "sharp";
import { Schema } from "effect";
import {
  Gen3DBuild,
  Gen3DProcessReport,
  Gen3DProject,
  GEN3D_EXPORT_PRESETS,
  GEN3D_LIMITS,
  GEN3D_VIEWS,
  Model3DValidationReport,
  type Gen3DExportFormat,
} from "@synara/contracts";
import { atomicModelFile, modelErrorText, modelPath } from "@synara/shared/model3dFiles";
import type { BlenderRuntime } from "../model3d/blender";
import { GEN3D_BLENDER_PRELUDE, mapBlenderError } from "./blenderPrelude";
import { GEN3D_CONVERT_SCRIPT, GEN3D_PROCESS_SCRIPT } from "./blenderScripts";

const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid 3D generation identity.");
  return value;
};
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
// Builds must answer before the server's request timeout gives up on them (180 s for
// Three.js; the Blender route also waits for the shared lock and starts Blender).
const BUILD_DEADLINE_MS = {
  threejs: 120_000,
  blender: GEN3D_LIMITS.blenderWaitMs + GEN3D_LIMITS.blenderBuildMs + 60_000,
  process: GEN3D_LIMITS.processMs + 60_000,
} as const;
/** Derived files an optimized version carries next to model.glb. */
const PROCESS_FILES = ["lod1.glb", "lod2.glb", "lod3.glb", "collision.glb"] as const;
const EXPORT_PRESETS = ["generic", "godot", "unity", "unreal"] as const;
const EXPORT_FORMATS = ["glb", "fbx", "obj", "usdz", "stl"] as const;
const BLENDER_BUSY = /^Another Blender modeling task is running/;
const DISPOSE_DEADLINE_MS = 5_000;
const RENDERS = {
  thumbnail: "thumbnail.png",
  "34": "render-34.png",
  front: "render-front.png",
  side: "render-side.png",
  back: "render-back.png",
} as const;
interface CompilerTask {
  id: string;
  source: string;
  /** A GLB built elsewhere (Blender) to inspect, score and render instead of running source. */
  input: Uint8Array | null;
  skeleton: readonly unknown[] | null;
  pxPerMetre: number | null;
  timeoutMs: number;
}
interface CompilerResult {
  bytes: Uint8Array;
  report: typeof Model3DValidationReport.Type;
  topology: { boundaryEdges: number; nonManifoldEdges: number };
  silhouettes: Partial<Record<(typeof GEN3D_VIEWS)[number], Buffer>>;
  renders: Record<keyof typeof RENDERS, Buffer>;
}
const base64Png = (value: unknown, what: string) => {
  if (typeof value !== "string" || value.length > 8 * 1024 * 1024)
    throw new Error(`Invalid ${what}.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error(`Invalid ${what}.`);
  return bytes;
};

export class Gen3DHost {
  readonly token = randomBytes(32).toString("hex");
  readonly pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\aha-gen3d-${process.pid}-${randomUUID()}`
      : path.join(os.tmpdir(), `aha-g3d-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
  private server: http.Server | null = null;
  private compilers = new Map<string, () => void>();
  private cancelled = new Set<string>();
  private headless = new Map<string, ChildProcess>();
  /** Fixed scripts run one at a time; each is a separate background Blender process. */
  private headlessQueue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private runtimeUrl: () => string,
    private preload: string,
    private log: (message: string) => void = () => {},
    private blender: () => BlenderRuntime | null = () => null,
  ) {}
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
    if (method === "environment")
      return { desktop: true, error: null, blender: await this.blenderStatus() };
    if (method === "cancel") {
      const jobId = id(input.jobId);
      this.cancelled.add(jobId);
      setTimeout(() => this.cancelled.delete(jobId), 600_000).unref();
      this.compilers.get(jobId)?.();
      this.headless.get(jobId)?.kill("SIGKILL");
      await this.blender()?.cancel(jobId);
      return {};
    }
    const projectId = id(input.projectId);
    const project = Schema.decodeUnknownSync(Gen3DProject)(
      JSON.parse(await fs.readFile(await modelPath(this.root, projectId, "project.json"), "utf8")),
    );
    if (project.id !== projectId) throw new Error("3D project identity mismatch.");
    if (method === "add-reference") return this.addReference(projectId);
    if (method === "export") {
      const preset = EXPORT_PRESETS.find((p) => p === (input.preset ?? "generic"));
      const format = EXPORT_FORMATS.find(
        (f) => f === (input.format ?? GEN3D_EXPORT_PRESETS[preset!]),
      );
      if (!preset || !format) throw new Error("Unsupported export preset or format.");
      return this.export(project, id(input.versionId), preset, format);
    }
    if (method !== "build") throw new Error("Unsupported 3D generation host operation.");
    const pxPerMetre = input.pxPerMetre === null ? null : Number(input.pxPerMetre);
    if (pxPerMetre !== null && !(Number.isFinite(pxPerMetre) && pxPerMetre > 0))
      throw new Error("Invalid blueprint scale.");
    return this.build(project, id(input.jobId), pxPerMetre);
  }
  private async blenderStatus() {
    const runtime = this.blender();
    if (!runtime)
      return { ready: false, version: null, error: "The 3D workshop host is unavailable." };
    try {
      const environment = await runtime.environment();
      return {
        ready: !environment.error && environment.prepared,
        headless: !!environment.blenderPath,
        version: environment.blenderVersion,
        error:
          environment.error ??
          (environment.prepared ? null : "Prepare the Blender runtime in the 3D workshop."),
      };
    } catch (error) {
      return { ready: false, version: null, error: modelErrorText(error) };
    }
  }
  /** Runs AI Blender Python through the workshop runtime and returns the GLB it published. */
  private async blenderBuild(
    project: Gen3DProject,
    jobId: string,
    directory: string,
    build: Gen3DBuild,
  ) {
    const runtime = this.blender();
    if (!runtime) throw new Error("Blender is unavailable: the 3D workshop host did not start.");
    const input = {
      projectId: project.id,
      jobId,
      directory,
      build: {
        mode: "blender" as const,
        source: GEN3D_BLENDER_PRELUDE + build.source,
        parameters: build.skeleton ? { skeleton: JSON.stringify(build.skeleton) } : {},
        parameterDefinitions: [],
        parentVersionId: null,
        prompt: build.prompt,
        materialEdits: [],
      },
      // Every round rebuilds from its full source, so the scene always starts empty.
      parentBlend: null,
      parentGlb: null,
      textures: [],
    };
    // One Blender lock spans both workbenches; wait for the other task instead of failing a round.
    const waitUntil = Date.now() + GEN3D_LIMITS.blenderWaitMs;
    for (;;) {
      if (this.cancelled.has(jobId)) throw new Error("3D task cancelled.");
      try {
        await runtime.build(input);
        break;
      } catch (error) {
        if (!(error instanceof Error && BLENDER_BUSY.test(error.message)) || Date.now() > waitUntil)
          throw new Error(mapBlenderError(modelErrorText(error)), { cause: error });
        this.log(`job ${jobId} waiting for Blender`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    const file = await modelPath(directory, "blender-output.glb");
    if ((await fs.stat(file)).size > GEN3D_LIMITS.fileBytes)
      throw new Error("Model exceeds 200 MiB.");
    const bytes = new Uint8Array(await fs.readFile(file));
    const check = JSON.parse(
      await fs.readFile(await modelPath(directory, "blender-check.json"), "utf8").catch(() => "{}"),
    ) as { warnings?: unknown };
    // The runtime page reports missing UVs per glTF node; Blender's own check repeats them
    // under Blender object names, which differ (`Ear_0049` vs `Ear 0.049`) and would not dedupe.
    const warnings = Array.isArray(check.warnings)
      ? check.warnings.filter(
          (w): w is string => typeof w === "string" && !w.endsWith("UV coordinates are missing."),
        )
      : [];
    return { bytes, warnings, version: (await runtime.environment()).blenderVersion };
  }
  /**
   * Runs one of Aha's fixed scripts in background Blender. Only Aha's scripts and a JSON config
   * reach this process; it never executes AI source.
   */
  private async runFixedScript(
    kind: "process" | "convert",
    directory: string,
    config: Record<string, unknown>,
    taskId: string,
  ) {
    const blenderPath = (await this.blender()?.environment())?.blenderPath;
    if (!blenderPath) throw new Error("Blender was not found. Set it up in the 3D workshop.");
    const run = async () => {
      if (this.cancelled.has(taskId)) throw new Error("3D task cancelled.");
      const script = path.join(directory, `aha-${kind}.py`),
        configFile = path.join(directory, `aha-${kind}.json`);
      await atomicModelFile(
        script,
        kind === "process" ? GEN3D_PROCESS_SCRIPT : GEN3D_CONVERT_SCRIPT,
      );
      await atomicModelFile(configFile, JSON.stringify(config));
      await fs.mkdir(path.join(directory, "tmp"), { recursive: true });
      const log = await fs.open(path.join(directory, `blender-${kind}.log`), "w");
      const child = spawn(
        blenderPath,
        [
          "-b",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python",
          script,
          "--",
          configFile,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: os.homedir(),
            TMPDIR: path.join(directory, "tmp"),
            BLENDER_USER_CONFIG: path.join(directory, "tmp", "config"),
            BLENDER_USER_SCRIPTS: path.join(directory, "tmp", "scripts"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.headless.set(taskId, child);
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-200_000);
        void log.write(chunk).catch(() => {});
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), GEN3D_LIMITS.processMs);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });
        if (this.cancelled.has(taskId)) throw new Error("3D task cancelled.");
        const marker = output.match(new RegExp(`AHA_${kind.toUpperCase()}=(\\{[^\\n]+\\})`))?.[1];
        if (code !== 0 || !marker) {
          const detail = output
            .match(/(?:Error|RuntimeError|TypeError|ValueError)[^\n]*/g)
            ?.slice(-2)
            .join("\n");
          throw new Error(
            `Blender ${kind === "process" ? "optimization" : "export"} failed${detail ? ": " + detail : "."} See ${path.basename(directory)}/blender-${kind}.log.`,
          );
        }
        return JSON.parse(marker) as unknown;
      } finally {
        this.headless.delete(taskId);
        await log.close().catch(() => {});
        await fs.rm(path.join(directory, "tmp"), { recursive: true, force: true });
      }
    };
    const queued = this.headlessQueue.then(run, run);
    this.headlessQueue = queued.catch(() => {});
    return queued;
  }
  /** Optimizes the parent version: repair, decimate, UV, bake, LODs and collision. */
  private async processBuild(
    project: Gen3DProject,
    jobId: string,
    directory: string,
    build: Gen3DBuild,
  ) {
    const parent = project.versions.find((v) => v.id === build.parentVersionId);
    if (!parent || !build.process) throw new Error("Choose a version to optimize.");
    const parentGlb = await modelPath(this.root, project.id, "versions", parent.id, "model.glb");
    const bytes = await fs.readFile(parentGlb);
    if (sha(bytes) !== parent.hash) throw new Error("Parent model checksum mismatch.");
    const input = await modelPath(directory, "input.glb");
    await atomicModelFile(input, bytes);
    try {
      let projection: Record<string, unknown> | null = null;
      if (build.process.texture === "projection") {
        const blueprint = project.blueprint,
          score = parent.score;
        if (!blueprint || !score) throw new Error("Reference projection needs a scored version.");
        projection = {
          reference: await modelPath(
            this.root,
            project.id,
            "references",
            blueprint.referenceId + ".png",
          ),
          masks: Object.fromEntries(
            await Promise.all(
              GEN3D_VIEWS.map(async (view) => [
                view,
                await modelPath(this.root, project.id, "blueprint", view + ".png"),
              ]),
            ),
          ),
          boxes: blueprint.boxes,
          pxPerMetre: blueprint.pxPerMetre,
          // The score's registration, so paint lands where the diff images say the shape is.
          views: Object.fromEntries(
            GEN3D_VIEWS.map((view) => [
              view,
              { dx: score.views[view].shiftPx, mirrored: score.views[view].mirrored === true },
            ]),
          ),
        };
      }
      const raw = await this.runFixedScript(
        "process",
        directory,
        { input, output: directory, process: build.process, ...(projection ? { projection } : {}) },
        jobId,
      );
      const report = Schema.decodeUnknownSync(Gen3DProcessReport)(raw);
      for (const file of [
        ...report.lods.map((l) => l.file),
        ...(report.collision ? [report.collision.file] : []),
      ])
        if (!PROCESS_FILES.includes(file as (typeof PROCESS_FILES)[number]))
          throw new Error("Unexpected optimization output.");
      const model = await modelPath(directory, "model.glb");
      if ((await fs.stat(model)).size > GEN3D_LIMITS.fileBytes)
        throw new Error("Model exceeds 200 MiB.");
      return { bytes: new Uint8Array(await fs.readFile(model)), report };
    } finally {
      await fs.rm(input, { force: true });
    }
  }
  private async addReference(projectId: string) {
    const selection = await dialog.showOpenDialog({
      title: "Choose a three-view reference image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { reference: null };
    const selected = selection.filePaths[0];
    if ((await fs.stat(selected)).size > GEN3D_LIMITS.referenceBytes)
      throw new Error("Reference image exceeds 32 MiB.");
    const { data, info } = await sharp(await fs.readFile(selected), {
      limitInputPixels: 4096 * 4096,
      failOn: "error",
    })
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    // Same identity rule as the server's drawing import: the normalized PNG's digest.
    const referenceId = sha(data).slice(0, 32);
    await atomicModelFile(
      await modelPath(this.root, projectId, "references", referenceId + ".png"),
      data,
    );
    return {
      reference: {
        id: referenceId,
        name: path.basename(selected).slice(0, 200),
        width: info.width,
        height: info.height,
        origin: "upload",
        imageJobId: null,
        createdAt: new Date().toISOString(),
      },
    };
  }
  private async build(project: Gen3DProject, jobId: string, pxPerMetre: number | null) {
    const job = project.jobs.find((j) => j.id === jobId);
    if (!job || !["queued", "running"].includes(job.status))
      throw new Error("3D task is not active.");
    const directory = await modelPath(this.root, project.id, "jobs", jobId);
    const frozen = JSON.parse(
      await fs.readFile(await modelPath(directory, "input.json"), "utf8"),
    ) as { build: unknown };
    const build = Schema.decodeUnknownSync(Gen3DBuild)(frozen.build);
    if (Buffer.byteLength(build.source) > GEN3D_LIMITS.sourceBytes)
      throw new Error("Model source exceeds 1 MiB.");
    const started = Date.now(),
      mode = build.mode ?? "threejs",
      deadline = BUILD_DEADLINE_MS[mode];
    this.log(`job ${jobId} ${mode} build received`);
    let timer: NodeJS.Timeout | undefined;
    const blender = { used: false, warnings: [] as string[], version: null as string | null };
    let processed: { bytes: Uint8Array; report: typeof Gen3DProcessReport.Type } | null = null;
    try {
      const result = await Promise.race([
        (async () => {
          let input: Uint8Array | null = null;
          if (mode === "process") {
            processed = await this.processBuild(project, jobId, directory, build);
            this.log(`job ${jobId} optimization done +${Date.now() - started}ms`);
            input = processed.bytes;
            blender.version = (await this.blender()?.environment())?.blenderVersion ?? null;
            blender.used = true;
          } else if (mode === "blender") {
            const built = await this.blenderBuild(project, jobId, directory, build);
            this.log(`job ${jobId} Blender done +${Date.now() - started}ms`);
            input = built.bytes;
            Object.assign(blender, {
              used: true,
              warnings: built.warnings,
              version: built.version,
            });
          }
          if (this.cancelled.has(jobId)) throw new Error("3D task cancelled.");
          return this.compile({
            id: jobId,
            source: input ? "" : build.source,
            input,
            skeleton: build.skeleton ?? null,
            pxPerMetre,
            timeoutMs: GEN3D_LIMITS.buildTimeoutMs,
          });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.compilers.get(jobId)?.();
            this.headless.get(jobId)?.kill("SIGKILL");
            void this.blender()?.cancel(jobId);
            reject(
              new Error(
                `3D build did not finish within ${deadline / 1000} s. The task was stopped.`,
              ),
            );
          }, deadline);
        }),
      ]);
      if (this.cancelled.has(jobId)) throw new Error("3D task cancelled.");
      if (blender.used)
        result.report = {
          ...result.report,
          warnings: [...new Set([...result.report.warnings, ...blender.warnings])],
        };
      // An optimized GLB is published as Blender wrote it (packed ORM map, tangents); the
      // runtime page only inspects, scores and renders it. Other routes publish its export.
      const published = (processed as { bytes: Uint8Array } | null)?.bytes ?? result.bytes;
      await atomicModelFile(await modelPath(directory, "model.glb"), published);
      for (const [shot, name] of Object.entries(RENDERS))
        await atomicModelFile(
          await modelPath(directory, name),
          result.renders[shot as keyof typeof RENDERS],
        );
      for (const view of GEN3D_VIEWS) {
        const silhouette = result.silhouettes[view];
        if (silhouette)
          await atomicModelFile(await modelPath(directory, `sil-${view}.png`), silhouette);
      }
      // Only the GLB and checkpoint are kept; Blender's intermediate export is not a version file.
      await fs.rm(await modelPath(directory, "blender-output.glb"), { force: true });
      this.log(`job ${jobId} done +${Date.now() - started}ms`);
      return {
        report: result.report,
        topology: result.topology,
        ...(blender.used ? { blender: blender.version } : {}),
        ...(processed ? { process: (processed as { report: unknown }).report } : {}),
      };
    } catch (error) {
      this.log(`job ${jobId} failed: ${modelErrorText(error).split("\n")[0]}`);
      throw error;
    } finally {
      clearTimeout(timer);
      this.cancelled.delete(jobId);
    }
  }
  private async compile(task: CompilerTask): Promise<CompilerResult> {
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
        partition: `aha-gen3d-${task.id}`,
      },
    });
    const url = this.runtimeUrl(),
      target = new URL(url),
      compilerSession = window.webContents.session;
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
    const messages: string[] = [];
    window.webContents.on("console-message", (details) => {
      if (details.level === "error") messages.push(details.message.slice(0, 2000));
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "3D compiler timed out. The isolated process was terminated. " +
                messages.slice(-3).join("\n"),
            ),
          ),
        task.timeoutMs + 30_000,
      );
      const finish = (error?: Error, result?: CompilerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ipcMain.off("gen3d:ready", onReady);
        ipcMain.off("gen3d:complete", onComplete);
        this.compilers.delete(task.id);
        if (!window.isDestroyed()) window.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      const onReady = (event: Electron.IpcMainEvent) => {
        if (event.sender !== window.webContents) return;
        ready = true;
        window.webContents.send("gen3d:task", task);
      };
      const onComplete = (event: Electron.IpcMainEvent, value: unknown) => {
        if (event.sender !== window.webContents) return;
        try {
          const data = value as {
            id?: string;
            error?: string;
            bytes?: Uint8Array;
            report?: unknown;
            topology?: { boundaryEdges?: unknown; nonManifoldEdges?: unknown };
            silhouettes?: Record<string, unknown>;
            renders?: Record<string, unknown>;
          };
          if (data.id !== task.id) throw new Error("Compiler task identity mismatch.");
          if (data.error) throw new Error(data.error);
          if (
            !(data.bytes instanceof Uint8Array) ||
            data.bytes.length > GEN3D_LIMITS.fileBytes ||
            data.bytes.length < 20
          )
            throw new Error("Invalid compiled model file.");
          const report = Schema.decodeUnknownSync(Model3DValidationReport)(data.report);
          if (report.errors.length || report.triangles > GEN3D_LIMITS.triangles)
            throw new Error(report.errors.join("\n") || "Model exceeds the triangle limit.");
          const boundaryEdges = Number(data.topology?.boundaryEdges),
            nonManifoldEdges = Number(data.topology?.nonManifoldEdges);
          if (!Number.isSafeInteger(boundaryEdges) || !Number.isSafeInteger(nonManifoldEdges))
            throw new Error("Invalid model topology.");
          const silhouettes: CompilerResult["silhouettes"] = {};
          if (task.pxPerMetre)
            for (const view of GEN3D_VIEWS)
              silhouettes[view] = base64Png(data.silhouettes?.[view], "silhouette");
          const renders = {} as CompilerResult["renders"];
          for (const shot of Object.keys(RENDERS) as (keyof typeof RENDERS)[])
            renders[shot] = base64Png(data.renders?.[shot], "render");
          finish(undefined, {
            bytes: data.bytes,
            report,
            topology: { boundaryEdges, nonManifoldEdges },
            silhouettes,
            renders,
          });
        } catch (error) {
          finish(new Error(modelErrorText(error)));
        }
      };
      ipcMain.on("gen3d:ready", onReady);
      ipcMain.on("gen3d:complete", onComplete);
      this.compilers.set(task.id, () => finish(new Error("3D task cancelled.")));
      window.webContents.once("render-process-gone", () =>
        finish(new Error("The isolated 3D compiler stopped.")),
      );
      void window.loadURL(url).catch((error: unknown) => finish(new Error(modelErrorText(error))));
    });
  }
  private async export(
    project: Gen3DProject,
    versionId: string,
    preset: (typeof EXPORT_PRESETS)[number],
    format: Gen3DExportFormat,
  ) {
    const version = project.versions.find((v) => v.id === versionId);
    if (!version || versionId !== project.adoptedVersionId)
      throw new Error("Only the adopted version can be exported.");
    const versionFile = (name: string) =>
      modelPath(this.root, project.id, "versions", versionId, name);
    const bytes = await fs.readFile(await versionFile("model.glb"));
    if (sha(bytes) !== version.hash || version.report.errors.length)
      throw new Error("Model validation failed.");
    // Derived files are checked against the hashes recorded when the version was published.
    const derived = async (name: string) => {
      const record = version.files.find((f) => f.name === name);
      if (!record) return null;
      const file = await versionFile(name);
      if (sha(await fs.readFile(file)) !== record.hash)
        throw new Error(`${name} checksum mismatch.`);
      return file;
    };
    const lodFiles = (
      await Promise.all(PROCESS_FILES.filter((f) => f.startsWith("lod")).map(derived))
    ).filter((f): f is string => !!f);
    const collisionFile = await derived("collision.glb");
    const selection = await dialog.showOpenDialog({
      title: "Choose an export directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return {};
    const name = project.name.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80) || "model";
    // Engines and DCC tools expect plain object names inside FBX, OBJ and USD files.
    const assetName = project.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60) || "Asset";
    const parent = await fs.realpath(selection.filePaths[0]);
    const destination = path.join(parent, `${name}-${version.name}-${randomUUID().slice(0, 8)}`),
      temporary = path.join(parent, `.aha-gen3d-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      type Converted = { files: string[]; watertight?: boolean; openEdges?: number };
      let converted: Converted | null = null;
      // Godot reads collision from a "-colonly" node, so only that case needs a rewrite.
      if (format === "glb" && (preset !== "godot" || !collisionFile)) {
        await atomicModelFile(path.join(temporary, "model.glb"), bytes);
        for (const file of [...lodFiles, ...(collisionFile ? [collisionFile] : [])])
          await fs.copyFile(file, path.join(temporary, path.basename(file)));
      } else {
        const work = path.join(temporary, ".work");
        await fs.mkdir(work);
        converted = (await this.runFixedScript(
          "convert",
          work,
          {
            input: await versionFile("model.glb"),
            lods: lodFiles,
            collision: collisionFile,
            collisionKind: version.build.process?.collision ?? null,
            output: temporary,
            name: assetName,
            format,
            preset,
          },
          `export-${versionId}`,
        )) as Converted;
        await fs.rm(work, { recursive: true, force: true });
        // Godot reads LODs it generates itself; generic GLB extras stay as separate files.
        if (format === "glb") converted!.files = ["model.glb"];
      }
      for (const file of ["thumbnail.png", "render-34.png"])
        if (version.files.some((f) => f.name === file))
          await fs.copyFile(await versionFile(file), path.join(temporary, file));
      await atomicModelFile(
        path.join(temporary, "validation.json"),
        JSON.stringify(
          {
            report: version.report,
            topology: version.topology,
            score: version.score,
            process: version.process ?? null,
            ...(converted && "watertight" in converted
              ? { print: { watertight: converted.watertight, openEdges: converted.openEdges } }
              : {}),
          },
          null,
          2,
        ),
      );
      const source =
        version.build.mode === "process"
          ? project.versions.find((v) => v.id === version.build.parentVersionId)
          : version;
      const sourceName = source?.build.mode === "blender" ? "source.py" : "source.js";
      if (source?.build.source)
        await atomicModelFile(path.join(temporary, sourceName), source.build.source);
      const skeleton = source?.build.skeleton
        ? await modelPath(this.root, project.id, "versions", source.id, "skeleton.json")
        : null;
      if (skeleton) await fs.copyFile(skeleton, path.join(temporary, "skeleton.json"));
      await atomicModelFile(
        path.join(temporary, "asset.json"),
        JSON.stringify(
          {
            format: 1,
            name: project.name,
            projectId: project.id,
            versionId,
            sha256: version.hash,
            export: {
              preset,
              format,
              files: converted?.files ?? [
                "model.glb",
                ...lodFiles.map((f) => path.basename(f)),
                ...(collisionFile ? ["collision.glb"] : []),
              ],
            },
            units: "meters",
            upAxis: "Y",
            pivot: "bottom-center",
            lod: version.process?.lods.length ? version.process.lods : "not-provided",
            collision: version.process?.collision
              ? { kind: version.build.process?.collision, ...version.process.collision }
              : "not-provided",
            uv: version.report.warnings.some((w) => w.includes("UV")) ? "missing" : "provided",
            textures: version.process?.baked.length
              ? { maps: version.process.baked, size: version.process.textureSize }
              : "not-provided",
            source:
              version.build.mode === "process"
                ? "gen3d-optimized"
                : version.build.mode === "blender"
                  ? "gen3d-blender"
                  : "gen3d-threejs-sdf",
            parentVersionId: version.build.parentVersionId,
            sourceVersionId: source?.id ?? null,
            blueprint: project.blueprint && {
              targetHeight: project.blueprint.targetHeight,
              referenceId: project.blueprint.referenceId,
            },
            dependencies: version.runtime,
          },
          null,
          2,
        ),
      );
      await fs.rename(temporary, destination);
      return { exportPath: destination };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async dispose() {
    for (const cancel of this.compilers.values()) cancel();
    for (const child of this.headless.values()) child.kill("SIGKILL");
    const server = this.server;
    this.server = null;
    // close() waits for in-flight requests; a stuck build must not hold quit open.
    const closed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    server?.closeAllConnections();
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), DISPOSE_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) this.log(`dispose did not finish within ${DISPOSE_DEADLINE_MS / 1000} s`);
    if (process.platform !== "win32") await fs.rm(this.pipe, { force: true }).catch(() => {});
  }
}
