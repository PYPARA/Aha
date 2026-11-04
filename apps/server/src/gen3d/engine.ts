import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Schema } from "effect";
import sharp from "sharp";
import {
  Gen3DCommand,
  Gen3DProject,
  GEN3D_ANIMATION_CLIPS,
  GEN3D_LIMITS,
  GEN3D_REPAINT_SIZE,
  GEN3D_REPAINT_VIEWS,
  GEN3D_STYLES,
  GEN3D_VIEWS,
  type Gen3DCommandResult,
  type Gen3DEnvironment,
  type Gen3DList,
  type Gen3DProcessReport,
  type Gen3DReference,
  type Gen3DRepaintView,
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
import { validateSkeleton } from "@synara/shared/gen3dSdf";
import { makeSeamless } from "@synara/shared/gen3dTexture";
import { rigSkeleton } from "@synara/shared/gen3dVersions";
import { validateBytes } from "gltf-validator";
import { Gen3DHostTimeoutError, gen3dHostCall } from "./hostClient";

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends readonly (infer U)[] ? U[] : T[P] };
type Project = Mutable<Gen3DProject>;
const now = () => new Date().toISOString();
const active = (status: string) => ["queued", "running", "validating"].includes(status);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Repaint edits the base colour texture that the optimize step baked. */
const baked = (version: Gen3DVersion | undefined) =>
  version?.process?.baked.includes("baseColor") === true;
/** Extra GLBs an optimized version carries; each is validated like model.glb. */
export const GEN3D_DERIVED_MODELS = [
  "lod1.glb",
  "lod2.glb",
  "lod3.glb",
  "collision.glb",
  "rigged.glb",
];
/** Animated previews a rigged version carries, one per clip. */
export const GEN3D_ANIMATION_PREVIEWS = GEN3D_ANIMATION_CLIPS.map((clip) => `anim-${clip}.webp`);
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
  "skeleton.json",
  "model.blend",
  "process.json",
  ...GEN3D_DERIVED_MODELS,
  ...GEN3D_ANIMATION_PREVIEWS,
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

/** The host answers within its own deadline; these leave room for it to report that deadline. */
const BUILD_REQUEST_MS = {
  threejs: 180_000,
  blender: GEN3D_LIMITS.blenderWaitMs + GEN3D_LIMITS.blenderBuildMs + 90_000,
  process: GEN3D_LIMITS.processMs + 120_000,
} as const;

