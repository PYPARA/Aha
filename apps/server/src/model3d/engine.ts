import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Schema } from "effect";
import {
  Model3DProject,
  Model3DCommand,
  MODEL3D_LIMITS,
  type Model3DVersion,
  type Model3DValidationReport,
  type Model3DCommandResult,
  type Model3DEnvironment,
  type Model3DList,
} from "@synara/contracts";
import { ahaUserDirectories } from "@synara/shared/ahaUserDirectories";
import { modelPath, atomicModelFile, modelErrorText } from "@synara/shared/model3dFiles";
import { ModelHostTimeoutError, modelHostCall } from "./hostClient";
import { validateBytes } from "gltf-validator";

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends readonly (infer U)[] ? U[] : T[P] };
const now = () => new Date().toISOString();
const active = (status: string) => ["queued", "running", "validating"].includes(status);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function readModel(file: string) {
  if ((await fs.stat(file)).size > MODEL3D_LIMITS.fileBytes)
    throw new Error("Model exceeds 100 MiB.");
  return fs.readFile(file);
}
export class Model3DEngine {
  readonly events = new EventEmitter();
  private locks = new Map<string, Promise<unknown>>();
  private running = new Map<string, AbortController>();
  constructor(
    readonly root: string,
    private host: typeof modelHostCall = modelHostCall,
  ) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const item of await this.list()) {
      if (item.error) continue;
      await this.lock(item.id, async () => {
        const p = await this.get(item.id);
        let changed = false;
        for (const job of p.jobs.filter(
          (j) => j.status !== "cancelled" && j.status !== "succeeded",
        )) {
          if (
            !active(job.status) &&
            !(await fs
              .stat(await modelPath(this.root, p.id, "versions", job.id, "version.json"))
              .catch(() => null))
          )
            continue;
          try {
            const version = JSON.parse(
              await fs.readFile(
                await modelPath(this.root, p.id, "versions", job.id, "version.json"),
                "utf8",
              ),
            ) as Model3DVersion;
            await this.verifyVersion(p.id, version);
            if (!p.versions.some((v) => v.id === version.id)) p.versions.push(version);
            p.previewVersionId = version.id;
            this.updateJob(p, job.id, { status: "succeeded", versionId: version.id, error: null });
          } catch {
            this.updateJob(p, job.id, {
              status: "interrupted",
              error: "Execution was interrupted. Inspect the retained source and retry explicitly.",
            });
          }
          changed = true;
        }
        if (changed) await this.save(p);
      });
    }
  }
  async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async get(id: string): Promise<Mutable<Model3DProject>> {
    return Schema.decodeUnknownSync(Model3DProject)(
      JSON.parse(await fs.readFile(await modelPath(this.root, id, "project.json"), "utf8")),
    ) as Mutable<Model3DProject>;
  }
  private async save(p: Mutable<Model3DProject>) {
    p.updatedAt = now();
    p.revision++;
    await atomicModelFile(
      await modelPath(this.root, p.id, "project.json"),
      JSON.stringify(p, null, 2),
    );
    this.events.emit("changed", { projectId: p.id, revision: p.revision });
    return p;
  }
  private updateJob(
    p: Mutable<Model3DProject>,
    id: string,
    patch: Partial<Model3DProject["jobs"][number]>,
  ) {
    p.jobs = p.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  }
  async list(): Promise<Model3DList> {
    const result: Model3DList[number][] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) continue;
      // A broken project is surfaced, never discarded or rewritten by listing.
      try {
        const p = await this.get(entry.name);
        result.push({
          id: p.id,
          name: p.name,
          mode: p.mode,
          updatedAt: p.updatedAt,
          archived: p.archived,
          versions: p.versions.length,
          running: p.jobs.some((j) => active(j.status)),
          previewVersionId: p.adoptedVersionId ?? p.versions.at(-1)?.id ?? null,
        });
      } catch (error) {
        result.push({
          id: entry.name,
          name: entry.name,
          mode: "threejs",
          updatedAt: "",
          archived: false,
          versions: 0,
          running: false,
          previewVersionId: null,
          error: modelErrorText(error),
        });
      }
    }
    return result.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async forThread(threadId: string) {
    for (const item of await this.list()) {
      if (item.error) continue;
      const p = await this.get(item.id);
      if (p.threadId === threadId) return p;
    }
    return null;
  }
  async detachThread(threadId: string) {
    for (const item of (await this.list()).filter((item) => !item.error))
      await this.lock(item.id, async () => {
        const project = await this.get(item.id);
        if (project.threadId === threadId) {
          project.threadId = null;
          await this.save(project);
        }
      });
  }
  async environment(): Promise<Model3DEnvironment> {
    try {
      return await this.host<Model3DEnvironment>("environment");
    } catch (error) {
      return {
        desktop: false,
        blenderPath: null,
        uvxPath: null,
        prepared: false,
        blenderVersion: null,
        error: modelErrorText(error),
      };
    }
  }
  async command(raw: Model3DCommand): Promise<Model3DCommandResult> {
    const c = Schema.decodeUnknownSync(Model3DCommand)(raw);
    if (c.operation === "environment")
      return { project: null, environment: await this.environment() };
    if (
      c.operation === "prepare-runtime" ||
      c.operation === "check-runtime" ||
      c.operation === "blender-settings"
    )
      return {
        project: null,
        environment: await this.host<Model3DEnvironment>(c.operation, {
          blenderPath: c.blenderPath,
          uvxPath: c.uvxPath,
        }),
      };
    if (c.operation === "create") {
      const p: Mutable<Model3DProject> = {
        schemaVersion: 1,
        id: randomUUID(),
        revision: 0,
        name: c.name?.trim() || "Untitled 3D project",
        updatedAt: now(),
        mode: c.mode ?? "threejs",
        triangleBudget: 5000,
        textureBudget: 2048,
        threadId: null,
        adoptedVersionId: null,
        previewVersionId: null,
        versions: [],
        jobs: [],
        textures: [],
        archived: false,
      };
      await fs.mkdir(await modelPath(this.root, p.id), { recursive: true });
      return { project: await this.save(p) };
    }
    if (!c.projectId) throw new Error("Choose a model project.");
    const run = () =>
      this.lock(c.projectId!, async () => {
        const p = await this.get(c.projectId!);
        if (c.operation === "submit" && c.requestId) {
          const previous = p.jobs.find((j) => j.requestId === c.requestId);
          if (previous) {
            if (previous.fingerprint !== digest(JSON.stringify(c.build)))
              throw new Error("Request ID was already used for different model source.");
            return { project: p };
          }
        }
        if (c.revision === undefined || c.revision !== p.revision)
          throw new Error("Model project changed. Reload before saving.");
        if (c.operation === "update") {
          if (c.name !== undefined) {
            if (!c.name.trim() || c.name.length > 200)
              throw new Error("Enter a project name of 1–200 characters.");
            p.name = c.name.trim();
          }
          if (c.mode) p.mode = c.mode;
          if (c.triangleBudget !== undefined) {
            if (
              !Number.isSafeInteger(c.triangleBudget) ||
              c.triangleBudget < 1 ||
              c.triangleBudget > MODEL3D_LIMITS.triangles
            )
              throw new Error("Invalid triangle budget.");
            p.triangleBudget = c.triangleBudget;
          }
          if (c.textureBudget !== undefined) {
            if (![256, 512, 1024, 2048, 4096].includes(c.textureBudget))
              throw new Error("Invalid texture budget.");
            p.textureBudget = c.textureBudget;
          }
        } else if (c.operation === "bind-thread") {
          if (c.threadId) {
            const bound = await this.forThread(c.threadId);
            if (bound && bound.id !== p.id)
              throw new Error("Conversation already belongs to another model project.");
          }
          p.threadId = c.threadId ?? null;
        } else if (c.operation === "archive") {
          if (p.jobs.some((j) => active(j.status)))
            throw new Error("Cancel the active build before archiving.");
          p.archived = c.archived ?? true;
        } else if (c.operation === "select-version") {
          if (!p.versions.some((v) => v.id === c.versionId))
            throw new Error("Model version not found.");
          p.previewVersionId = c.versionId!;
        } else if (c.operation === "adopt") {
          const version = p.versions.find((v) => v.id === c.versionId);
          if (!version) throw new Error("Model version not found.");
          await this.verifyVersion(p.id, version);
          p.adoptedVersionId = version.id;
        } else if (c.operation === "cancel") {
          const job = p.jobs.find((j) => j.id === c.jobId);
          if (!job || !active(job.status)) throw new Error("No active model task.");
          this.running.get(job.id)?.abort();
          this.updateJob(p, job.id, { status: "cancelled", error: null });
          void this.host("cancel", { jobId: job.id }).catch(() => {});
        } else if (c.operation === "texture") {
          const result = await this.host<{ texture: Model3DProject["textures"][number] | null }>(
            "texture",
            { projectId: p.id },
          );
          if (result.texture && !p.textures.some((t) => t.id === result.texture!.id))
            p.textures.push(result.texture);
        } else if (c.operation === "export") {
          if (!c.versionId || c.versionId !== p.adoptedVersionId)
            throw new Error("Export the explicitly adopted version.");
          const version = p.versions.find((v) => v.id === c.versionId)!;
          await this.verifyVersion(p.id, version);
          const result = await this.host<{ exportPath?: string }>("export", {
            projectId: p.id,
            versionId: version.id,
            includeSource: !!c.includeSource,
            target: c.target ?? "generic",
          });
          return { project: p, ...result };
        } else if (c.operation === "submit" || c.operation === "import") {
          if (p.archived) throw new Error("Restore this project before building.");
          if (p.jobs.some((j) => active(j.status)))
            throw new Error("A model build is already in progress.");
          const build = c.build ?? {
            mode: p.mode,
            source: "",
            parameters: {},
            parameterDefinitions: [],
            parentVersionId: null,
            prompt: "Imported model",
            materialEdits: [],
          };
          if (c.operation === "submit" && !build.source && !build.parentVersionId)
            throw new Error("Provide modeling source or an existing version.");
          if (Buffer.byteLength(build.source) > MODEL3D_LIMITS.sourceBytes)
            throw new Error("Model source exceeds 1 MiB.");
          if (build.parentVersionId && !p.versions.some((v) => v.id === build.parentVersionId))
            throw new Error("Parent model version not found.");
          if (build.parentVersionId)
            await this.verifyVersion(p.id, p.versions.find((v) => v.id === build.parentVersionId)!);
          if (build.parameterDefinitions.length > 64)
            throw new Error("A model supports at most 64 parameters.");
          for (const edit of build.materialEdits)
            for (const key of ["baseColor", "normal", "roughnessMap", "metalnessMap"] as const)
              if (edit[key] && !p.textures.some((t) => t.id === edit[key]))
                throw new Error("Texture does not belong to this project.");
          const id = randomUUID(),
            requestId = c.requestId ?? randomUUID();
          p.jobs.push({
            id,
            requestId,
            fingerprint: digest(JSON.stringify(build)),
            createdAt: now(),
            status: "queued",
            build,
            error: null,
            versionId: null,
          });
          await atomicModelFile(
            await modelPath(this.root, p.id, "jobs", id, "input.json"),
            JSON.stringify({
              build,
              parent: build.parentVersionId
                ? p.versions.find((v) => v.id === build.parentVersionId)
                : null,
              textures: p.textures,
            }),
          );
          await this.save(p);
          void this.execute(p.id, id, c.operation === "import");
          return { project: p };
        } else throw new Error("Unsupported model operation.");
        return { project: await this.save(p) };
      });
    // Binding uniqueness spans projects, while model mutations only serialize their project.
    return c.operation === "bind-thread" ? this.lock("$thread-bindings", run) : run();
  }
  private async execute(projectId: string, jobId: string, importing: boolean) {
    const controller = new AbortController();
    this.running.set(jobId, controller);
    try {
      await this.lock(projectId, async () => {
        const p = await this.get(projectId);
        if (p.jobs.find((j) => j.id === jobId)?.status === "cancelled")
          throw new Error("Build cancelled.");
        this.updateJob(p, jobId, { status: "running" });
        await this.save(p);
      });
      const result = await this.host<{
        cancelled?: boolean;
        report: Model3DValidationReport;
        hasBlend: boolean;
        runtime?: Model3DVersion["runtime"];
      }>(importing ? "import" : "build", { projectId, jobId }, controller.signal);
      if (result.cancelled) throw new Error("Import cancelled.");
      await this.lock(projectId, async () => {
        const p = await this.get(projectId),
          job = p.jobs.find((j) => j.id === jobId)!;
        if (job.status === "cancelled" || controller.signal.aborted) return;
        this.updateJob(p, jobId, { status: "validating" });
        await this.save(p);
        const bytes = await readModel(
          await modelPath(this.root, projectId, "jobs", jobId, "model.glb"),
        );
        const validation = await this.validate(bytes);
        const files: NonNullable<Model3DVersion["files"]>[number][] = [];
        for (const name of [
          "model.glb",
          "thumbnail.png",
          "input.json",
          ...(result.hasBlend ? ["model.blend"] : []),
        ]) {
          const file = await modelPath(this.root, projectId, "jobs", jobId, name),
            stat = await fs.stat(file);
          if (stat.size > 200 * 1024 * 1024) throw new Error("Model checkpoint exceeds 200 MiB.");
          files.push({ name, hash: digest(await fs.readFile(file)), bytes: stat.size });
        }
        const warnings = [...result.report.warnings];
        if (result.report.triangles > p.triangleBudget) warnings.push("Triangle budget exceeded.");
        if (result.report.textures.some((t) => Math.max(t.width, t.height) > p.textureBudget))
          warnings.push("Texture budget exceeded.");
        const version: Model3DVersion = {
          id: jobId,
          name: "v" + (p.versions.length + 1),
          createdAt: now(),
          build: job.build,
          hash: digest(bytes),
          files,
          hasBlend: result.hasBlend,
          ...(result.runtime ? { runtime: result.runtime } : {}),
          report: { ...result.report, bytes: bytes.length, validatorErrors: validation, warnings },
        };
        if (version.report.errors.length) throw new Error(version.report.errors.join("\n"));
        await atomicModelFile(
          await modelPath(this.root, projectId, "jobs", jobId, "version.json"),
          JSON.stringify(version, null, 2),
        );
        await fs.mkdir(await modelPath(this.root, projectId, "versions"), { recursive: true });
        await fs.rename(
          await modelPath(this.root, projectId, "jobs", jobId),
          await modelPath(this.root, projectId, "versions", jobId),
        );
        p.versions.push(version);
        p.previewVersionId = version.id;
        this.updateJob(p, jobId, { status: "succeeded", versionId: version.id, error: null });
        await this.save(p);
      });
    } catch (error) {
      // An unanswered host may still be compiling; stop it so it cannot hold the runtime.
      if (error instanceof ModelHostTimeoutError)
        void this.host("cancel", { jobId }).catch(() => {});
      await this.lock(projectId, async () => {
        const p = await this.get(projectId),
          job = p.jobs.find((j) => j.id === jobId);
        if (job && job.status !== "cancelled") {
          this.updateJob(p, jobId, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: modelErrorText(error),
          });
          await this.save(p);
        }
      }).catch(() => {});
    } finally {
      this.running.delete(jobId);
    }
  }
  async validate(bytes: Uint8Array) {
    if (bytes.byteLength > MODEL3D_LIMITS.fileBytes) throw new Error("Model exceeds 100 MiB.");
    const result = await validateBytes(new Uint8Array(bytes), {
      maxIssues: 100,
      externalResourceFunction: () =>
        Promise.reject(new Error("External GLB resources are not allowed.")),
    });
    if (result.issues.numErrors)
      throw new Error(
        "glTF validation failed: " +
          result.issues.messages
            .filter((m) => m.severity === 0)
            .map((m) => m.message)
            .join("; "),
      );
    return result.issues.numErrors;
  }
  async verifyVersion(projectId: string, version: Model3DVersion) {
    const bytes = await readModel(
      await modelPath(this.root, projectId, "versions", version.id, "model.glb"),
    );
    if (digest(bytes) !== version.hash) throw new Error("Model file checksum mismatch.");
    for (const file of version.files ?? []) {
      if (file.name === "model.glb") continue;
      const full = await modelPath(this.root, projectId, "versions", version.id, file.name);
      if (
        (await fs.stat(full)).size !== file.bytes ||
        digest(await fs.readFile(full)) !== file.hash
      )
        throw new Error("Model source/checkpoint checksum mismatch: " + file.name);
    }
    await this.validate(bytes);
  }
  async read(projectId: string, versionId: string, file: string) {
    const p = await this.get(projectId);
    if (!p.versions.some((v) => v.id === versionId)) throw new Error("Model version not found.");
    if (!["model.glb", "thumbnail.png", "version.json"].includes(file))
      throw new Error("Invalid model asset.");
    return fs.readFile(await modelPath(this.root, projectId, "versions", versionId, file));
  }
}
const engines = new Map<string, Promise<Model3DEngine>>();
export function model3DEngine() {
  const root = ahaUserDirectories(os.homedir(), process.env.AHA_DOCUMENTS_DIR).models3d;
  let promise = engines.get(root);
  if (!promise) {
    promise = (async () => {
      const engine = new Model3DEngine(root);
      await engine.initialize();
      return engine;
    })();
    engines.set(root, promise);
    promise.catch(() => engines.delete(root));
  }
  return promise;
}
export async function model3DForThread(threadId: string) {
  const root = ahaUserDirectories(os.homedir(), process.env.AHA_DOCUMENTS_DIR).models3d;
  if (!(await fs.stat(root).catch(() => null))) return null;
  return (await model3DEngine()).forThread(threadId);
}
