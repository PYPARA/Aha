import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  SpriteState,
  SpritePlanConfiguration,
  compileSpritePlan,
  spritePlanActions,
  spriteRecommendedSize,
  spriteGridSlice,
  SPRITE_ANALYSIS_VERSION,
  type SpriteSliceConfiguration,
  spritePlanLayout,
  spritePlanIssues,
  spritePlanForRevision,
  spritePlanPrompt,
  spriteTaskConfiguration,
  type SpriteGenerationPlan,
  type SpritePlanConfirmInput,
  type ImageAsset,
  type SpriteCommand,
  type SpriteRun,
  type SpriteCandidate,
  type ImageJobEvent,
} from "@synara/contracts";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { writeFileStringAtomically } from "../atomicWrite";
import { analyzeSprite, processSprite, spriteLayoutGuide } from "./processSprite";

export class SpriteEngine {
  private states = new Map<string, SpriteState>();
  private deleted = new Set<string>();
  private removedThreads = new Set<string>();
  private pendingThreadRemovals = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private images: ImageGenerationEngine,
    private emit: (event: ImageJobEvent) => Promise<void>,
  ) {}
  async initialize() {
    await mkdir(this.root, { recursive: true });
    const files = await readdir(this.root);
    for (const file of files) {
      const removed = /^unbound-([\w-]+)\.txt$/.exec(file);
      if (removed) this.removedThreads.add(removed[1]!);
      const match = /^deleted-([\w-]+)\.txt$/.exec(file);
      if (match) this.deleted.add(match[1]!);
    }
    for (const file of files)
      if (/^[\w-]+\.json$/.test(file) && !this.deleted.has(file.slice(0, -5)))
        await this.state(file.slice(0, -5));
    for (const id of this.deleted) {
      try {
        await this.removeProject(id);
      } catch (e) {
        console.warn(
          "Sprite deletion will need retry:",
          id,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    // Intent files survive crashes and partial cancellation failures.
    for (const threadId of this.removedThreads) {
      this.pendingThreadRemovals.add(threadId);
      try {
        await this.removeThread(threadId);
      } catch (error) {
        console.warn(
          "Sprite conversation removal will need retry:",
          threadId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.rebuildReferences();
  }
  private rebuildReferences() {
    this.images.spriteAssetIds.clear();
    for (const [id, state] of this.states) if (!this.deleted.has(id)) this.retain(state);
  }
  private async removeProject(id: string): Promise<SpriteState> {
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid sprite project.");
    let state = this.states.get(id);
    if (!state) {
      try {
        state = Schema.decodeUnknownSync(SpriteState)(
          JSON.parse(await readFile(path.join(this.root, `${id}.json`), "utf8")),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = { context: null, runs: [] };
      }
    }
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.root, `deleted-${id}.txt`),
        contents: id,
      }),
    );
    this.deleted.add(id);
    // Persist the intent before cancelling: late sync/get/generate calls cannot recreate it.
    for (const run of state.runs) {
      if (!["queued", "running", "processing"].includes(run.status)) continue;
      const jobId = run.jobId ?? (await this.submittedJob(id, run))?.id;
      if (jobId) await this.images.cancelJob(jobId);
    }
    for (const file of await readdir(this.root)) {
      if (!/^thread-[\w-]+\.txt$/.test(file)) continue;
      if ((await readFile(path.join(this.root, file), "utf8")) === id)
        await rm(path.join(this.root, file), { force: true });
    }
    await rm(path.join(this.root, `${id}.json`), { force: true });
    this.states.delete(id);
    this.rebuildReferences();
    await this.emit({ type: "sprite-changed", projectId: id });
    return { context: null, runs: [] };
  }

  async detachThread(threadId: string) {
    return this.locked(() => this.removeThread(threadId));
  }
  private async removeThread(threadId: string) {
    if (!/^[\w-]{1,128}$/.test(threadId)) throw new Error("Invalid sprite conversation.");
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.root, `unbound-${threadId}.txt`),
        contents: threadId,
      }),
    );
    this.removedThreads.add(threadId);
    this.pendingThreadRemovals.add(threadId);
    for (const [id, state] of this.states) {
      if (this.deleted.has(id)) continue;
      const runs = [...state.runs];
      for (const [index, run] of runs.entries()) {
        if (
          run.context.threadId !== threadId ||
          !["queued", "running", "processing"].includes(run.status)
        )
          continue;
        const jobId = run.jobId ?? (await this.submittedJob(id, run))?.id ?? null;
        if (jobId) await this.images.cancelJob(jobId);
        runs[index] = { ...run, jobId, status: "cancelled" };
      }
      const ids = state.threadIds ?? (state.context?.threadId ? [state.context.threadId] : []);
      if (ids.includes(threadId) || runs.some((run, i) => run !== state.runs[i])) {
        await this.save(id, {
          ...state,
          selectedReferences: state.selectedReferences?.filter((r) => r.threadId !== threadId),
          plans: state.plans?.map((p) =>
            p.threadId === threadId && p.status === "draft"
              ? { ...p, status: "dismissed" as const }
              : p,
          ),
          runs,
          threadIds: ids.filter((id) => id !== threadId),
          context:
            state.context?.threadId === threadId
              ? { ...state.context, threadId: null }
              : state.context,
          turnContexts: state.turnContexts?.filter((entry) => entry.threadId !== threadId),
        });
      }
    }
    await rm(path.join(this.root, `thread-${threadId}.txt`), { force: true });
    this.pendingThreadRemovals.delete(threadId);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async state(id: string) {
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid sprite project.");
    if (this.deleted.has(id)) throw new Error("This sprite project has been deleted.");
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
    const latest = new Map<string, string>();
    for (const plan of (state.plans ?? [])
      .toReversed()
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (plan.status === "draft" && !latest.has(plan.threadId)) latest.set(plan.threadId, plan.id);
    let migrated = false;
    state = {
      ...state,
      plans: state.plans?.map((plan) => {
        const current = latest.get(plan.threadId);
        if (plan.status === "draft" && current !== plan.id) {
          migrated = true;
          return {
            ...plan,
            status: "dismissed" as const,
            supersededBy: current,
            version: plan.version + 1,
          };
        }
        if (
          plan.status === "draft" &&
          (plan.configuration.creative ||
            plan.configuration.needsReview ||
            (!plan.configuration.prompt && plan.configuration.legacyPrompt))
        ) {
          migrated = true;
          const configuration = spritePlanForRevision(plan.configuration);
          return {
            ...plan,
            configuration,
            compiled: compileSpritePlan(configuration),
            version: plan.version + 1,
          };
        }
        return plan;
      }),
    };
    this.retain(state);
    this.states.set(id, state);
    if (migrated) await this.save(id, state);
    return state;
  }
  private retain(state: SpriteState) {
    if (state.context?.referenceAssetId)
      this.images.spriteAssetIds.add(state.context.referenceAssetId);
    for (const entry of state.referencePool ?? [])
      this.images.spriteAssetIds.add(entry.reference.asset.id);
    for (const entry of state.selectedReferences ?? [])
      this.images.spriteAssetIds.add(entry.reference.asset.id);
    for (const plan of state.plans ?? [])
      for (const r of plan.configuration.references) this.images.spriteAssetIds.add(r.asset.id);
    for (const run of state.runs) {
      if (run.context.referenceAssetId)
        this.images.spriteAssetIds.add(run.context.referenceAssetId);
      for (const reference of run.configuration?.references ?? [])
        this.images.spriteAssetIds.add(reference.asset.id);
      for (const candidate of run.candidates ?? []) {
        this.images.spriteAssetIds.add(candidate.source.id);
        for (const frame of [
          ...candidate.frames,
          ...(candidate.processingVersions ?? []).flatMap((v) => v.frames),
        ])
          this.images.spriteAssetIds.add(frame.id);
      }
      if (run.source) this.images.spriteAssetIds.add(run.source.id);
      for (const frame of run.frames) this.images.spriteAssetIds.add(frame.id);
    }
  }
  private async save(id: string, state: SpriteState) {
    await mkdir(this.root, { recursive: true });
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: path.join(this.root, `${id}.json`),
        contents: JSON.stringify({ ...state, resultPlanId: undefined }),
      }),
    );
    this.states.set(id, { ...state, resultPlanId: undefined });
    this.rebuildReferences();
    await this.emit({ type: "sprite-changed", projectId: id });
  }
  async forThread(threadId: string, turnId?: string): Promise<SpriteState | null> {
    return this.locked(async () => {
      if (!/^[\w-]{1,128}$/.test(threadId) || (turnId && !/^[\w-]{1,128}$/.test(turnId)))
        throw new Error("Invalid sprite conversation.");
      if (this.removedThreads.has(threadId)) return null;
      try {
        const id = await readFile(path.join(this.root, `thread-${threadId}.txt`), "utf8");
        if (this.deleted.has(id)) return null;
        let state = await this.state(id);
        const ids = state.threadIds ?? (state.context?.threadId ? [state.context.threadId] : []);
        if (!ids.includes(threadId) || !state.context) return null;
        let context = { ...state.context, threadId, referenceAssetId: null };
        if (turnId) {
          const frozen = state.turnContexts?.find(
            (t) => t.threadId === threadId && t.turnId === turnId,
          );
          if (frozen) context = { ...frozen.context, threadId, referenceAssetId: null };
          else {
            state = {
              ...state,
              turnContexts: [...(state.turnContexts ?? []), { threadId, turnId, context }],
            };
            await this.save(id, state);
          }
        }
        return { ...state, context };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    });
  }
  command(command: SpriteCommand, trustedReferences = false): Promise<SpriteState> {
    return this.locked(async () => {
      if (command.operation === "delete") return this.removeProject(command.projectId);
      const state = await this.state(command.projectId);
      if (command.operation === "inspect-source") {
        if (
          trustedReferences ||
          !command.context ||
          command.context.projectId !== command.projectId ||
          !command.references?.[0]
        )
          throw new Error("Matching source context is required.");
        const source = await this.images.getAsset(command.references[0].asset.id);
        const existing = state.runs.find((r) => r.input.requestId === `source:${source.id}`);
        if (existing) return state;
        const configuration = command.configuration;
        const run: SpriteRun = {
          id: randomUUID(),
          context: command.context,
          input: {
            kind: "animation",
            prompt: "Imported source slicing",
            requestId: `source:${source.id}`,
          },
          jobId: null,
          imageStatus: "imported",
          status: "processing",
          source,
          frames: [],
          warnings: [],
          error: null,
          createdAt: new Date().toISOString(),
          ...(configuration ? { configuration } : {}),
        };
        const candidate = await this.processCandidate(run, source);
        const next = {
          ...state,
          runs: [
            ...state.runs,
            {
              ...run,
              candidates: [candidate],
              selectedCandidateId: candidate.id,
              status: candidate.status === "pending" ? ("processing" as const) : candidate.status,
              frames: candidate.frames,
              actions: candidate.actions,
              warnings: candidate.warnings,
              error: candidate.error,
            },
          ],
        };
        await this.save(command.projectId, next);
        return next;
      }
      if (command.operation === "import-references") {
        const threadId = command.threadId;
        if (
          trustedReferences ||
          !threadId ||
          !(state.threadIds ?? []).includes(threadId) ||
          this.removedThreads.has(threadId)
        )
          throw new Error("An available conversation is required.");
        const imported = [];
        for (const reference of command.references ?? []) {
          const asset = await this.images.getAsset(reference.asset.id);
          imported.push({ threadId, reference: { ...reference, asset } });
        }
        const pool = new Map(
          (state.referencePool ?? []).map((r) => [`${r.threadId}:${r.reference.asset.id}`, r]),
        );
        for (const r of imported) pool.set(`${threadId}:${r.reference.asset.id}`, r);
        const next = { ...state, referencePool: [...pool.values()] };
        await this.save(command.projectId, next);
        return next;
      }
      if (command.operation === "select-reference")
        throw new Error("Add images to a generation plan instead.");
      if (command.operation === "remove-run" || command.operation === "restore-run") {
        const ids = new Set(command.runIds ?? [command.runId]);
        const targets = state.runs.filter((r) => ids.has(r.id));
        if (targets.some((r) => ["queued", "running", "processing"].includes(r.status)))
          throw new Error("Cancel active tasks before removing them.");
        const next = {
          ...state,
          runs: state.runs.map((r) =>
            ids.has(r.id)
              ? {
                  ...r,
                  removedAt: command.operation === "remove-run" ? new Date().toISOString() : null,
                }
              : r,
          ),
        };
        await this.save(command.projectId, next);
        return next;
      }
      if (
        ["analyze-candidate", "preview-slicing", "save-slicing", "restore-slicing"].includes(
          command.operation,
        )
      ) {
        const run = state.runs.find((r) => r.id === command.runId);
        const candidate = run?.candidates?.find((c) => c.id === command.candidateId);
        if (!run || !candidate || run.input.kind !== "animation")
          throw new Error("Animation candidate not found.");
        if (command.version !== (candidate.version ?? 0))
          throw new Error("Candidate changed. Refresh before editing.");
        const descriptors = run.configuration
          ? spritePlanActions(run.configuration)
          : (run.actions?.map((a) => a.action) ?? []);
        const bytes = await this.images.assets.read(candidate.source, "edit");
        if (command.operation === "analyze-candidate") {
          const analysis = await analyzeSprite(bytes, run.context, descriptors, candidate.id);
          const updated = {
            ...candidate,
            ...(candidate.slice ? { slice: { ...candidate.slice, reviewedActionIds: [] } } : {}),
            analysis,
            issues: [
              ...(candidate.issues ?? []).filter(
                (issue) =>
                  !candidate.analysis?.issues.some(
                    (old) =>
                      old.code === issue.code &&
                      old.actionId === issue.actionId &&
                      old.frameIndex === issue.frameIndex,
                  ),
              ),
              ...analysis.issues,
            ],
            version: (candidate.version ?? 0) + 1,
          };
          await this.selectProcessed(command.projectId, run, updated);
        } else {
          const restored = candidate.processingVersions?.find(
            (v) => v.id === command.processingVersionId,
          );
          const slice =
            command.operation === "restore-slicing" ? restored?.configuration : command.slice;
          if (!slice) throw new Error("Slicing configuration is required.");
          const updated = await this.processCandidate(run, candidate.source, slice, candidate);
          if (updated.status === "failed")
            throw new Error(updated.error ?? "Frame processing failed.");
          if (command.operation === "preview-slicing")
            return {
              ...state,
              runs: state.runs.map((r) =>
                r.id === run.id
                  ? {
                      ...r,
                      candidates: r.candidates!.map((c) => (c.id === updated.id ? updated : c)),
                    }
                  : r,
              ),
            };
          await this.selectProcessed(command.projectId, run, updated);
        }
        return this.state(command.projectId);
      }
      if (command.operation === "select-candidate") {
        const run = state.runs.find((r) => r.id === command.runId);
        const candidate = run?.candidates?.find((c) => c.id === command.candidateId);
        if (!run || !candidate) throw new Error("Candidate not found.");
        const selected =
          candidate.status === "pending"
            ? await this.processCandidate(run, candidate.source)
            : candidate;
        await this.replace(command.projectId, run, {
          candidates: run.candidates!.map((c) => (c.id === selected.id ? selected : c)),
          selectedCandidateId: selected.id,
          source: selected.source,
          frames: selected.frames,
          actions: selected.actions,
          warnings: selected.warnings,
          status:
            selected.status === "processing"
              ? "processing"
              : selected.status === "pending"
                ? "processing"
                : selected.status,
          error: selected.error,
        });
        return this.state(command.projectId);
      }
      if (command.operation === "capture-references") {
        const threadId = command.context?.threadId;
        if (
          !trustedReferences ||
          !threadId ||
          !(state.threadIds ?? [state.context?.threadId]).includes(threadId) ||
          this.removedThreads.has(threadId)
        )
          throw new Error("References must be resolved by the conversation gateway.");
        const captured = (command.references ?? []).map((reference) => ({ threadId, reference }));
        const ids = new Set(captured.map((r) => r.reference.referenceId));
        const next = {
          ...state,
          referencePool: [
            ...(state.referencePool ?? []).filter(
              (r) => r.threadId !== threadId || !ids.has(r.reference.referenceId),
            ),
            ...captured,
          ],
        };
        await this.save(command.projectId, next);
        return next;
      }
      if (command.operation === "get") {
        await this.refresh(command.projectId, state);
        return this.state(command.projectId);
      }
      if (command.operation === "sync") {
        if (!command.context || command.context.projectId !== command.projectId)
          throw new Error("Matching context is required.");
        const ids = (
          command.threadIds ?? [
            ...new Set([
              ...(state.threadIds ?? (state.context?.threadId ? [state.context.threadId] : [])),
              ...(command.context.threadId ? [command.context.threadId] : []),
            ]),
          ]
        ).filter((id) => !this.removedThreads.has(id));
        if (
          command.context.threadId &&
          !this.removedThreads.has(command.context.threadId) &&
          !ids.includes(command.context.threadId)
        )
          throw new Error("Invalid sprite conversation selection.");
        for (const threadId of ids) {
          await mkdir(this.root, { recursive: true });
          const filePath = path.join(this.root, `thread-${threadId}.txt`);
          try {
            const bound = await readFile(filePath, "utf8");
            if (bound !== command.projectId)
              throw new Error("Conversation belongs to another sprite project.");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await Effect.runPromise(
            writeFileStringAtomically({ filePath, contents: command.projectId }),
          );
        }
        for (const id of state.threadIds ??
          (state.context?.threadId ? [state.context.threadId] : []))
          if (!ids.includes(id)) {
            const file = path.join(this.root, `thread-${id}.txt`);
            try {
              if ((await readFile(file, "utf8")) === command.projectId)
                await rm(file, { force: true });
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
          }
        const next = {
          ...state,
          context: {
            ...command.context,
            referenceAssetId: null,
            threadId:
              command.context.threadId && this.removedThreads.has(command.context.threadId)
                ? null
                : command.context.threadId,
          },
          threadIds: ids,
        };
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
        const jobId = run.jobId ?? (await this.submittedJob(command.projectId, run))?.id ?? null;
        if (jobId) await this.images.cancelJob(jobId);
        const next = {
          ...state,
          runs: state.runs.map((r) =>
            r.id === run.id ? { ...r, jobId, status: "cancelled" as const } : r,
          ),
        };
        await this.save(command.projectId, next);
        return next;
      }
      if (["update-plan", "dismiss-plan"].includes(command.operation)) {
        const plan = state.plans?.find((p) => p.id === command.planId);
        if (
          !plan ||
          plan.status !== "draft" ||
          !(state.threadIds ?? [state.context?.threadId]).includes(plan.threadId)
        )
          throw new Error("This plan is no longer editable.");
        if (command.version !== plan.version)
          throw new Error("Plan changed. Refresh before editing or confirming.");
        if (command.context?.threadId && command.context.threadId !== plan.threadId)
          throw new Error("Plan belongs to another conversation.");
        if (this.removedThreads.has(plan.threadId))
          throw new Error("This conversation has been deleted.");
        let configuration = spritePlanForRevision(command.configuration ?? plan.configuration);
        if (configuration.sizeSource === "recommended")
          configuration = {
            ...configuration,
            parameters: { ...configuration.parameters, size: spriteRecommendedSize(configuration) },
          };
        // Clients may choose only references captured and owned by this conversation.
        if (!trustedReferences) this.validateReferences(state, plan.threadId, configuration);
        const updated = {
          ...plan,
          configuration,
          compiled: compileSpritePlan(configuration),
          version: plan.version + 1,
          status:
            command.operation === "dismiss-plan" ? ("dismissed" as const) : ("draft" as const),
        };
        const next = { ...state, plans: state.plans!.map((p) => (p.id === plan.id ? updated : p)) };
        await this.save(command.projectId, next);
        return next;
      }
      const original = command.runId ? state.runs.find((r) => r.id === command.runId) : undefined;
      const oldPlan = state.plans?.find((p) => p.id === (command.planId ?? original?.planId));
      if (
        (command.operation === "retry" && !original) ||
        (command.operation === "clone-plan" && !oldPlan)
      )
        throw new Error("Generation plan not found.");
      const base =
        original?.context ??
        (oldPlan && state.context
          ? { ...state.context, threadId: oldPlan.threadId }
          : (command.context ?? state.context));
      if (base?.threadId && this.removedThreads.has(base.threadId))
        throw new Error("This sprite conversation has been deleted.");
      if (
        !base?.threadId ||
        !(state.threadIds ?? [state.context?.threadId]).includes(base.threadId) ||
        this.removedThreads.has(base.threadId)
      )
        throw new Error("An available sprite conversation is required.");
      if (base.projectId !== command.projectId)
        throw new Error("Matching project context is required.");
      const input = command.input ?? original?.input;
      const requestId =
        command.operation === "retry" || command.operation === "clone-plan"
          ? (command.input?.requestId ?? randomUUID())
          : (input?.requestId ?? randomUUID());
      if (state.plans?.some((p) => p.requestId === requestId && p.threadId === base.threadId))
        return {
          ...state,
          resultPlanId: state.plans!.find(
            (p) => p.requestId === requestId && p.threadId === base.threadId,
          )!.id,
        };
      let configuration: SpritePlanConfiguration = command.configuration ??
        original?.configuration ??
        oldPlan?.configuration ?? {
          kind: input?.kind ?? "animation",
          mode: "combined" as const,
          prompt: input?.prompt ?? "",
          providerId: base.providerId,
          model: base.model,
          width: base.width,
          height: base.height,
          background: base.background,
          chromaKey: base.chromaKey,
          parameters: {
            n: 1,
            size: "auto",
            quality: "auto" as const,
            outputFormat: "png" as const,
          },
          references: [],
          actions: [
            {
              id: randomUUID(),
              name: input?.action ?? base.action,
              description: input?.prompt ?? "",
              enabled: true,
              frameCount: input?.frameCount ?? base.frameCount,
              fps: input?.fps ?? base.fps,
              loop: input?.loop ?? base.loop ?? true,
            },
          ],
        };
      if (original && command.input?.prompt)
        configuration = { ...configuration, prompt: command.input.prompt };
      if (original && !original.configuration && original.context.referenceAssetId) {
        const asset = await this.images.getAsset(original.context.referenceAssetId);
        configuration = {
          ...configuration,
          references: [
            {
              referenceId: `candidate:${original.id}:${asset.id}`,
              asset,
              role: "character",
              actionId: null,
            },
          ],
        };
      }
      if (command.actionId) {
        const action = configuration.actions.find((a) => a.id === command.actionId);
        if (!action) throw new Error("Action not found.");
        configuration = { ...spriteTaskConfiguration(configuration, [action]), mode: "separate" };
      }
      const sourceKey = `${original ? `run:${original.id}` : oldPlan ? `plan:${oldPlan.id}` : `request:${requestId}`}:${command.actionId ?? "all"}`;
      const active = state.plans?.find((p) => p.threadId === base.threadId && p.status === "draft");
      if (command.replacePlanId && command.replacePlanId !== active?.id)
        throw new Error("Current draft changed. Refresh before replacing it.");
      if (active) {
        if (active.sourceKey === sourceKey || active.id === oldPlan?.id)
          return { ...state, resultPlanId: active.id };
        if (command.replacePlanId !== active.id || command.version !== active.version)
          throw new Error(
            `A draft already exists: ${active.id}. Continue editing it or explicitly replace it.`,
          );
      }
      if (original || oldPlan) configuration = spritePlanForRevision(configuration);
      configuration = spritePlanForRevision(
        Schema.decodeUnknownSync(SpritePlanConfiguration)(configuration),
      );
      if (
        !original &&
        !oldPlan &&
        configuration.kind === "animation" &&
        !configuration.sizeSource &&
        (!configuration.parameters.size || configuration.parameters.size === "auto")
      )
        configuration = {
          ...configuration,
          sizeSource: "recommended",
          parameters: { ...configuration.parameters, size: spriteRecommendedSize(configuration) },
        };
      if (!trustedReferences) this.validateReferences(state, base.threadId, configuration);
      // The gateway has resolved sent attachments into assets before proposal creation.
      const plan: SpriteGenerationPlan = {
        id: randomUUID(),
        projectId: command.projectId,
        threadId: base.threadId,
        turnId: command.turnId ?? null,
        requestId,
        version: 1,
        status: "draft",
        configuration,
        compiled: compileSpritePlan(configuration),
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        sourceKey,
        ...(command.displayAfter ? { displayAfter: command.displayAfter } : {}),
      };
      const next = {
        ...state,
        resultPlanId: plan.id,
        plans: [
          ...(state.plans ?? []).map((p) =>
            p.id === active?.id
              ? Object.assign({}, p, {
                  status: "dismissed" as const,
                  supersededBy: plan.id,
                  version: p.version + 1,
                })
              : p,
          ),
          plan,
        ],
      };
      await this.save(command.projectId, next);
      return next;
    });
  }
  private validateReferences(
    state: SpriteState,
    threadId: string,
    c: Pick<SpritePlanConfiguration, "references">,
  ) {
    const owned = new Set(
      (state.plans ?? [])
        .filter((p) => p.threadId === threadId)
        .flatMap((p) => p.configuration.references.map((r) => r.asset.id)),
    );
    for (const entry of state.referencePool ?? [])
      if (entry.threadId === threadId) owned.add(entry.reference.asset.id);
    for (const run of state.runs.filter((r) => r.context.threadId === threadId)) {
      if (run.context.referenceAssetId) owned.add(run.context.referenceAssetId);
      for (const r of run.configuration?.references ?? []) owned.add(r.asset.id);
      for (const candidate of run.candidates ?? []) {
        owned.add(candidate.source.id);
        for (const frame of candidate.frames) owned.add(frame.id);
      }
      if (run.source) owned.add(run.source.id);
      for (const frame of run.frames) owned.add(frame.id);
    }
    if (c.references.some((r) => !owned.has(r.asset.id)))
      throw new Error("Reference image does not belong to this conversation.");
  }
  confirm(input: SpritePlanConfirmInput): Promise<SpriteState> {
    return this.locked(async () => {
      const state = await this.state(input.projectId);
      const plan = state.plans?.find((p) => p.id === input.planId);
      if (
        !plan ||
        plan.threadId !== input.threadId ||
        !(state.threadIds ?? [state.context?.threadId]).includes(input.threadId) ||
        this.removedThreads.has(input.threadId)
      )
        throw new Error("Plan conversation is unavailable.");
      if (plan.version !== input.version)
        throw new Error("Plan changed. Refresh before confirming.");
      if (plan.status === "confirmed") return state;
      if (plan.status !== "draft") throw new Error("Plan was dismissed.");
      const c = plan.configuration,
        issues = spritePlanIssues(c);
      if (issues.length) throw new Error(issues.join("\n"));
      this.validateReferences(state, plan.threadId, c);
      const providers = await this.images.listProviders();
      if (
        !providers.some(
          (p) => p.id === c.providerId && p.enabled && p.models.some((m) => m.id === c.model),
        )
      )
        throw new Error("Select an enabled Drawing model.");
      for (const r of c.references) {
        const asset = await this.images.getAsset(r.asset.id);
        if (
          (Object.keys(r.asset) as (keyof ImageAsset)[]).some((key) => asset[key] !== r.asset[key])
        )
          throw new Error("Reference metadata changed. Refresh the plan.");
      }
      const actions = spritePlanActions(c);
      const groups =
        c.kind === "character" || c.mode === "combined" ? [actions] : actions.map((a) => [a]);
      const runs: SpriteRun[] = groups.map((group, i) => {
        const configuration = spriteTaskConfiguration(c, group);
        const first = group[0]!;
        return {
          id: randomUUID(),
          planId: plan.id,
          planVersion: plan.version,
          configuration,
          requestPrompt: plan.compiled?.[i]?.prompt ?? spritePlanPrompt(configuration),
          context: {
            projectId: input.projectId,
            threadId: plan.threadId,
            name: state.context?.name ?? "Sprite",
            providerId: c.providerId,
            model: c.model,
            referenceAssetId: configuration.references[0]?.asset.id ?? null,
            action: first.name,
            fps: first.fps,
            frameCount: first.frameCount,
            width: c.width,
            height: c.height,
            background: c.background,
            chromaKey: c.chromaKey,
          },
          input: {
            kind: c.kind,
            prompt: c.prompt,
            requestId: `${plan.id}-${plan.version}-${i}`,
            loop: first.loop,
          },
          jobId: null,
          status: "queued",
          source: null,
          frames: [],
          actions: [],
          warnings: [],
          error: null,
          createdAt: new Date().toISOString(),
        };
      });
      await this.save(input.projectId, {
        ...state,
        plans: state.plans!.map((p) =>
          p.id === plan.id
            ? Object.assign({}, p, {
                status: "confirmed" as const,
                confirmedAt: new Date().toISOString(),
              })
            : p,
        ),
        runs: [...state.runs, ...runs],
      });
      for (const run of runs)
        await this.submit(input.projectId, await this.state(input.projectId), run);
      return this.state(input.projectId);
    });
  }
  private requestKey(id: string, run: SpriteRun) {
    return `sprite-${createHash("sha256")
      .update(`${id}:${run.context.threadId ?? ""}:${run.input.requestId}`)
      .digest("hex")}`;
  }
  private async submittedJob(id: string, run: SpriteRun) {
    return this.images.repository
      ? Effect.runPromise(this.images.repository.getRequest(this.requestKey(id, run)))
      : null;
  }
  private async submit(id: string, state: SpriteState, run: SpriteRun) {
    let recordedJobId: string | null = null;
    try {
      const c = run.context,
        animation = run.input.kind === "animation";
      const configuration = run.configuration;
      const inputs: string[] = configuration
        ? configuration.references.map((r) => r.asset.id)
        : c.referenceAssetId
          ? [c.referenceAssetId]
          : [];
      if (animation) {
        const layout = configuration
          ? spritePlanLayout(configuration)
          : { columns: c.frameCount, rows: 1 };
        inputs.push(
          (
            await this.images.upload(
              await spriteLayoutGuide(
                layout.columns,
                layout.rows,
                configuration?.parameters.size,
                c.width,
                c.height,
                configuration
                  ? spritePlanActions(configuration).map((a) => a.frameCount)
                  : undefined,
              ),
              "sprite-layout.png",
            )
          ).id,
        );
      }
      const prompt =
        run.requestPrompt ?? (configuration ? spritePlanPrompt(configuration) : run.input.prompt);
      const job = await this.images.createJob({
        clientRequestId: this.requestKey(id, run),
        providerId: c.providerId,
        model: c.model,
        prompt,
        parameters: {
          ...configuration?.parameters,
          n: 1,
          outputFormat: configuration?.parameters.outputFormat ?? "png",
          background: c.background === "transparent" ? "transparent" : "opaque",
        },
        inputAssetIds: inputs,
        maskAssetId: null,
        sourceJobId: null,
      });
      recordedJobId = job.id;
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
            ? {
                ...r,
                jobId: recordedJobId,
                status: recordedJobId ? "running" : "failed",
                error: String(e instanceof Error ? e.message : e),
              }
            : r,
        ),
      });
    }
  }
  private async processCandidate(
    run: SpriteRun,
    source: ImageAsset,
    slice?: SpriteSliceConfiguration,
    previous?: SpriteCandidate,
  ): Promise<SpriteCandidate> {
    try {
      const processed = await processSprite(
        await this.images.assets.read(source, "edit"),
        run.context,
        run.configuration ? spritePlanActions(run.configuration) : undefined,
        slice,
      );
      const analysis =
        (previous?.analysis?.algorithmVersion === SPRITE_ANALYSIS_VERSION
          ? previous.analysis
          : undefined) ??
        (run.input.kind === "animation"
          ? await analyzeSprite(
              await this.images.assets.read(source, "edit"),
              run.context,
              run.configuration
                ? spritePlanActions(run.configuration)
                : processed.actions.map((a) => a.action),
              source.id,
            )
          : undefined);
      const frames: ImageAsset[] = [];
      for (const [i, bytes] of processed.frames.entries())
        frames.push(await this.images.upload(bytes, `${run.context.action}-${i + 1}.png`));
      let offset = 0;
      const actions = processed.actions.map((o) => {
        const output = {
          action: o.action,
          warnings: o.warnings,
          frames: frames.slice(offset, offset + o.frames.length),
        };
        offset += o.frames.length;
        return output;
      });
      const issues = [...processed.issues, ...(analysis?.issues ?? [])];
      const reviewed = new Set(processed.configuration.reviewedActionIds);
      const actionIds = new Set(actions.map((output) => output.action.id));
      const hasUnreviewedErrors = issues.some(
        (issue) =>
          issue.severity === "error" &&
          (issue.actionId
            ? actionIds.has(issue.actionId) && !reviewed.has(issue.actionId)
            : actions.some((output) => !reviewed.has(output.action.id))),
      );
      const processingVersionId = randomUUID();
      const processingVersion = {
        id: processingVersionId,
        createdAt: new Date().toISOString(),
        configuration: processed.configuration,
        frames,
        actions,
        warnings: processed.warnings,
        issues,
      };
      return {
        ...previous,
        version: (previous?.version ?? 0) + 1,
        analysis,
        slice: processed.configuration,
        issues,
        processingVersionId,
        processingVersions: [
          ...(previous?.processingVersions ??
            (previous?.frames.length
              ? [
                  {
                    id: randomUUID(),
                    createdAt: new Date().toISOString(),
                    configuration:
                      previous.slice ??
                      spriteGridSlice(
                        source.width,
                        source.height,
                        run.configuration
                          ? spritePlanActions(run.configuration)
                          : previous.actions.map((a) => a.action),
                      ),
                    frames: previous.frames,
                    actions: previous.actions,
                    warnings: previous.warnings,
                    issues: previous.issues ?? [],
                  },
                ]
              : [])),
          processingVersion,
        ],
        id: source.id,
        source,
        frames,
        actions,
        warnings: processed.warnings,
        status: hasUnreviewedErrors ? "needs-adjustment" : "ready",
        error: null,
      };
    } catch (e) {
      return {
        id: source.id,
        source,
        frames: [],
        actions: [],
        warnings: [],
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  private async selectProcessed(id: string, run: SpriteRun, candidate: SpriteCandidate) {
    await this.replace(id, run, {
      candidates: run.candidates!.map((c) => (c.id === candidate.id ? candidate : c)),
      selectedCandidateId: candidate.id,
      source: candidate.source,
      frames: candidate.frames,
      actions: candidate.actions,
      warnings: candidate.warnings,
      status: candidate.status === "pending" ? "processing" : candidate.status,
      error: candidate.error,
    });
  }
  private async refresh(id: string, state: SpriteState) {
    for (const run of state.runs) {
      if (run.context.threadId && this.removedThreads.has(run.context.threadId)) continue;
      const active = ["queued", "running", "processing"].includes(run.status);
      if (!active && run.candidates) continue;
      if (!run.jobId) {
        if (!active) continue;
        const existing = await this.submittedJob(id, run);
        await this.replace(
          id,
          run,
          existing
            ? { jobId: existing.id, status: "running" }
            : { status: "interrupted", error: "Submission was interrupted. Retry explicitly." },
        );
        continue;
      }
      try {
        const job = await this.images.getJob(run.jobId);
        if (["failed", "interrupted", "cancelled"].includes(job.status)) {
          if (active)
            await this.replace(id, run, {
              status: job.status as "failed" | "interrupted" | "cancelled",
              imageStatus: job.status,
              error: job.error?.message ?? null,
            });
          continue;
        }
        if (job.status !== "succeeded" && job.status !== "partial") continue;
        if (!job.outputs.length) throw new Error("Image generation returned no image.");
        const candidates: SpriteCandidate[] = [
          ...new Map(job.outputs.map((source) => [source.id, source])).values(),
        ].map((source) => ({
          id: source.id,
          source,
          status: "pending",
          frames: [],
          actions: [],
          warnings: [],
          error: null,
        }));
        const legacyIndex = run.source ? candidates.findIndex((c) => c.id === run.source!.id) : -1;
        if (legacyIndex >= 0 && run.frames.length)
          candidates[legacyIndex] = {
            ...candidates[legacyIndex]!,
            frames: run.frames,
            actions: run.actions ?? [],
            warnings: run.warnings,
            status: run.status === "needs-adjustment" ? "needs-adjustment" : "ready",
          };
        const selectedIndex = legacyIndex >= 0 ? legacyIndex : 0;
        if (candidates[selectedIndex]!.status === "pending")
          candidates[selectedIndex] = await this.processCandidate(
            run,
            candidates[selectedIndex]!.source,
          );
        const selected = candidates[selectedIndex]!;
        await this.replace(id, run, {
          candidates,
          selectedCandidateId: selected.id,
          imageStatus: job.status,
          source: selected.source,
          frames: selected.frames,
          actions: selected.actions,
          warnings: selected.warnings,
          status:
            selected.status === "pending" || selected.status === "processing"
              ? "processing"
              : selected.status,
          error: selected.error,
        });
      } catch (e) {
        if (active)
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
      for (const threadId of this.pendingThreadRemovals) {
        try {
          await this.removeThread(threadId);
        } catch (error) {
          console.warn(
            "Sprite conversation removal will need retry:",
            threadId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      for (const [id, state] of this.states)
        if (!this.deleted.has(id)) await this.refresh(id, state);
    });
  }
}