export interface Gen3DBuildResult {
  report: Model3DValidationReport;
  topology: Gen3DVersion["topology"];
  /** Blender version string when the Blender route built the model. */
  blender?: string | null;
  process?: Gen3DProcessReport;
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
  /** Adds a tiled-material texture (from a drawing job or an upload), made seamless. */
  async addTextureBytes(
    projectId: string,
    revision: number,
    bytes: Uint8Array,
    input: { name: string; prompt: string; imageJobId: string | null },
  ) {
    if (bytes.byteLength > GEN3D_LIMITS.referenceBytes)
      throw new Error("Texture image exceeds 32 MiB.");
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: "error" }).rotate();
    const { width = 0, height = 0 } = await image.metadata();
    if (!width || !height) throw new Error("Unsupported texture image.");
    // Square, at most 1024: one repeat is mapped to a square of the chosen real-world size.
    const size = Math.min(1024, Math.max(64, Math.min(width, height)));
    const { data } = await image
      .removeAlpha()
      .resize(size, size, { fit: "cover" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const seamless = await sharp(makeSeamless(new Uint8Array(data), size, size, 3), {
      raw: { width: size, height: size, channels: 3 },
    })
      .png()
      .toBuffer();
    return this.lock(projectId, async () => {
      const p = await this.get(projectId);
      if (revision !== p.revision) throw new Error("3D project changed. Reload before saving.");
      if (p.archived) throw new Error("Restore this project before editing.");
      const textures = (p.textures ??= []);
      const id = digest(seamless).slice(0, 32);
      if (!textures.some((t) => t.id === id)) {
        if (textures.length >= 64) throw new Error("A project keeps at most 64 textures.");
        await atomicModelFile(await modelPath(this.root, p.id, "textures", id + ".png"), seamless);
        textures.push({
          id,
          name: input.name.slice(0, 200) || "texture.png",
          prompt: input.prompt.trim().slice(0, 2000),
          width: size,
          height: size,
          imageJobId: input.imageJobId,
          createdAt: now(),
        });
      }
      return { project: await this.save(p) } satisfies Gen3DCommandResult;
    });
  }
  /** Renders one view of a baked version for mask painting; returns the PNG bytes. */
  async renderView(projectId: string, versionId: string, view: Gen3DRepaintView) {
    const p = await this.get(projectId);
    const version = p.versions.find((v) => v.id === versionId);
    if (!version) throw new Error("Model version not found.");
    if (!baked(version)) throw new Error("Repaint needs an optimized version with baked textures.");
    if (!GEN3D_REPAINT_VIEWS.includes(view)) throw new Error("Unsupported repaint view.");
    const result = await this.host<{ file: string }>(
      "view",
      { projectId, versionId, view },
      undefined,
      GEN3D_LIMITS.processMs + 60_000,
    );
    // The host answers with a path inside this root; anything else is refused.
    const expected = await modelPath(this.root, projectId, "views", versionId, view + ".png");
    if (path.resolve(this.root, result.file) !== expected)
      throw new Error("Unexpected view render location.");
    return fs.readFile(expected);
  }
  /**
   * Starts a repaint job from a finished drawing edit: the edited view and the mask it was
   * painted with. Only the masked, visible part of the view changes the parent's texture.
   */
  async repaintBytes(
    projectId: string,
    revision: number,
    input: {
      versionId: string;
      view: Gen3DRepaintView;
      /** The drawing edit's input; must be this version's own render of the view. */
      viewImage: Uint8Array;
      image: Uint8Array;
      mask: Uint8Array;
      imageJobId: string;
      imageAssetId: string;
      instruction: string;
      feather: number;
    },
  ) {
    if (!GEN3D_REPAINT_VIEWS.includes(input.view)) throw new Error("Unsupported repaint view.");
    const rendered = await fs
      .readFile(
        await modelPath(this.root, projectId, "views", input.versionId, input.view + ".png"),
      )
      .catch(() => null);
    // Projection assumes the edit started from this exact render; anything else would misalign.
    if (!rendered || digest(rendered) !== digest(input.viewImage))
      throw new Error(
        "The edit was not made from this version's view render. Render the view again.",
      );
    if (!Number.isInteger(input.feather) || input.feather < 0 || input.feather > 48)
      throw new Error("Use a soft edge of 0–48 pixels.");
    const square = async (bytes: Uint8Array, label: string) => {
      const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: "error" });
      const { width = 0, height = 0 } = await image.metadata();
      // Providers may return another size; only a uniform scale keeps the view aligned.
      if (!width || Math.abs(width - height) > Math.max(2, width * 0.01))
        throw new Error(`The ${label} must be square like the view render.`);
      return image;
    };
    const image = await (
      await square(input.image, "edited image")
    )
      .removeAlpha()
      .resize(GEN3D_REPAINT_SIZE, GEN3D_REPAINT_SIZE, { fit: "fill" })
      .png()
      .toBuffer();
    const { data: alpha } = await (
      await square(input.mask, "mask")
    )
      .ensureAlpha()
      .resize(GEN3D_REPAINT_SIZE, GEN3D_REPAINT_SIZE, { fit: "fill", kernel: "nearest" })
      .extractChannel(3)
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!alpha.some((v) => v < 128)) throw new Error("Paint an area to repaint first.");
    // Stored in the image-edit convention: transparent pixels are the area to repaint.
    const rgba = Buffer.alloc(alpha.length * 4, 255);
    for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i]!;
    const mask = await sharp(rgba, {
      raw: { width: GEN3D_REPAINT_SIZE, height: GEN3D_REPAINT_SIZE, channels: 4 },
    })
      .png()
      .toBuffer();
    return this.lock(projectId, async () => {
      const p = await this.get(projectId);
      if (revision !== p.revision) throw new Error("3D project changed. Reload before saving.");
      if (p.archived) throw new Error("Restore this project before editing.");
      if (p.jobs.some((j) => active(j.status)))
        throw new Error("A model build is already in progress.");
      const parent = p.versions.find((v) => v.id === input.versionId);
      if (!baked(parent))
        throw new Error("Repaint needs an optimized version with baked textures.");
      const build = {
        source: "",
        prompt: "Repaint",
        parentVersionId: parent!.id,
        mode: "process" as const,
        ...(parent!.build.process ? { process: parent!.build.process } : {}),
        repaint: {
          view: input.view,
          imageJobId: input.imageJobId,
          imageAssetId: input.imageAssetId,
          instruction: input.instruction.trim().slice(0, 2000),
          feather: input.feather,
        },
      };
      const id = randomUUID();
      const job = (...parts: string[]) => modelPath(this.root, p.id, "jobs", id, ...parts);
      await atomicModelFile(await job("repaint-image.png"), image);
      await atomicModelFile(await job("repaint-mask.png"), mask);
      await atomicModelFile(
        await job("input.json"),
        JSON.stringify({ build, blueprint: p.blueprint }),
      );
      p.jobs.push({
        id,
        requestId: randomUUID(),
        fingerprint: digest(JSON.stringify(build)),
        createdAt: now(),
        status: "queued",
        build,
        runId: null,
        turnId: null,
        error: null,
        versionId: null,
      });
      await this.save(p);
      void this.execute(p.id, id);
      return { project: p } satisfies Gen3DCommandResult;
    });
  }
  async command(raw: Gen3DCommand): Promise<Gen3DCommandResult> {
    const c = Schema.decodeUnknownSync(Gen3DCommand)(raw);
    if (c.operation === "environment")
      return { project: null, environment: await this.environment() };
    if (
      c.operation === "import-reference-asset" ||
      c.operation === "import-texture-asset" ||
      c.operation === "render-view" ||
      c.operation === "repaint"
    )
      throw new Error("Drawing assets are exchanged through the workbench service.");
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
            const result = await this.host<{ exportPath?: string }>(
              "export",
              {
                projectId: p.id,
                versionId: version.id,
                preset: c.exportPreset ?? "generic",
                ...(c.exportFormat ? { format: c.exportFormat } : {}),
              },
              undefined,
              // Non-GLB formats convert in background Blender first.
              GEN3D_LIMITS.processMs + 120_000,
            );
            return { project: p, ...result };
          }
          case "optimize": {
            if (p.archived) throw new Error("Restore this project before optimizing.");
            if (p.jobs.some((j) => active(j.status)))
              throw new Error("A model build is already in progress.");
            const parent = p.versions.find((v) => v.id === (c.versionId ?? p.previewVersionId));
            if (!parent || !c.process)
              throw new Error("Choose a version and optimization settings.");
            if (
              (c.process.texture === "projection" || c.process.materials?.length) &&
              !c.process.bake
            )
              throw new Error("Reference projection and material presets need baked textures.");
            for (const material of c.process.materials ?? []) {
              const texture =
                material.tile && p.textures?.find((t) => t.id === material.tile!.textureId);
              if ((material.preset === "tiled") !== !!material.tile)
                throw new Error("Tiled materials need a texture, other presets none.");
              if (material.tile && !texture) throw new Error("Tiled texture not found.");
            }
            if (c.process.texture === "projection") {
              if (!p.blueprint?.confirmed || !parent.score)
                throw new Error(
                  "Reference projection needs a confirmed blueprint and a scored version.",
                );
              // Projection reuses the version's blueprint registration; a newer blueprint would not match it.
              if (p.blueprint.createdAt > parent.createdAt)
                throw new Error(
                  "The blueprint changed after this version was scored. Build a new version first.",
                );
            }
            if (!(await this.environment()).blender?.headless)
              throw new Error("Optimization needs Blender. Set it up in the 3D workshop.");
            const build = {
              source: "",
              prompt: "Optimize",
              parentVersionId: parent.id,
              mode: "process" as const,
              process: c.process,
            };
            const id = randomUUID();
            p.jobs.push({
              id,
              requestId: c.requestId ?? randomUUID(),
              fingerprint: digest(JSON.stringify(build)),
              createdAt: now(),
              status: "queued",
              build,
              runId: null,
              turnId: null,
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
          case "rig": {
            if (p.archived) throw new Error("Restore this project before rigging.");
            if (p.jobs.some((j) => active(j.status)))
              throw new Error("A model build is already in progress.");
            const parent = p.versions.find((v) => v.id === (c.versionId ?? p.previewVersionId));
            if (!parent) throw new Error("Choose a version to rig.");
            if (!rigSkeleton(p, parent))
              throw new Error(
                "This version has no skeleton. Confirm joints for it, or rig a version built with a skeleton.",
              );
            const clips = [...new Set(c.clips ?? [])];
            if (!clips.length || clips.some((clip) => !GEN3D_ANIMATION_CLIPS.includes(clip)))
              throw new Error("Choose at least one animation clip.");
            if (!(await this.environment()).blender?.headless)
              throw new Error("Rigging needs Blender. Set it up in the 3D workshop.");
            const build = {
              source: "",
              prompt: "Rig",
              parentVersionId: parent.id,
              mode: "process" as const,
              rig: { clips },
            };
            const id = randomUUID();
            p.jobs.push({
              id,
              requestId: c.requestId ?? randomUUID(),
              fingerprint: digest(JSON.stringify(build)),
              createdAt: now(),
              status: "queued",
              build,
              runId: null,
              turnId: null,
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
          case "stylize": {
            if (p.archived) throw new Error("Restore this project before stylizing.");
            if (p.jobs.some((j) => active(j.status)))
              throw new Error("A model build is already in progress.");
            const parent = p.versions.find((v) => v.id === (c.versionId ?? p.previewVersionId));
            if (!parent || !c.stylize) throw new Error("Choose a version and a style.");
            const range = GEN3D_STYLES[c.stylize.style];
            if (c.stylize.detail < range.min || c.stylize.detail > range.max)
              throw new Error(`Use a detail of ${range.min}–${range.max} for this style.`);
            if (!(await this.environment()).blender?.headless)
              throw new Error("Stylizing needs Blender. Set it up in the 3D workshop.");
            const build = {
              source: "",
              prompt: "Stylize",
              parentVersionId: parent.id,
              mode: "process" as const,
              stylize: c.stylize,
            };
            const id = randomUUID();
            p.jobs.push({
              id,
              requestId: c.requestId ?? randomUUID(),
              fingerprint: digest(JSON.stringify(build)),
              createdAt: now(),
              status: "queued",
              build,
              runId: null,
              turnId: null,
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
          case "set-skeleton":
          case "propose-skeleton": {
            if (p.archived) throw new Error("Restore this project before editing.");
            const version = p.versions.find((v) => v.id === c.versionId);
            if (!version || !c.skeleton) throw new Error("Choose a version and its joints.");
            const skeletons = (p.skeletons ??= []);
            const index = skeletons.findIndex((s) => s.versionId === version.id);
            if (!c.skeleton.length) {
              if (c.operation === "propose-skeleton")
                throw new Error("Propose at least one joint.");
              if (index >= 0) skeletons.splice(index, 1);
              break;
            }
            validateSkeleton(c.skeleton);
            // Joints must sit on the model: inside its bounds with a margin for tips and ears.
            const [w = 0, h = 0, d = 0] = version.report.dimensions;
            const margin = 0.25 * Math.max(w, h, d);
            for (const node of c.skeleton) {
              const [x, y, z] = node.position;
              if (
                Math.abs(x) > w / 2 + margin ||
                y < -margin ||
                y > h + margin ||
                Math.abs(z) > d / 2 + margin
              )
                throw new Error(
                  `Joint ${node.id} lies outside the model (${w.toFixed(2)} × ${h.toFixed(2)} × ${d.toFixed(2)} m, bottom centre at the origin).`,
                );
            }
            const entry = {
              versionId: version.id,
              nodes: c.skeleton,
              // The agent only proposes; the user confirms in the workbench.
              origin:
                c.operation === "propose-skeleton" ? ("ai" as const) : (c.skeletonOrigin ?? "user"),
              confirmed: c.operation === "set-skeleton" && c.confirmed === true,
              updatedAt: now(),
            };
            if (index >= 0) skeletons[index] = entry;
            else {
              if (skeletons.length >= 64) throw new Error("A project keeps at most 64 joint sets.");
              skeletons.push(entry);
            }
            break;
          }
          case "submit": {
            if (p.archived) throw new Error("Restore this project before building.");
            if (p.jobs.some((j) => active(j.status)))
              throw new Error("A model build is already in progress. Read its status first.");
            const build = c.build;
            if (!build?.source.trim()) throw new Error("Provide modeling source.");
            if (
              build.mode === "process" ||
              build.process ||
              build.repaint ||
              build.rig ||
              build.stylize
            )
              throw new Error(
                "Optimization and repaint are workbench operations, not modeling builds.",
              );
            if (Buffer.byteLength(build.source) > GEN3D_LIMITS.sourceBytes)
              throw new Error("Model source exceeds 1 MiB.");
            if (build.parentVersionId && !p.versions.some((v) => v.id === build.parentVersionId))
              throw new Error("Parent model version not found.");
            if (build.skeleton) validateSkeleton(build.skeleton);
            if (build.mode === "blender") {
              // Checked before a round is spent: a missing runtime is not the model's mistake.
              const blender = (await this.environment()).blender;
              if (!blender?.ready)
                throw new Error(
                  "Blender is not ready" +
                    (blender?.error ? ` (${blender.error})` : "") +
                    '. Use mode "threejs", or ask the user to set up Blender in the 3D workshop.',
                );
            }
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
            if (build.skeleton)
              await atomicModelFile(
                await modelPath(this.root, p.id, "jobs", id, "skeleton.json"),
                JSON.stringify({ format: 1, units: "meters", upAxis: "Y", nodes: build.skeleton }),
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
      const { pxPerMetre, mode } = await this.lock(projectId, async () => {
        const p = await this.get(projectId),
          job = p.jobs.find((j) => j.id === jobId);
        if (job?.status === "cancelled") throw new Error("Build cancelled.");
        this.updateJob(p, jobId, { status: "running" });
        await this.save(p);
        return { pxPerMetre: p.blueprint?.pxPerMetre ?? null, mode: job?.build.mode ?? "threejs" };
      });
      const result = await this.host<Gen3DBuildResult>(
        "build",
        { projectId, jobId, pxPerMetre },
        controller.signal,
        BUILD_REQUEST_MS[mode],
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
        for (const name of GEN3D_DERIVED_MODELS) {
          const file = await dir(name);
          if (await fs.stat(file).catch(() => null)) await this.validate(await readModel(file));
        }
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
          runtime: {
            three: GEN3D_LIMITS.threeVersion,
            ...(mode !== "threejs" ? { blender: result.blender ?? null } : {}),
          },
          ...(result.process ? { process: result.process } : {}),
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
    if (kind === "textures") {
      if (!p.textures?.some((t) => t.id === id)) throw new Error("Texture not found.");
      return fs.readFile(await modelPath(this.root, projectId, "textures", id + ".png"));
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
