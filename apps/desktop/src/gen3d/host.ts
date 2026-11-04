import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import sharp from "sharp";
import { Schema } from "effect";
import {
  Gen3DBuild,
  Gen3DProject,
  GEN3D_LIMITS,
  GEN3D_VIEWS,
  Model3DValidationReport,
} from "@synara/contracts";
import { atomicModelFile, modelErrorText, modelPath } from "@synara/shared/model3dFiles";

const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid 3D generation identity.");
  return value;
};
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
// Builds must answer before the server's 180 s request timeout gives up on them.
const BUILD_DEADLINE_MS = 120_000;
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
  constructor(
    readonly root: string,
    private runtimeUrl: () => string,
    private preload: string,
    private log: (message: string) => void = () => {},
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
    if (method === "environment") return { desktop: true, error: null };
    if (method === "cancel") {
      const jobId = id(input.jobId);
      this.cancelled.add(jobId);
      setTimeout(() => this.cancelled.delete(jobId), 180_000).unref();
      this.compilers.get(jobId)?.();
      return {};
    }
    const projectId = id(input.projectId);
    const project = Schema.decodeUnknownSync(Gen3DProject)(
      JSON.parse(await fs.readFile(await modelPath(this.root, projectId, "project.json"), "utf8")),
    );
    if (project.id !== projectId) throw new Error("3D project identity mismatch.");
    if (method === "add-reference") return this.addReference(projectId);
    if (method === "export") return this.export(project, id(input.versionId));
    if (method !== "build") throw new Error("Unsupported 3D generation host operation.");
    const pxPerMetre = input.pxPerMetre === null ? null : Number(input.pxPerMetre);
    if (pxPerMetre !== null && !(Number.isFinite(pxPerMetre) && pxPerMetre > 0))
      throw new Error("Invalid blueprint scale.");
    return this.build(project, id(input.jobId), pxPerMetre);
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
    const started = Date.now();
    this.log(`job ${jobId} build received`);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.compile({
          id: jobId,
          source: build.source,
          pxPerMetre,
          timeoutMs: GEN3D_LIMITS.buildTimeoutMs,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.compilers.get(jobId)?.();
            reject(
              new Error(
                `3D build did not finish within ${BUILD_DEADLINE_MS / 1000} s. The task was stopped.`,
              ),
            );
          }, BUILD_DEADLINE_MS);
        }),
      ]);
      if (this.cancelled.has(jobId)) throw new Error("3D task cancelled.");
      await atomicModelFile(await modelPath(directory, "model.glb"), result.bytes);
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
      this.log(`job ${jobId} done +${Date.now() - started}ms`);
      return { report: result.report, topology: result.topology };
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
  private async export(project: Gen3DProject, versionId: string) {
    const version = project.versions.find((v) => v.id === versionId);
    if (!version || versionId !== project.adoptedVersionId)
      throw new Error("Only the adopted version can be exported.");
    const versionFile = (name: string) =>
      modelPath(this.root, project.id, "versions", versionId, name);
    const bytes = await fs.readFile(await versionFile("model.glb"));
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
      temporary = path.join(parent, `.aha-gen3d-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
      await atomicModelFile(path.join(temporary, "model.glb"), bytes);
      for (const file of ["thumbnail.png", "render-34.png"])
        if (version.files.some((f) => f.name === file))
          await fs.copyFile(await versionFile(file), path.join(temporary, file));
      await atomicModelFile(
        path.join(temporary, "validation.json"),
        JSON.stringify(
          { report: version.report, topology: version.topology, score: version.score },
          null,
          2,
        ),
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
            units: "meters",
            upAxis: "Y",
            pivot: "bottom-center",
            lod: "not-provided",
            collision: "not-provided",
            uv: version.report.warnings.some((w) => w.includes("UV")) ? "missing" : "provided",
            source: "gen3d-threejs-sdf",
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
      await atomicModelFile(path.join(temporary, "source.js"), version.build.source);
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
