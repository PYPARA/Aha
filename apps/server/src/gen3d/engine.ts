import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Schema } from "effect";
import sharp from "sharp";
import {
  Gen3DCommand,
  Gen3DProject,
  GEN3D_LIMITS,
  GEN3D_VIEWS,
  type Gen3DCommandResult,
  type Gen3DEnvironment,
  type Gen3DList,
  type Gen3DReference,
  type Gen3DScore,
  type Gen3DVersion,
  type Model3DValidationReport,
} from "@synara/contracts";
import { ahaUserDirectories } from "@synara/shared/ahaUserDirectories";
import { atomicModelFile, modelErrorText, modelPath } from "@synara/shared/model3dFiles";
import {
  BLUEPRINT_SIZE,
  compareSilhouettes,
  diffPixels,
  extractBlueprint,
  maskPixels,
  pixelsToMask,
  registerSilhouette,
  silhouetteScore,
} from "@synara/shared/gen3dScore";
import { validateBytes } from "gltf-validator";
import { Gen3DHostTimeoutError, gen3dHostCall } from "./hostClient";

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends readonly (infer U)[] ? U[] : T[P] };
type Project = Mutable<Gen3DProject>;
const now = () => new Date().toISOString();
const active = (status: string) => ["queued", "running", "validating"].includes(status);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Files a published version carries, besides the optional diff images. */
export const GEN3D_RENDERS = [
  "render-34.png",
  "render-front.png",
  "render-side.png",
  "render-back.png",
];
const VERSION_FILES = new Set([
  "model.glb",
  "thumbnail.png",
  ...GEN3D_RENDERS,
  ...GEN3D_VIEWS.flatMap((v) => [`sil-${v}.png`, `diff-${v}.png`]),
  "score.json",
  "version.json",
]);
const png = (pixels: Uint8Array) =>
  sharp(pixels, { raw: { width: BLUEPRINT_SIZE, height: BLUEPRINT_SIZE, channels: 3 } })
    .png()
    .toBuffer();
