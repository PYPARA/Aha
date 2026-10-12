import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  SpriteState,
  type SpriteCommand,
  type SpriteContext,
  type SpriteRun,
  type ImageJobEvent,
} from "@synara/contracts";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { writeFileStringAtomically } from "../atomicWrite";
import { processSprite, spriteLayoutGuide } from "./processSprite";

export class SpriteEngine {
  private states = new Map<string, SpriteState>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private images: ImageGenerationEngine,
    private emit: (event: ImageJobEvent) => Promise<void>,
  ) {}
  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const file of await readdir(this.root))
      if (/^[\w-]+\.json$/.test(file)) await this.state(file.slice(0, -5));
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async state(id: string) {
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid sprite project.");
    const cached = this.states.get(id);
    if (cached) return cached;
    let state: SpriteState = { context: null, runs: [] };
    try {
      state = Schema.decodeUnknownSync(SpriteState)(
        JSON.parse(await readFile(path.join(this.root, `${id}.json`), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.retain(state);
    this.states.set(id, state);
    return state;
  }
  private retain(state: SpriteState) {
    if (state.context?.referenceAssetId)
      this.images.spriteAssetIds.add(state.context.referenceAssetId);
    for (const run of state.runs) {
      if (run.context.referenceAssetId)
        this.images.spriteAssetIds.add(run.context.referenceAssetId);
      if (run.source) this.images.spriteAssetIds.add(run.source.id);
      for (const frame of run.frames) this.images.spriteAssetIds.add(frame.id);
    }
  }
  private async save(id: string, state: SpriteState) {
    await mkdir(this.root, { recursive: true });
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.root, `${id}.json`),
        contents: JSON.stringify(state),
      }),
    );
    this.retain(state);
    this.states.set(id, state);
    await this.emit({ type: "sprite-changed", projectId: id });
  }
  async forThread(threadId: string): Promise<SpriteState | null> {
    // Bindings persist separately so the gateway can resolve them after a restart.
    try {
      const id = await readFile(path.join(this.root, `thread-${threadId}.txt`), "utf8");
      const state = await this.state(id);
      return state.context?.threadId === threadId ? state : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  command(command: SpriteCommand): Promise<SpriteState> {
    return this.locked(async () => {
      const state = await this.state(command.projectId);
      if (command.operation === "get") {
        await this.refresh(command.projectId, state);
        return this.state(command.projectId);
      }
      if (command.operation === "sync") {
        if (!command.context || command.context.projectId !== command.projectId)
          throw new Error("Matching context is required.");
        if (command.context.threadId) {
          await mkdir(this.root, { recursive: true });
          await Effect.runPromise(
            writeFileStringAtomically({
              filePath: path.join(this.root, `thread-${command.context.threadId}.txt`),
              contents: command.projectId,
            }),
          );
        }
        const next = { ...state, context: command.context };
        await this.save(command.projectId, next);
        return next;
      }
      if (command.operation === "cancel") {
        const run = state.runs.find((r) => r.id === command.runId);
        if (!run) throw new Error("Generation not found.");
        if (
          ["ready", "needs-adjustment", "failed", "interrupted", "cancelled"].includes(run.status)
        )
          return state;
        if (run.jobId) await this.images.cancelJob(run.jobId);
        const next = {
          ...state,
          runs: state.runs.map((r) =>
            r.id === run.id ? { ...r, status: "cancelled" as const } : r,
          ),
        };
        await this.save(command.projectId, next);
        return next;
      }
      const original =
        command.operation === "retry" ? state.runs.find((r) => r.id === command.runId) : null;
      if (command.operation === "retry" && !original) throw new Error("Generation not found.");
      const input =
        command.input ?? (original ? { ...original.input, requestId: randomUUID() } : null);
      if (!input?.prompt.trim()) throw new Error("A generation prompt is required.");
      if (state.runs.some((r) => r.input.requestId === input.requestId)) return state;
      const base = original?.context ?? state.context;
      if (!base) throw new Error("Open a sprite workbench and select a drawing channel first.");
      const context: SpriteContext = {
        ...base,
        fps: input.fps ?? base.fps,
        action: input.action ?? base.action,
        frameCount: input.kind === "character" ? 1 : (input.frameCount ?? base.frameCount),
      };
      if (context.width * context.height * context.frameCount > 64_000_000)
        throw new Error(
          "Generated frames exceed 64 megapixels. Reduce canvas size or frame count.",
        );
      if (input.kind === "animation" && !context.referenceAssetId)
        throw new Error("Choose a canonical character reference before generating animation.");
      // Record intent before submission. A crash can only replay the same idempotency key.
      const run: SpriteRun = {
        id: randomUUID(),
        input,
        context,
        jobId: null,
        status: "queued",
        source: null,
        frames: [],
        warnings: [],
        error: null,
        createdAt: new Date().toISOString(),
      };
      const next = { ...state, runs: [...state.runs, run] };
      await this.save(command.projectId, next);
      await this.submit(command.projectId, next, run);
      return this.state(command.projectId);
    });
  }
  private async submit(id: string, state: SpriteState, run: SpriteRun) {
    try {
      const c = run.context,
        animation = run.input.kind === "animation";
      const inputs: string[] = c.referenceAssetId ? [c.referenceAssetId] : [];
      if (animation)
        inputs.push(
          (await this.images.upload(await spriteLayoutGuide(c.frameCount), "sprite-layout.png")).id,
        );
      const prompt = `${run.input.prompt}\n${animation ? `Create ONE horizontal strip of exactly ${c.frameCount} consecutive frames for action "${c.action}". Read left to right. Use the first reference as the authoritative character identity: same face, palette, proportions, material, clothing and props. The second reference is layout only; do not reproduce its grid. Keep each whole-body pose inside its equal-width slot with 10% safe padding. Use one fixed camera and shared scale and ground coordinate. Preserve intentional vertical movement. Make a complete readable motion cycle.` : "Create a single complete character reference with a clear whole-body silhouette and neutral pose."}\n${c.background === "chroma" ? `Use a perfectly flat ${c.chromaKey} background; avoid this color on the character.` : "Use a transparent background."} No labels, borders, text, scene, floor shadows, detached effects or visible grid.`;
      const job = await this.images.createJob({
        clientRequestId: `sprite-${createHash("sha256").update(`${id}:${run.input.requestId}`).digest("hex")}`,
        providerId: c.providerId,
        model: c.model,
        prompt,
        parameters: {
          n: 1,
          outputFormat: "png",
          background: c.background === "transparent" ? "transparent" : "opaque",
        },
        inputAssetIds: inputs,
        maskAssetId: null,
        sourceJobId: null,
      });
      await this.save(id, {
        ...state,
        runs: state.runs.map((r) =>
          r.id === run.id ? { ...r, jobId: job.id, status: "running" } : r,
        ),
      });
    } catch (e) {
      await this.save(id, {
        ...state,
        runs: state.runs.map((r) =>
          r.id === run.id
            ? { ...r, status: "failed", error: String(e instanceof Error ? e.message : e) }
            : r,
        ),
      });
    }
  }
  private async refresh(id: string, state: SpriteState) {
    for (const run of state.runs) {
      if (!["queued", "running", "processing"].includes(run.status)) continue;
      if (!run.jobId) {
        // Never resubmit uncertain upstream work after a restart.
        await this.replace(id, run, {
          status: "interrupted",
          error: "Submission was interrupted. Retry explicitly.",
        });
        continue;
      }
      try {
        const job = await this.images.getJob(run.jobId);
        if (["failed", "interrupted", "cancelled"].includes(job.status)) {
          await this.replace(id, run, {
            status: job.status as "failed" | "interrupted" | "cancelled",
            error: job.error?.message ?? null,
          });
          continue;
        }
        if (job.status !== "succeeded" && job.status !== "partial") continue;
        const source = job.outputs[0];
        if (!source) throw new Error("Image generation returned no image.");
        await this.replace(id, run, { status: "processing", source });
        const processed = await processSprite(
          await this.images.assets.read(source, "edit"),
          run.context,
        );
        const frames = [];
        for (const [i, bytes] of processed.frames.entries())
          frames.push(await this.images.upload(bytes, `${run.context.action}-${i + 1}.png`));
        await this.replace(id, run, {
          source,
          frames,
          warnings: processed.warnings,
          status: processed.warnings.length ? "needs-adjustment" : "ready",
        });
      } catch (e) {
        await this.replace(id, run, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  private async replace(id: string, run: SpriteRun, patch: Partial<SpriteRun>) {
    const current = await this.state(id);
    await this.save(id, {
      ...current,
      // Copy-on-write preserves snapshots held by in-flight readers.
      // eslint-disable-next-line no-map-spread
      runs: current.runs.map((r) => (r.id === run.id ? { ...r, ...patch } : r)),
    });
  }
  tick() {
    return this.locked(async () => {
      for (const [id, state] of this.states) await this.refresh(id, state);
    });
  }
}
