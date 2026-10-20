import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  SpriteState,
  DEFAULT_SPRITE_SIZING,
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
  spritePlanTasks,
  spriteTaskGuideSvg,
  spriteOutputSize,
  spriteGenerationReference,
  spritePlanTarget,
  spriteBlockedActions,
  type SpriteGenerationPlan,
  type SpritePlanConfirmInput,
  type SpriteRetryConfirmInput,
  type ImageAsset,
  type SpriteCommand,
  type SpriteRun,
  type SpriteCandidate,
  type ImageJobEvent,
} from "@synara/contracts";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { writeFileStringAtomically } from "../atomicWrite";
import { ImageApiError } from "../imageGeneration/imageApi";
import {
  analyzeSprite,
  processSprite,
  spriteLayoutGuide,
  normalizeSpriteCharacter,
} from "./processSprite";
import sharp from "sharp";
import { recoverSpriteState, spriteImportOrigin, spriteRawAssetIds } from "./spriteRecovery";

export class SpriteEngine {
  private states = new Map<string, SpriteState>();
  private recoveryReferences = new Map<string, Set<string>>();
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
    for (const ids of this.recoveryReferences.values())
      for (const id of ids) this.images.spriteAssetIds.add(id);
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
    if (state.recovery?.readOnly)
      throw new Error(
        "Task data is partially recovered. Retry reading or resolve the diagnostics before modifying generation state.",
      );
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
      if (state.recovery?.readOnly) continue;
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
    let rawText: string | undefined;
    let needsBackup = false;
    try {
      rawText = await readFile(path.join(this.root, `${id}.json`), "utf8");
      const raw: unknown = JSON.parse(rawText);
      const verified = new Set<string>();
      for (const assetId of spriteRawAssetIds(raw)) {
        try {
          if ((await this.images.getAsset(assetId))?.id === assetId) verified.add(assetId);
        } catch {
          /* Missing assets are never treated as verified imports. */
        }
      }
      const recovered = recoverSpriteState(id, raw, verified);
      state = recovered.state;
      needsBackup = recovered.migrated || recovered.diagnostics.length > 0;
      if (recovered.diagnostics.length) {
        this.recoveryReferences.set(id, spriteRawAssetIds(raw));
        state = {
          ...state,
          recovery: {
            version: 1,
            status: "partial",
            readOnly: true,
            diagnostics: recovered.diagnostics,
          },
        };
      } else if (recovered.migrated)
        state = {
          ...state,
          recovery: { version: 1, status: "recovered", readOnly: false, diagnostics: [] },
        };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        needsBackup = true;
        state = {
          context: null,
          runs: [],
          recovery: {
            version: 1,
            status: "failed",
            readOnly: true,
            diagnostics: [{ path: "$", message: e instanceof Error ? e.message : String(e) }],
          },
        };
      }
    }
    if (state.recovery?.readOnly) (this.images.spriteRecoveryProjects ??= new Set()).add(id);
    else {
      this.images.spriteRecoveryProjects?.delete(id);
      this.recoveryReferences.delete(id);
    }
    if (needsBackup && rawText !== undefined) {
      const backupFile = `${id}.recovery-${createHash("sha256").update(rawText).digest("hex").slice(0, 16)}.json.bak`;
      try {
        await writeFile(path.join(this.root, backupFile), rawText, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          state = {
            ...state,
            recovery: {
              version: 1,
              status: "partial",
              readOnly: true,
              diagnostics: [
                ...(state.recovery?.diagnostics ?? []),
                { path: "backup", message: e instanceof Error ? e.message : String(e) },
              ],
            },
          };
          (this.images.spriteRecoveryProjects ??= new Set()).add(id);
        }
      }
      if (state.recovery) state = { ...state, recovery: { ...state.recovery, backupFile } };
    }
    const latest = new Map<string, string>();
    for (const plan of (state.plans ?? [])
      .toReversed()
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (
        plan.status === "draft" &&
        !latest.has(plan.targetKey ?? spritePlanTarget(plan.configuration))
      )
        latest.set(plan.targetKey ?? spritePlanTarget(plan.configuration), plan.id);
    let migrated = false;
    state = {
      ...state,
      plans: state.plans?.map((plan) => {
        const current = latest.get(plan.targetKey ?? spritePlanTarget(plan.configuration));
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
    if ((migrated || needsBackup) && !state.recovery?.readOnly) await this.save(id, state);
    return state;
  }
  private retain(state: SpriteState) {
    for (const reference of [
      state.canonical,
      state.characterPreview,
      ...(state.canonicalVersions ?? []),
    ])
      if (reference) {
        this.images.spriteAssetIds.add(reference.source.id);
        this.images.spriteAssetIds.add(reference.asset.id);
        if (reference.generationReference)
          this.images.spriteAssetIds.add(reference.generationReference.id);
      }
    if (state.context?.referenceAssetId)
      this.images.spriteAssetIds.add(state.context.referenceAssetId);
    for (const entry of state.referencePool ?? [])
      this.images.spriteAssetIds.add(entry.reference.asset.id);
    for (const entry of state.selectedReferences ?? [])
      this.images.spriteAssetIds.add(entry.reference.asset.id);
    for (const plan of state.plans ?? [])
      for (const r of plan.configuration.references) this.images.spriteAssetIds.add(r.asset.id);
    for (const run of state.runs) {
      for (const assetId of run.submissionInputs ?? []) this.images.spriteAssetIds.add(assetId);
      if (run.context.referenceAssetId)
        this.images.spriteAssetIds.add(run.context.referenceAssetId);
      for (const reference of run.configuration?.references ?? [])
        this.images.spriteAssetIds.add(reference.asset.id);
      for (const candidate of run.candidates ?? []) {
        this.images.spriteAssetIds.add(candidate.source.id);
        for (const frame of [
          ...candidate.frames,
          ...(candidate.processingVersions ?? []).flatMap((v) => v.frames),
          ...candidate.actions.flatMap((a) => a.masters ?? []),
          ...(candidate.processingVersions ?? []).flatMap((v) =>
            v.actions.flatMap((a) => a.masters ?? []),
          ),
        ])
          this.images.spriteAssetIds.add(frame.id);
      }
      if (run.source) this.images.spriteAssetIds.add(run.source.id);
      for (const frame of run.frames) this.images.spriteAssetIds.add(frame.id);
    }
  }
  private async save(id: string, state: SpriteState) {
    if (this.states.get(id)?.recovery?.readOnly || state.recovery?.readOnly)
      throw new Error(
        "Task data is partially recovered. Retry reading or resolve the diagnostics before modifying generation state.",
      );
    state = Schema.decodeUnknownSync(SpriteState)({ ...state, resultPlanId: undefined });
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
        if (state.recovery?.readOnly) return state;
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
      const previous =
        command.operation === "get" && command.reload
          ? this.states.get(command.projectId)
          : undefined;
      if (command.operation === "get" && command.reload) this.states.delete(command.projectId);
      let state = await this.state(command.projectId);
      if (previous && state.recovery?.status === "failed") {
        state = { ...previous, recovery: state.recovery };
        this.states.set(command.projectId, state);
        this.rebuildReferences();
      }
      if (state.recovery?.readOnly) {
        if (command.operation === "get") return state;
        throw new Error(
          "Task data is partially recovered. Retry reading or resolve the diagnostics before modifying generation state.",
        );
      }
      if (command.operation === "preview-character" || command.operation === "confirm-character") {
        if (
          trustedReferences ||
          !command.context ||
          command.context.projectId !== command.projectId ||
          !command.references?.[0] ||
          !command.renderSpec
        )
          throw new Error("Matching character context and source are required.");
        const source = await this.images.getAsset(command.references[0].asset.id);
        const registration = command.registration ?? { scale: 1, offsetX: 0, offsetY: 0 };
        const normalized = await normalizeSpriteCharacter(
          await this.images.assets.read(source, "edit"),
          command.context,
          command.renderSpec,
          registration,
        );
        const asset = await this.images.upload(normalized.bytes, "character-reference.png");
        const generationReference = normalized.generationReference
          ? await this.images.upload(
              normalized.generationReference,
              "character-appearance-reference.png",
            )
          : undefined;
        const preview = {
          generationReference,
          source,
          asset,
          renderSpec: command.renderSpec,
          registration,
          pivotX: normalized.pivotX,
          pivotY: normalized.pivotY,
          background: command.context.background,
          chromaKey: command.context.chromaKey,
        };
        let next: SpriteState = { ...state, characterPreview: preview };
        if (command.operation === "confirm-character") {
          const canonical = {
            ...preview,
            revision: randomUUID(),
            confirmedAt: new Date().toISOString(),
          };
          const ids = state.threadIds ?? [];
          next = {
            ...next,
            canonical,
            canonicalVersions: [
              ...(state.canonicalVersions ?? (state.canonical ? [state.canonical] : [])),
              canonical,
            ],
            context: state.context
              ? {
                  ...state.context,
                  workflowVersion: 2,
                  renderSpec: command.renderSpec,
                  ...spriteOutputSize(command.renderSpec),
                  canonical,
                }
              : state.context,
            plans: state.plans?.map((p) =>
              p.status === "draft"
                ? { ...p, status: "dismissed" as const, version: p.version + 1 }
                : p,
            ),
            referencePool: [
              ...(state.referencePool ?? []),
              ...ids.map((threadId) => ({
                threadId,
                reference: {
                  referenceId: `canonical:${canonical.revision}`,
                  asset: spriteGenerationReference(canonical),
                  role: "character" as const,
                  actionId: null,
                  source: "project" as const,
                },
              })),
            ],
          };
        }
        await this.save(command.projectId, next);
        return next;
      }
      if (command.operation === "inspect-source") {
        if (
          trustedReferences ||
          !command.context ||
          command.context.projectId !== command.projectId ||
          !command.references?.[0]
        )
          throw new Error("Matching source context is required.");
        const source = await this.images.getAsset(command.references[0].asset.id);
        const imported = spriteImportOrigin(command.projectId, source.id, command);
        const existing = state.runs.find((r) => r.input.requestId === imported.requestId);
        if (existing) return state;
        const configuration = command.configuration;
        const run: SpriteRun = {
          id: randomUUID(),
          importOrigin: imported.origin,
          context: command.context,
          input: {
            kind: "animation",
            prompt: "Imported source slicing",
            requestId: imported.requestId,
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
        const analysis = await analyzeSprite(
          await this.images.assets.read(source, "edit"),
          command.context,
          configuration?.actions ?? [
            {
              id: command.context.selection?.actionId ?? "imported",
              name: command.context.action,
              description: "",
              enabled: true,
              frameCount: command.context.frameCount,
              fps: command.context.fps,
              loop: command.context.loop ?? true,
            },
          ],
          source.id,
          configuration?.layout,
          configuration?.parameters.size,
          true,
        );
        const candidate = await this.processCandidate(
          run,
          source,
          command.slice ?? analysis.suggestion,
        );
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
      if (command.operation === "review-candidate") {
        const run = state.runs.find((r) => r.id === command.runId);
        const candidate: SpriteCandidate | undefined =
          run?.candidates?.find((c) => c.id === command.candidateId) ??
          (run && run.source && run.source.id === command.candidateId && !run.candidates?.length
            ? {
                id: run.source.id,
                source: run.source,
                status: run.status === "ready" ? ("ready" as const) : ("needs-adjustment" as const),
                frames: run.frames,
                actions: run.actions ?? [],
                warnings: run.warnings,
                error: run.error,
              }
            : undefined);
        if (
          !run ||
          !candidate ||
          !command.actionId ||
          !candidate.actions.some((a) => a.action.id === command.actionId)
        )
          throw new Error("Animation candidate not found.");
        if (
          command.version !== (candidate.version ?? 0) ||
          command.processingVersionId !== candidate.processingVersionId ||
          command.analysisRevision !== (candidate.analysisRevision ?? 0)
        )
          throw new Error("Candidate changed. Refresh before confirming the review.");
        // Confirming a review never runs the image provider or the frame processor.
        const reviewed = {
          ...candidate,
          reviews: [
            ...(candidate.reviews ?? []).filter((r) => r.actionId !== command.actionId),
            {
              actionId: command.actionId,
              processingVersionId: candidate.processingVersionId,
              analysisRevision: candidate.analysisRevision ?? 0,
              createdAt: new Date().toISOString(),
            },
          ],
        };
        if (spriteBlockedActions(reviewed).has(command.actionId))
          throw new Error("Fix structural frame errors before adopting this action.");
        await this.selectProcessed(
          command.projectId,
          { ...run, candidates: run.candidates?.length ? run.candidates : [candidate] },
          reviewed.actions.every((a) =>
            reviewed.reviews.some(
              (r) =>
                r.actionId === a.action.id &&
                r.processingVersionId === reviewed.processingVersionId &&
                r.analysisRevision === (reviewed.analysisRevision ?? 0),
            ),
          )
            ? { ...reviewed, status: "ready" }
            : reviewed,
        );
        return this.state(command.projectId);
      }
      if (
        [
          "analyze-candidate",
          "preview-slicing",
          "save-slicing",
          "restore-slicing",
          "reprocess-candidate",
          "fork-slicing",
        ].includes(command.operation)
      ) {
        const run = state.runs.find((r) => r.id === command.runId);
        const candidate = run?.candidates?.find((c) => c.id === command.candidateId);
        if (!run || !candidate || run.input.kind !== "animation")
          throw new Error("Animation candidate not found.");
        if (
          !["analyze-candidate", "fork-slicing"].includes(command.operation) &&
          command.version !== (candidate.version ?? 0)
        )
          throw new Error("Candidate changed. Refresh before editing.");
        const descriptors = run.configuration
          ? spritePlanActions(run.configuration)
          : (run.actions?.map((a) => a.action) ?? []);
        const bytes = await this.images.assets.read(candidate.source, "edit");
        if (command.operation === "analyze-candidate") {
          const analysis = await analyzeSprite(
            bytes,
            run.context,
            descriptors,
            candidate.id,
            run.configuration?.layout,
            run.configuration?.parameters.size,
            !!run.importOrigin,
          );
          const updated = {
            ...candidate,
            analysis,
            slice: candidate.slice ? { ...candidate.slice, reviewedActionIds: [] } : undefined,
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
            analysisRevision: (candidate.analysisRevision ?? 0) + 1,
          };
          await this.selectProcessed(command.projectId, run, updated);
        } else {
          const restored = candidate.processingVersions?.find(
            (v) => v.id === command.processingVersionId,
          );
          const slice =
            command.operation === "restore-slicing"
              ? restored?.configuration
              : (command.slice ??
                (command.operation === "reprocess-candidate" ? candidate.slice : undefined));
          if (!slice && command.operation !== "reprocess-candidate")
            throw new Error("Slicing configuration is required.");
          const updated = await this.processCandidate(
            run,
            candidate.source,
            slice ? { ...slice, reviewedActionIds: [] } : undefined,
            candidate,
          );
          if (updated.status === "failed" && command.operation !== "reprocess-candidate")
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
        let canonical = state.canonical;
        if (!canonical && command.context.canonical && !trustedReferences) {
          try {
            const asset = await this.images.getAsset(command.context.canonical.asset.id),
              source = await this.images.getAsset(command.context.canonical.source.id);
            const appearance = command.context.canonical.generationReference;
            const verifiedAppearance = appearance
              ? await this.images.getAsset(appearance.id)
              : undefined;
            if (
              asset.width === command.context.canonical.asset.width &&
              asset.height === command.context.canonical.asset.height &&
              asset.bytes === command.context.canonical.asset.bytes &&
              source.bytes === command.context.canonical.source.bytes &&
              (!appearance ||
                (verifiedAppearance &&
                  verifiedAppearance.id === appearance.id &&
                  verifiedAppearance.width === appearance.width &&
                  verifiedAppearance.height === appearance.height &&
                  verifiedAppearance.bytes === appearance.bytes &&
                  verifiedAppearance.mimeType === appearance.mimeType))
            )
              canonical = command.context.canonical;
          } catch {
            /* Imported projects keep their local reference; unknown remote assets need approval again. */
          }
        }
        const changedSpec =
          canonical &&
          command.context.renderSpec &&
          (canonical.renderSpec.mode !== command.context.renderSpec.mode ||
            canonical.renderSpec.logicalWidth !== command.context.renderSpec.logicalWidth ||
            canonical.renderSpec.logicalHeight !== command.context.renderSpec.logicalHeight);
        if (changedSpec) canonical = undefined;
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
          canonical,
          plans: changedSpec
            ? state.plans?.map((p) =>
                p.status === "draft"
                  ? { ...p, status: "dismissed" as const, version: p.version + 1 }
                  : p,
              )
            : state.plans,
          context: {
            ...command.context,
            canonical,
            referenceAssetId: null,
            threadId:
              command.context.threadId && this.removedThreads.has(command.context.threadId)
                ? null
                : command.context.threadId,
          },
          threadIds: ids,
          referencePool: canonical
            ? [
                ...(state.referencePool ?? []),
                ...ids
                  .filter(
                    (threadId) =>
                      !state.referencePool?.some(
                        (r) =>
                          r.threadId === threadId &&
                          r.reference.asset.id === spriteGenerationReference(canonical!).id,
                      ),
                  )
                  .map((threadId) => ({
                    threadId,
                    reference: {
                      referenceId: `canonical:${canonical!.revision}`,
                      asset: spriteGenerationReference(canonical!),
                      role: "character" as const,
                      actionId: null,
                      source: "project" as const,
                    },
                  })),
              ]
            : state.referencePool,
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
        let configuration = this.workflowConfiguration(
          state,
          spritePlanForRevision(command.configuration ?? plan.configuration),
        );
        configuration = { ...configuration, sizePolicy: undefined };
        if (configuration.sizeSource === "recommended")
          configuration = {
            ...configuration,
            parameters: { ...configuration.parameters, size: spriteRecommendedSize(configuration) },
          };
        // Clients may choose only references captured and owned by this conversation.
        if (!trustedReferences) this.validateReferences(state, plan.threadId, configuration);
        const targetKey = spritePlanTarget(configuration);
        if (
          state.plans?.some(
            (p) =>
              p.id !== plan.id &&
              p.status === "draft" &&
              (p.targetKey ?? spritePlanTarget(p.configuration)) === targetKey,
          )
        )
          throw new Error("This target already has a draft. Open it before changing the target.");
        const updated = {
          ...plan,
          targetKey,
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
        configuration = {
          ...spriteTaskConfiguration(configuration, [
            { ...action, frameCount: configuration.segment?.totalFrames ?? action.frameCount },
          ]),
          mode: "separate",
          segment: undefined,
          layout: undefined,
          sequenceId: undefined,
        };
      }
      configuration = this.workflowConfiguration(state, configuration, base);
      configuration = { ...configuration, sizePolicy: undefined };
      const sourceKey = `${original ? `run:${original.id}` : oldPlan ? `plan:${oldPlan.id}` : `request:${requestId}`}:${command.actionId ?? "all"}`;
      const targetKey = spritePlanTarget(configuration);
      const active = state.plans?.find(
        (p) =>
          p.status === "draft" && (p.targetKey ?? spritePlanTarget(p.configuration)) === targetKey,
      );
      if (command.replacePlanId && command.replacePlanId !== active?.id)
        throw new Error("Current draft changed. Refresh before replacing it.");
      if (active) {
        if (
          !command.replacePlanId &&
          (command.operation === "propose" ||
            active.sourceKey === sourceKey ||
            active.id === oldPlan?.id)
        )
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
        !configuration.sizing &&
        configuration.workflowVersion === 2 &&
        !configuration.sizeSource &&
        (!configuration.parameters.size || configuration.parameters.size === "auto")
      )
        configuration = {
          ...configuration,
          sizing: DEFAULT_SPRITE_SIZING,
          sizeSource: "recommended",
        };
      if (!trustedReferences) this.validateReferences(state, base.threadId, configuration);
      // The gateway has resolved sent attachments into assets before proposal creation.
      const planId = randomUUID();
      if (
        configuration.workflowVersion === 2 &&
        configuration.kind === "animation" &&
        !configuration.segment
      )
        configuration = { ...configuration, sequenceId: planId };
      const plan: SpriteGenerationPlan = {
        id: planId,
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
        targetKey,
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
    if (state.canonical) {
      owned.add(state.canonical.asset.id);
      owned.add(spriteGenerationReference(state.canonical).id);
    }
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
  private workflowConfiguration(
    state: SpriteState,
    c: SpritePlanConfiguration,
    context = state.context,
  ) {
    if (
      c.workflowVersion !== 2 &&
      context?.workflowVersion !== 2 &&
      state.context?.workflowVersion !== 2
    )
      return c;
    const renderSpec = c.renderSpec ?? context?.renderSpec ?? state.context?.renderSpec;
    const canonical = state.canonical;
    if (c.segment && c.canonical?.revision !== canonical?.revision)
      c = {
        ...c,
        segment: undefined,
        layout: undefined,
        sequenceId: undefined,
        actions: c.actions.map((a) => ({ ...a, frameCount: c.segment!.totalFrames })),
      };
    return {
      ...c,
      workflowVersion: 2 as const,
      mode: "separate" as const,
      ...(renderSpec ? { renderSpec, ...spriteOutputSize(renderSpec) } : {}),
      canonical,
      references:
        c.kind === "animation" && canonical
          ? [
              {
                referenceId: `canonical:${canonical.revision}`,
                asset: spriteGenerationReference(canonical),
                role: "character" as const,
                actionId: null,
                source: "project" as const,
              },
              ...c.references.filter(
                (r) =>
                  r.asset.id !== canonical.asset.id &&
                  r.asset.id !== spriteGenerationReference(canonical).id,
              ),
            ]
          : c.references,
    };
  }
  confirm(input: SpritePlanConfirmInput): Promise<SpriteState> {
    return this.locked(async () => {
      const state = await this.state(input.projectId);
      if (state.recovery?.readOnly) throw new Error("Task data is partially recovered.");
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
      if (
        c.workflowVersion === 2 &&
        c.kind === "animation" &&
        c.canonical?.revision !== state.canonical?.revision
      )
        throw new Error("Character reference changed. Prepare a new plan.");
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
      const runs: SpriteRun[] = spritePlanTasks(c).map((configuration, i) => {
        const first = spritePlanActions(configuration)[0]!;
        return {
          id: randomUUID(),
          planId: plan.id,
          planVersion: plan.version,
          configuration,
          requestPrompt: plan.compiled?.[i]?.prompt ?? spritePlanPrompt(configuration),
          context: {
            workflowVersion: configuration.workflowVersion,
            renderSpec: configuration.renderSpec,
            canonical: configuration.canonical,
            projectId: input.projectId,
            threadId: plan.threadId,
            name: state.context?.name ?? "Sprite",
            providerId: c.providerId,
            model: c.model,
            referenceAssetId: configuration.references[0]?.asset.id ?? null,
            action: first.name,
            fps: first.fps,
            loop: first.loop,
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
          submissionPhase: "prepared",
          status: "queued",
          source: null,
          frames: [],
          actions: [],
          warnings: [],
          error: null,
          createdAt: new Date().toISOString(),
        };
      });
      for (let i = 0; i < runs.length; i++) {
        const segment = runs[i]!.configuration?.segment;
        if (segment && segment.index > 0)
          runs[i] = {
            ...runs[i]!,
            dependsOnRunId:
              runs
                .slice(0, i)
                .findLast((r) => r.configuration?.segment?.actionId === segment.actionId)?.id ??
              state.runs.findLast(
                (r) =>
                  r.configuration?.sequenceId === runs[i]!.configuration?.sequenceId &&
                  r.configuration?.segment?.actionId === segment.actionId &&
                  r.configuration?.segment?.index === segment.index - 1,
              )?.id,
          };
      }
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
      await this.dispatchPrepared(input.projectId);
      return this.state(input.projectId);
    });
  }
  retryConfirm(input: SpriteRetryConfirmInput): Promise<SpriteState> {
    return this.locked(async () => {
      let state = await this.state(input.projectId);
      if (state.recovery?.readOnly) throw new Error("Task data is partially recovered.");
      if (
        !(state.threadIds ?? [state.context?.threadId]).includes(input.threadId) ||
        this.removedThreads.has(input.threadId)
      )
        throw new Error("Plan conversation is unavailable.");
      const ids = [...new Set(input.runIds)];
      const prior = state.runs.filter((r) => r.retryRequestId === input.requestId);
      if (prior.length) {
        if (
          prior.length !== ids.length ||
          prior.some((r) => r.context.threadId !== input.threadId || !ids.includes(r.retryOfRunId!))
        )
          throw new Error("Retry request does not match the original selection.");
        return state;
      }
      const providers = await this.images.listProviders();
      const attempts: SpriteRun[] = [];
      for (const id of ids) {
        const original = state.runs.find((r) => r.id === id);
        if (
          !original ||
          original.context.threadId !== input.threadId ||
          original.context.projectId !== input.projectId ||
          original.removedAt
        )
          throw new Error("Generation not found.");
        if (state.runs.some((r) => r.retryOfRunId === id))
          throw new Error("This task already has a retry. Open its latest attempt.");
        const recorded = original.jobId
          ? await this.images.getJob(original.jobId)
          : await this.submittedJob(input.projectId, original);
        if (
          original.source ||
          original.candidates?.length ||
          original.frames.length ||
          recorded?.outputs.length
        )
          throw new Error("Images already exist. Correct or reprocess the candidate instead.");
        if (
          recorded
            ? recorded.status !== "failed"
            : original.status !== "failed" ||
              original.submissionPhase === "uncertain" ||
              original.submissionPhase === "submitting"
        )
          throw new Error("Submission status must be verified before retrying.");
        if (
          !providers.some(
            (p) =>
              p.id === original.context.providerId &&
              p.enabled &&
              p.models.some((m) => m.id === original.context.model),
          )
        )
          throw new Error("Select an enabled Drawing model.");
        const inputs = original.submissionInputs ?? recorded?.inputs?.map((a) => a.id);
        const parameters = original.submissionParameters ?? recorded?.parameters;
        if (!inputs || !parameters)
          throw new Error(
            "The original request snapshot is unavailable. Modify the plan before retrying.",
          );
        for (const assetId of inputs) await this.images.getAsset(assetId);
        attempts.push({
          ...original,
          id: randomUUID(),
          retryOfRunId: original.id,
          retryRequestId: input.requestId,
          submissionProviderName: original.submissionProviderName ?? recorded?.providerName,
          input: { ...original.input, requestId: randomUUID() },
          submissionInputs: inputs,
          submissionParameters: parameters,
          submissionPhase: "prepared",
          requestPrompt: original.requestPrompt ?? recorded?.prompt,
          status: "queued",
          jobId: null,
          imageStatus: undefined,
          error: null,
          candidates: undefined,
          selectedCandidateId: undefined,
          source: null,
          frames: [],
          actions: [],
          warnings: [],
          createdAt: new Date().toISOString(),
          removedAt: null,
        });
      }
      state = { ...state, runs: [...state.runs, ...attempts] };
      await this.save(input.projectId, state);
      await this.dispatchPrepared(input.projectId);
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
    let submitting = false;
    try {
      const c = run.context,
        animation = run.input.kind === "animation";
      const configuration = run.configuration;
      const inputs: string[] = run.submissionInputs
        ? [...run.submissionInputs]
        : configuration
          ? configuration.references.map((r) => r.asset.id)
          : c.referenceAssetId
            ? [c.referenceAssetId]
            : [];
      if (animation && !run.submissionInputs) {
        if (run.dependsOnRunId) {
          const dependency = this.latestDependency(state, run.dependsOnRunId);
          inputs.push(...dependency!.frames.slice(-2).map((frame) => frame.id));
        }
        const layout = configuration
          ? spritePlanLayout(configuration)
          : { columns: c.frameCount, rows: 1 };
        inputs.push(
          (
            await this.images.upload(
              configuration?.layout
                ? await sharp(
                    Buffer.from(
                      spriteTaskGuideSvg(
                        configuration.layout,
                        configuration.canonical
                          ? configuration.canonical.pivotY /
                              configuration.canonical.renderSpec.logicalHeight
                          : 0.9,
                      ),
                    ),
                  )
                    .png()
                    .toBuffer()
                : await spriteLayoutGuide(
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
      const parameters = run.submissionParameters ?? {
        ...configuration?.parameters,
        n: 1,
        outputFormat: configuration?.parameters.outputFormat ?? "png",
        background: c.background === "transparent" ? ("transparent" as const) : ("opaque" as const),
      };
      await this.replace(id, run, {
        submissionInputs: inputs,
        submissionParameters: parameters,
        requestPrompt: prompt,
        submissionPhase: "submitting",
      });
      state = await this.state(id);
      submitting = true;
      const job = await this.images.createJob({
        clientRequestId: this.requestKey(id, run),
        providerId: c.providerId,
        model: c.model,
        prompt,
        parameters,
        inputAssetIds: inputs,
        maskAssetId: null,
        sourceJobId: run.retryOfRunId
          ? (state.runs.find((r) => r.id === run.retryOfRunId)?.jobId ?? null)
          : null,
      });
      recordedJobId = job.id;
      await this.save(id, {
        ...state,
        runs: state.runs.map((r) =>
          r.id === run.id
            ? {
                ...r,
                jobId: job.id,
                status: "running",
                submissionPhase: "submitted" as const,
                submissionProviderName: job.providerName,
              }
            : r,
        ),
      });
    } catch (e) {
      const existing = submitting ? await this.submittedJob(id, run).catch(() => null) : null;
      recordedJobId ??= existing?.id ?? null;
      const uncertain = submitting && !recordedJobId && !(e instanceof ImageApiError);
      state = await this.state(id);
      await this.save(id, {
        ...state,
        runs: state.runs.map((r) =>
          r.id === run.id
            ? {
                ...r,
                jobId: recordedJobId,
                status: recordedJobId ? "running" : uncertain ? "interrupted" : "failed",
                submissionPhase: recordedJobId ? "submitted" : uncertain ? "uncertain" : "rejected",
                error: uncertain
                  ? "Submission status must be verified before retrying."
                  : String(e instanceof Error ? e.message : e),
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
      const processingContext = {
        ...run.context,
        background: slice?.background ?? run.context.background,
        chromaKey: slice?.chromaKey ?? run.context.chromaKey,
      };
      const processed = await processSprite(
        await this.images.assets.read(source, "edit"),
        processingContext,
        run.configuration ? spritePlanActions(run.configuration) : undefined,
        slice,
        run.configuration?.layout,
      );
      const analysis =
        (previous?.analysis?.algorithmVersion === SPRITE_ANALYSIS_VERSION &&
        slice?.background === previous.slice?.background &&
        slice?.chromaKey === previous.slice?.chromaKey
          ? previous.analysis
          : undefined) ??
        (run.input.kind === "animation"
          ? await analyzeSprite(
              await this.images.assets.read(source, "edit"),
              processingContext,
              run.configuration
                ? spritePlanActions(run.configuration)
                : processed.actions.map((a) => a.action),
              source.id,
              run.configuration?.layout,
              run.configuration?.parameters.size,
            )
          : undefined);
      const frames: ImageAsset[] = [];
      const masters: ImageAsset[] = [];
      for (const [i, bytes] of processed.frames.entries())
        frames.push(await this.images.upload(bytes, `${run.context.action}-${i + 1}.png`));
      if (run.context.renderSpec)
        for (const [i, bytes] of processed.masters.entries())
          masters.push(
            await this.images.upload(bytes, `${run.context.action}-${i + 1}-master.png`),
          );
      let offset = 0;
      const actions = processed.actions.map((o) => {
        const output = {
          action: o.action,
          frameMetadata: o.frameMetadata,
          warnings: o.warnings,
          frames: frames.slice(offset, offset + o.frames.length),
          ...(masters.length ? { masters: masters.slice(offset, offset + o.frames.length) } : {}),
        };
        offset += o.frames.length;
        return output;
      });
      const issues = [...processed.issues, ...(analysis?.issues ?? [])];
      if (
        run.context.workflowVersion === 2 &&
        run.input.kind === "animation" &&
        processed.frames.length
      ) {
        const compare = async (a: Uint8Array, b: Uint8Array) => {
          const thumbnail = (bytes: Uint8Array) =>
            sharp(bytes).resize(24, 24, { fit: "fill" }).ensureAlpha().raw().toBuffer();
          const [left, right] = await Promise.all([thumbnail(a), thumbnail(b)]);
          let delta = 0;
          for (let i = 0; i < left.length; i++) delta += Math.abs(left[i]! - right[i]!);
          return delta / left.length;
        };
        const state = await this.state(run.context.projectId),
          segment = run.configuration?.segment;
        const adjacent =
          processed.frames.length > 1
            ? await compare(processed.frames[0]!, processed.frames[1]!)
            : 0;
        if (run.dependsOnRunId) {
          const previous = this.latestDependency(state, run.dependsOnRunId)?.frames.at(-1);
          if (
            previous &&
            (await compare(await this.images.assets.read(previous, "edit"), processed.frames[0]!)) >
              Math.max(12, adjacent * 2.5)
          )
            issues.push({
              code: "continuity",
              severity: "warning",
              actionId: segment?.actionId ?? actions[0]?.action.id ?? null,
              frameIndex: 0,
              message:
                "The start of this segment may not continue the preceding pose. Review the complete animation.",
            });
        }
        if (
          run.configuration?.actions[0]?.loop &&
          (!segment || segment.index === segment.count - 1)
        ) {
          const first = segment?.index
            ? state.runs.find(
                (r) =>
                  r.configuration?.sequenceId === run.configuration?.sequenceId &&
                  r.configuration?.segment?.actionId === segment.actionId &&
                  r.configuration?.segment?.index === 0,
              )
            : undefined;
          const asset = first ? this.latestDependency(state, first.id)?.frames[0] : undefined;
          const start = asset ? await this.images.assets.read(asset, "edit") : processed.frames[0]!;
          if ((await compare(start, processed.frames.at(-1)!)) > Math.max(12, adjacent * 2.5))
            issues.push({
              code: "loop-seam",
              severity: "warning",
              actionId: segment?.actionId ?? actions[0]?.action.id ?? null,
              frameIndex: processed.frames.length - 1,
              message: "The last pose may not connect to the first. Review the loop transition.",
            });
        }
      }
      if (run.configuration?.segment && !processed.configuration.edit)
        for (const output of actions)
          if (output.frames.length !== run.configuration.segment.frameCount)
            issues.push({
              code: "missing-frames",
              message: "The action segment is missing planned frames.",
              actionId: output.action.id,
              frameIndex: null,
              severity: "error",
            });
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
        status:
          hasUnreviewedErrors ||
          analysis?.reliable === false ||
          issues.some((i) => i.severity === "error" && ["empty", "missing-frames"].includes(i.code))
            ? "needs-adjustment"
            : "ready",
        error: null,
      };
    } catch (e) {
      if (
        ["EIO", "ETIMEDOUT", "EBUSY", "EAGAIN"].includes((e as NodeJS.ErrnoException).code ?? "") &&
        (previous?.processingAttempts ?? 0) < 2
      )
        return this.processCandidate(run, source, slice, {
          ...previous,
          id: source.id,
          source,
          frames: previous?.frames ?? [],
          actions: previous?.actions ?? [],
          warnings: previous?.warnings ?? [],
          status: "processing",
          error: null,
          processingAttempts: (previous?.processingAttempts ?? 0) + 1,
        });
      return {
        ...previous,
        id: source.id,
        source,
        frames: previous?.frames ?? [],
        actions: previous?.actions ?? [],
        warnings: previous?.warnings ?? [],
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
    if (state.recovery?.readOnly) return;
    for (const run of state.runs) {
      if (run.context.threadId && this.removedThreads.has(run.context.threadId)) continue;
      const active = ["queued", "running", "processing"].includes(run.status);
      if (!active && run.candidates) continue;
      if (!run.jobId) {
        if (!active && run.submissionPhase !== "uncertain") continue;
        const existing = await this.submittedJob(id, run);
        if (!existing && run.submissionPhase === "prepared") continue;
        if (!existing && !active) continue;
        await this.replace(
          id,
          run,
          existing
            ? { jobId: existing.id, status: "running", submissionPhase: "submitted" }
            : {
                status: "interrupted",
                submissionPhase: "uncertain",
                error: "Submission status must be verified before retrying.",
              },
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
    await this.dispatchPrepared(id);
  }
  private latestDependency(state: SpriteState, id: string): SpriteRun | undefined {
    const run = state.runs.find((r) => r.id === id);
    if (run?.configuration?.sequenceId && run.configuration.segment) {
      const latest = state.runs.findLast(
        (r) =>
          !r.removedAt &&
          r.configuration?.sequenceId === run.configuration!.sequenceId &&
          r.configuration?.segment?.actionId === run.configuration!.segment!.actionId &&
          r.configuration?.segment?.index === run.configuration!.segment!.index,
      );
      if (latest && latest.id !== id) return latest;
    }
    const retry = state.runs.findLast((r) => r.retryOfRunId === id);
    return retry ? this.latestDependency(state, retry.id) : run;
  }
  private async dispatchPrepared(id: string) {
    let state = await this.state(id);
    const providers = state.runs.some(
      (r) => r.status === "queued" && r.submissionPhase === "prepared",
    )
      ? await this.images.listProviders()
      : [];
    for (const pending of state.runs.filter(
      (r) => r.status === "queued" && r.submissionPhase === "prepared" && !r.jobId,
    )) {
      state = await this.state(id);
      if (pending.context.threadId && this.removedThreads.has(pending.context.threadId)) continue;
      if (pending.context.workflowVersion === 2) {
        const limit = Math.min(
          2,
          providers.find((p) => p.id === pending.context.providerId)?.concurrency ?? 2,
        );
        if (
          state.runs.filter(
            (r) => r.context.workflowVersion === 2 && ["running", "processing"].includes(r.status),
          ).length >= limit
        )
          continue;
      }
      if (pending.dependsOnRunId) {
        const dependency = this.latestDependency(state, pending.dependsOnRunId);
        const candidate = dependency?.candidates?.find(
          (c) => c.id === dependency.selectedCandidateId,
        );
        if (
          !dependency ||
          !["ready", "needs-adjustment"].includes(dependency.status) ||
          !candidate ||
          spriteBlockedActions(candidate).size
        )
          continue;
      }
      const existing = await this.submittedJob(id, pending);
      if (existing)
        await this.replace(id, pending, {
          jobId: existing.id,
          status: "running",
          submissionPhase: "submitted",
        });
      else await this.submit(id, state, pending);
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