async function readRgb(file: string) {
  const { data, info } = await sharp(file, { limitInputPixels: 64_000_000 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgb: new Uint8Array(data), width: info.width, height: info.height };
}
async function readModel(file: string) {
  if ((await fs.stat(file)).size > GEN3D_LIMITS.fileBytes)
    throw new Error("Model exceeds 200 MiB.");
  return fs.readFile(file);
}

export interface Gen3DBuildResult {
  report: Model3DValidationReport;
  topology: Gen3DVersion["topology"];
}

export class Gen3DEngine {
  readonly events = new EventEmitter();
  private locks = new Map<string, Promise<unknown>>();
  private running = new Map<string, AbortController>();
  constructor(
    readonly root: string,
    private host: typeof gen3dHostCall = gen3dHostCall,
  ) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const item of await this.list()) {
      if (item.error) continue;
      await this.lock(item.id, async () => {
        const p = await this.get(item.id);
        let changed = false;
        for (const job of p.jobs.filter((j) => active(j.status))) {
          this.updateJob(p, job.id, {
            status: "interrupted",
            error: "Execution was interrupted. Inspect the retained source and retry explicitly.",
          });
          changed = true;
        }
        // An authorization never resumes by itself after a restart.
        for (const run of p.runs.filter((r) => r.status === "active")) {
          this.updateRun(p, run.id, { status: "interrupted", stopReason: "restart" });
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
  async get(id: string): Promise<Project> {
    return Schema.decodeUnknownSync(Gen3DProject)(
      JSON.parse(await fs.readFile(await modelPath(this.root, id, "project.json"), "utf8")),
    ) as Project;
  }
  private async save(p: Project) {
    p.updatedAt = now();
    p.revision++;
    await atomicModelFile(
      await modelPath(this.root, p.id, "project.json"),
      JSON.stringify(p, null, 2),
    );
    this.events.emit("changed", { projectId: p.id, revision: p.revision });
    return p;
  }
  private updateJob(p: Project, id: string, patch: Partial<Gen3DProject["jobs"][number]>) {
    p.jobs = p.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  }
  private updateRun(p: Project, id: string, patch: Partial<Gen3DProject["runs"][number]>) {
    p.runs = p.runs.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }
  activeRun(p: Gen3DProject) {
    return p.runs.find((r) => r.status === "active") ?? null;
  }
  async list(): Promise<Gen3DList> {
    const result: Gen3DList[number][] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) continue;
      // A broken project is surfaced, never discarded or rewritten by listing.
      try {
        const p = await this.get(entry.name);
        const preview =
          p.versions.find((v) => v.id === (p.adoptedVersionId ?? p.previewVersionId)) ??
          p.versions.at(-1);
        result.push({
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          archived: p.archived,
          versions: p.versions.length,
          running: p.jobs.some((j) => active(j.status)) || !!this.activeRun(p),
          previewVersionId: preview?.id ?? null,
          stage: p.adoptedVersionId
            ? "adopted"
            : p.versions.length
              ? "modeling"
              : p.references.length
                ? "blueprint"
                : "empty",
          score: preview?.score?.score ?? null,
          maxRegionPct: preview?.score?.maxRegionPct ?? null,
          triangles: preview?.report.triangles ?? null,
        });
      } catch (error) {
        result.push({
          id: entry.name,
          name: entry.name,
          updatedAt: "",
          archived: false,
          versions: 0,
          running: false,
          previewVersionId: null,
          stage: "empty",
          score: null,
          maxRegionPct: null,
          triangles: null,
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
          for (const run of project.runs.filter((r) => r.status === "active"))
            this.updateRun(project, run.id, {
              status: "stopped",
              stopReason: "conversation-removed",
            });
          await this.save(project);
        }
      });
  }
  async environment(): Promise<Gen3DEnvironment> {
    try {
      return await this.host<Gen3DEnvironment>("environment");
    } catch (error) {
      return { desktop: false, error: modelErrorText(error) };
    }
  }
  /** Adds reference image bytes (uploaded or from a drawing job) as a normalized PNG. */
  async addReferenceBytes(
    projectId: string,
    revision: number,
    bytes: Uint8Array,
    input: { name: string; origin: Gen3DReference["origin"]; imageJobId: string | null },
  ) {
    if (bytes.byteLength > GEN3D_LIMITS.referenceBytes)
      throw new Error("Reference image exceeds 32 MiB.");
    const { data, info } = await sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: "error" })
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    return this.lock(projectId, async () => {
      const p = await this.get(projectId);
      if (revision !== p.revision) throw new Error("3D project changed. Reload before saving.");
      const id = digest(data).slice(0, 32);
      await atomicModelFile(await modelPath(this.root, p.id, "references", id + ".png"), data);
      if (!p.references.some((r) => r.id === id))
        p.references.push({
          id,
          name: input.name.slice(0, 200) || "reference.png",
          width: info.width,
          height: info.height,
          origin: input.origin,
          imageJobId: input.imageJobId,
          createdAt: now(),
        });
      return { project: await this.save(p) } satisfies Gen3DCommandResult;
    });
  }
  async command(raw: Gen3DCommand): Promise<Gen3DCommandResult> {
    const c = Schema.decodeUnknownSync(Gen3DCommand)(raw);
    if (c.operation === "environment")
      return { project: null, environment: await this.environment() };
    if (c.operation === "import-reference-asset")
      throw new Error("Drawing assets are imported through the workbench service.");
    if (c.operation === "create") {
      const p: Project = {
        schemaVersion: 1,
        id: randomUUID(),
        revision: 0,
        name: c.name?.trim().slice(0, 200) || "Untitled 3D asset",
        description: c.description?.trim().slice(0, 4000) ?? "",
        updatedAt: now(),
        triangleBudget: 5000,
        threadId: null,
        adoptedVersionId: null,
        previewVersionId: null,
        references: [],
        blueprint: null,
        versions: [],
        jobs: [],
        runs: [],
        archived: false,
      };
      await fs.mkdir(await modelPath(this.root, p.id), { recursive: true });
      return { project: await this.save(p) };
    }
    if (!c.projectId) throw new Error("Choose a 3D project.");
    const run = () =>
      this.lock(c.projectId!, async (): Promise<Gen3DCommandResult> => {
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
          throw new Error("3D project changed. Reload before saving.");
        switch (c.operation) {
          case "update": {
            if (c.name !== undefined) {
              if (!c.name.trim() || c.name.length > 200)
                throw new Error("Enter a project name of 1–200 characters.");
              p.name = c.name.trim();
            }
            if (c.description !== undefined) p.description = c.description.trim().slice(0, 4000);
            if (c.triangleBudget !== undefined) {
              if (
                !Number.isSafeInteger(c.triangleBudget) ||
                c.triangleBudget < 100 ||
                c.triangleBudget > GEN3D_LIMITS.triangles
              )
                throw new Error("Invalid triangle budget.");
              p.triangleBudget = c.triangleBudget;
            }
            break;
          }
          case "bind-thread": {
            if (c.threadId) {
              const bound = await this.forThread(c.threadId);
              if (bound && bound.id !== p.id)
                throw new Error("Conversation already belongs to another 3D project.");
            }
            p.threadId = c.threadId ?? null;
            break;
          }
          case "add-reference": {
            if (p.archived) throw new Error("Restore this project before editing.");
            const result = await this.host<{ reference: Gen3DReference | null }>("add-reference", {
              projectId: p.id,
            });
            if (!result.reference) return { project: p };
            if (!p.references.some((r) => r.id === result.reference!.id))
              p.references.push(result.reference);
            break;
          }
          case "extract-blueprint": {
            const reference = p.references.find((r) => r.id === c.referenceId);
            if (!reference) throw new Error("Reference image not found.");
            if (
              !c.targetHeight ||
              !Number.isFinite(c.targetHeight) ||
              c.targetHeight <= 0 ||
              c.targetHeight > 1000
            )
              throw new Error("Enter the asset's real height in metres.");
            if (p.jobs.some((j) => active(j.status)) || this.activeRun(p))
              throw new Error("Stop the active generation before changing the blueprint.");
            const { rgb, width, height } = await readRgb(
              await modelPath(this.root, p.id, "references", reference.id + ".png"),
            );
            const sheet = extractBlueprint(rgb, width, height);
            for (const view of GEN3D_VIEWS)
              await atomicModelFile(
                await modelPath(this.root, p.id, "blueprint", view + ".png"),
                await png(maskPixels(sheet.masks[view])),
              );
            p.blueprint = {
              referenceId: reference.id,
              targetHeight: c.targetHeight,
              pxPerMetre: sheet.frontHeightPx / c.targetHeight,
              boxes: sheet.boxes,
              confirmed: false,
              createdAt: now(),
            };
            break;
          }
          case "confirm-blueprint": {
            if (!p.blueprint) throw new Error("Extract a blueprint first.");
            p.blueprint = { ...p.blueprint, confirmed: true };
            break;
          }
          case "start-run": {
            if (p.archived) throw new Error("Restore this project before generating.");
            if (!p.threadId) throw new Error("Start the modeling conversation first.");
            const rounds = c.maxRounds ?? 4;
            if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > GEN3D_LIMITS.maxRounds)
              throw new Error(`Rounds must be between 1 and ${GEN3D_LIMITS.maxRounds}.`);
            for (const previous of p.runs.filter((r) => r.status === "active"))
              this.updateRun(p, previous.id, { status: "stopped", stopReason: "replaced" });
            p.runs.push({
              id: randomUUID(),
              createdAt: now(),
              maxRounds: rounds,
              usedRounds: 0,
              stopMaxRegionPct: 2,
              stopMinGain: 1,
              status: "active",
              stopReason: null,
            });
            break;
          }
          case "stop-run": {
            const current = p.runs.find((r) => r.id === c.runId);
            if (!current || current.status !== "active") throw new Error("No active generation.");
            this.updateRun(p, current.id, { status: "stopped", stopReason: "user" });
            break;
          }
          case "archive": {
            if (p.jobs.some((j) => active(j.status)) || this.activeRun(p))
              throw new Error("Stop the active generation before archiving.");
            p.archived = c.archived ?? true;
            break;
          }
          case "select-version": {
            if (!p.versions.some((v) => v.id === c.versionId))
              throw new Error("Model version not found.");
            p.previewVersionId = c.versionId!;
            break;
          }
          case "adopt": {
            const version = p.versions.find((v) => v.id === c.versionId);
            if (!version) throw new Error("Model version not found.");
            await this.verifyVersion(p.id, version);
            p.adoptedVersionId = version.id;
            break;
          }
          case "cancel": {
            const job = p.jobs.find((j) => j.id === c.jobId);
            if (!job || !active(job.status)) throw new Error("No active model task.");
            this.running.get(job.id)?.abort();
            this.updateJob(p, job.id, { status: "cancelled", error: null });
            void this.host("cancel", { jobId: job.id }).catch(() => {});
            break;
          }
          case "export": {
            if (!c.versionId || c.versionId !== p.adoptedVersionId)
              throw new Error("Export the explicitly adopted version.");
            const version = p.versions.find((v) => v.id === c.versionId)!;
            await this.verifyVersion(p.id, version);
            const result = await this.host<{ exportPath?: string }>("export", {
              projectId: p.id,
              versionId: version.id,
            });
            return { project: p, ...result };
          }
          case "submit": {
            if (p.archived) throw new Error("Restore this project before building.");
            if (p.jobs.some((j) => active(j.status)))
              throw new Error("A model build is already in progress. Read its status first.");
            const build = c.build;
            if (!build?.source.trim()) throw new Error("Provide modeling source.");
            if (Buffer.byteLength(build.source) > GEN3D_LIMITS.sourceBytes)
              throw new Error("Model source exceeds 1 MiB.");
            if (build.parentVersionId && !p.versions.some((v) => v.id === build.parentVersionId))
              throw new Error("Parent model version not found.");
            const authorization = this.activeRun(p);
            if (authorization) {
              if (authorization.usedRounds >= authorization.maxRounds)
                throw new Error(
                  "The authorized rounds are used up. Ask the user before building again.",
                );
              this.updateRun(p, authorization.id, { usedRounds: authorization.usedRounds + 1 });
            } else if (c.turnId && p.jobs.some((j) => j.turnId === c.turnId)) {
              // Without an iteration authorization each user turn allows one candidate.
              throw new Error(
                "Without an iteration authorization each user message allows one build. Report the result and wait for the user.",
              );
            }
            const id = randomUUID();
            p.jobs.push({
              id,
              requestId: c.requestId ?? randomUUID(),
              fingerprint: digest(JSON.stringify(build)),
              createdAt: now(),
              status: "queued",
              build,
              runId: authorization?.id ?? null,
              turnId: c.turnId ?? null,
              error: null,
              versionId: null,
            });
            await atomicModelFile(
              await modelPath(this.root, p.id, "jobs", id, "input.json"),
              JSON.stringify({ build, blueprint: p.blueprint }),
            );
            await this.save(p);
            void this.execute(p.id, id);
            return { project: p };
          }
          default:
            throw new Error("Unsupported 3D generation operation.");
        }
        return { project: await this.save(p) };
      });
    // Binding uniqueness spans projects, while model mutations only serialize their project.
    return c.operation === "bind-thread" ? this.lock("$thread-bindings", run) : run();
  }
  private async execute(projectId: string, jobId: string) {
    const controller = new AbortController();
    this.running.set(jobId, controller);
    try {
      const pxPerMetre = await this.lock(projectId, async () => {
        const p = await this.get(projectId);
        if (p.jobs.find((j) => j.id === jobId)?.status === "cancelled")
          throw new Error("Build cancelled.");
        this.updateJob(p, jobId, { status: "running" });
        await this.save(p);
        return p.blueprint?.pxPerMetre ?? null;
      });
      const result = await this.host<Gen3DBuildResult>(
        "build",
        { projectId, jobId, pxPerMetre },
        controller.signal,
      );
      await this.lock(projectId, async () => {
        const p = await this.get(projectId),
          job = p.jobs.find((j) => j.id === jobId)!;
        if (job.status === "cancelled" || controller.signal.aborted) return;
        this.updateJob(p, jobId, { status: "validating" });
        await this.save(p);
        const dir = (...parts: string[]) =>
          modelPath(this.root, projectId, "jobs", jobId, ...parts);
        const bytes = await readModel(await dir("model.glb"));
        const validatorErrors = await this.validate(bytes);
        const score = p.blueprint ? await this.score(projectId, jobId) : null;
        const warnings = [...result.report.warnings];
        if (result.report.triangles > p.triangleBudget) warnings.push("Triangle budget exceeded.");
        if (result.topology.nonManifoldEdges)
          warnings.push(`${result.topology.nonManifoldEdges} non-manifold edges need cleanup.`);
        if (p.blueprint) {
          const height = result.report.dimensions[1] ?? 0;
          if (Math.abs(height - p.blueprint.targetHeight) / p.blueprint.targetHeight > 0.1)
            warnings.push(
              `Height ${height.toFixed(3)} m differs from the target ${p.blueprint.targetHeight} m.`,
            );
        }
        const files: Gen3DVersion["files"][number][] = [];
        for (const name of VERSION_FILES) {
          const file = await dir(name),
            stat = await fs.stat(file).catch(() => null);
          if (!stat) continue;
          files.push({ name, hash: digest(await fs.readFile(file)), bytes: stat.size });
        }
        const runOf = job.runId ? p.runs.find((r) => r.id === job.runId) : undefined;
        const version: Gen3DVersion = {
          id: jobId,
          name: "v" + (p.versions.length + 1),
          createdAt: now(),
          build: job.build,
          hash: digest(bytes),
          report: { ...result.report, bytes: bytes.length, validatorErrors, warnings },
          topology: result.topology,
          score,
          runId: job.runId,
          round: runOf ? runOf.usedRounds : null,
          files,
          runtime: { three: GEN3D_LIMITS.threeVersion },
        };
        if (version.report.errors.length) throw new Error(version.report.errors.join("\n"));
        await atomicModelFile(await dir("version.json"), JSON.stringify(version, null, 2));
        await fs.mkdir(await modelPath(this.root, projectId, "versions"), { recursive: true });
        await fs.rename(await dir(), await modelPath(this.root, projectId, "versions", jobId));
        p.versions.push(version);
        p.previewVersionId = version.id;
        this.updateJob(p, jobId, { status: "succeeded", versionId: version.id, error: null });
        if (runOf) this.finishRound(p, runOf.id);
        await this.save(p);
      });
    } catch (error) {
      // An unanswered host may still be compiling; stop it so it cannot hold the runtime.
      if (error instanceof Gen3DHostTimeoutError)
        void this.host("cancel", { jobId }).catch(() => {});
      await this.lock(projectId, async () => {
        const p = await this.get(projectId),
          job = p.jobs.find((j) => j.id === jobId);
        if (job && job.status !== "cancelled") {
          this.updateJob(p, jobId, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: modelErrorText(error),
          });
          const runOf = job.runId ? p.runs.find((r) => r.id === job.runId) : undefined;
          if (runOf?.status === "active" && runOf.usedRounds >= runOf.maxRounds)
            this.updateRun(p, runOf.id, { status: "completed", stopReason: "rounds-used" });
          await this.save(p);
        }
      }).catch(() => {});
    } finally {
      this.running.delete(jobId);
    }
  }
  /** Applies the stop rule after a scored round: small deviation, no gain, or rounds used up. */
  private finishRound(p: Project, runId: string) {
    const current = p.runs.find((r) => r.id === runId);
    if (!current || current.status !== "active") return;
    const scored = p.versions.filter((v) => v.runId === runId && v.score);
    const last = scored.at(-1)?.score;
    let reason: string | null = null;
    if (last && last.maxRegionPct < current.stopMaxRegionPct) reason = "deviation-below-threshold";
    else if (scored.length >= 3) {
      const [a, b, c] = scored.slice(-3).map((v) => v.score!.score);
      if (b! - a! < current.stopMinGain && c! - b! < current.stopMinGain) reason = "no-improvement";
    }
    if (!reason && current.usedRounds >= current.maxRounds) reason = "rounds-used";
    if (reason) this.updateRun(p, runId, { status: "completed", stopReason: reason });
  }
  private async score(projectId: string, jobId: string): Promise<Gen3DScore> {
    const views = [] as ReturnType<typeof compareSilhouettes>[];
    const perView = {} as Record<(typeof GEN3D_VIEWS)[number], Gen3DScore["views"]["front"]>;
    let regions: Gen3DScore["regions"][number][] = [];
    for (const view of GEN3D_VIEWS) {
      const ref = pixelsToMask(
        (await readRgb(await modelPath(this.root, projectId, "blueprint", view + ".png"))).rgb,
      );
      const model = pixelsToMask(
        (await readRgb(await modelPath(this.root, projectId, "jobs", jobId, `sil-${view}.png`)))
          .rgb,
      );
      const registered = registerSilhouette(model, ref, view === "side");
      const comparison = compareSilhouettes(registered.mask, ref);
      views.push(comparison);
      perView[view] = {
        iou: +comparison.iou.toFixed(3),
        contourPct: +(comparison.contour * 100).toFixed(2),
        shiftPx: registered.dx,
        ...(registered.mirrored ? { mirrored: true } : {}),
      };
      regions.push(...comparison.regions.slice(0, 3).map((r) => ({ view, ...r })));
      await atomicModelFile(
        await modelPath(this.root, projectId, "jobs", jobId, `diff-${view}.png`),
        await png(diffPixels(registered.mask, ref, comparison)),
      );
    }
    regions = regions.toSorted((a, b) => b.pct - a.pct).slice(0, 6);
    const score: Gen3DScore = {
      score: silhouetteScore(views),
      maxRegionPct: regions[0]?.pct ?? 0,
      views: perView,
      regions,
    };
    await atomicModelFile(
      await modelPath(this.root, projectId, "jobs", jobId, "score.json"),
      JSON.stringify(score, null, 2),
    );
    return score;
  }
  async validate(bytes: Uint8Array) {
    if (bytes.byteLength > GEN3D_LIMITS.fileBytes) throw new Error("Model exceeds 200 MiB.");
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
  async verifyVersion(projectId: string, version: Gen3DVersion) {
    const bytes = await readModel(
      await modelPath(this.root, projectId, "versions", version.id, "model.glb"),
    );
    if (digest(bytes) !== version.hash) throw new Error("Model file checksum mismatch.");
    for (const file of version.files) {
      if (file.name === "model.glb" || file.name === "version.json") continue;
      const full = await modelPath(this.root, projectId, "versions", version.id, file.name);
      if (
        (await fs.stat(full)).size !== file.bytes ||
        digest(await fs.readFile(full)) !== file.hash
      )
        throw new Error("Model file checksum mismatch: " + file.name);
    }
    await this.validate(bytes);
  }
  /** Reads a published version file, a blueprint view or a reference image for display. */
  async read(projectId: string, kind: string, id: string, file?: string) {
    const p = await this.get(projectId);
    if (kind === "versions") {
      if (!p.versions.some((v) => v.id === id)) throw new Error("Model version not found.");
      if (!file || !VERSION_FILES.has(file)) throw new Error("Invalid model asset.");
      return fs.readFile(await modelPath(this.root, projectId, "versions", id, file));
    }
    if (kind === "blueprint") {
      if (!p.blueprint || !GEN3D_VIEWS.includes(id as (typeof GEN3D_VIEWS)[number]))
        throw new Error("Blueprint not found.");
      return fs.readFile(await modelPath(this.root, projectId, "blueprint", id + ".png"));
    }
    if (kind === "references") {
      if (!p.references.some((r) => r.id === id)) throw new Error("Reference not found.");
      return fs.readFile(await modelPath(this.root, projectId, "references", id + ".png"));
    }
    throw new Error("Invalid 3D asset.");
  }
}
const engines = new Map<string, Promise<Gen3DEngine>>();
const gen3dRoot = () => ahaUserDirectories(os.homedir(), process.env.AHA_DOCUMENTS_DIR).gen3d;
export function gen3DEngine() {
  const root = gen3dRoot();
  let promise = engines.get(root);
  if (!promise) {
    promise = (async () => {
      const engine = new Gen3DEngine(root);
      await engine.initialize();
      return engine;
    })();
    engines.set(root, promise);
    promise.catch(() => engines.delete(root));
  }
  return promise;
}
export async function gen3DForThread(threadId: string) {
  if (!(await fs.stat(gen3dRoot()).catch(() => null))) return null;
  return (await gen3DEngine()).forThread(threadId);
}
