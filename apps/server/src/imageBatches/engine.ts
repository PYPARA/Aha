import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import {
  IMAGE_BATCH_MAX_IMAGES,
  ImageBatchTask,
  imageBatchComposePrompt,
  imageBatchPlanCounts,
  imageBatchTaskConfiguration,
  imageBatchTaskReferences,
  imageBatchMissingCount,
  imageBatchRetryLineage,
  type ImageBatchCommand,
  type ImageBatchState,
  type ImageBatchAttempt,
  type ImageBatchExecution,
  type ImageBatchProposalInput,
  type ImageBatchResult,
  type ImageBatchSource,
  type ImageBatchPreflight,
  type ImageInputReference,
  type ImageJobEvent,
} from "@synara/contracts";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { ImageApiError, imageRequestParameters } from "../imageGeneration/imageApi";
import { imageCommentPrompt } from "../imageGeneration/imageEditDocuments";
import { writeFileStringAtomically } from "../atomicWrite";
import { ImageBatchRepository, batchActive } from "./repository";

const now = () => new Date().toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fingerprint = (input: unknown) =>
  hash(stableJsonStringify(JSON.parse(JSON.stringify(input))));
const terminal = (s: string) => !["prepared", "queued", "running", "saving"].includes(s);
const conflict = () => new Error("Batch changed. Reload before applying your changes.");
const IMAGE_BATCH_MAX_REFERENCES = 16;
interface BatchStyle {
  prompt: string;
  references: readonly ImageInputReference[];
}
const NO_STYLE: BatchStyle = { prompt: "", references: [] };
/** The current batch style; only a confirm reads it, and the attempt freezes it. */
const batchStyle = (state: ImageBatchState): BatchStyle => ({
  prompt: state.defaults.stylePrompt ?? "",
  references: state.defaults.styleReferences ?? [],
});
/** A retry's references already contain the frozen style images, so only the text is reused. */
const frozenStyle = (attempt: ImageBatchAttempt): BatchStyle => ({
  prompt: attempt.stylePrompt ?? "",
  references: [],
});

export class ImageBatchEngine {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly repository: ImageBatchRepository,
    readonly images: ImageGenerationEngine,
    readonly root: string,
    private emit: (event: ImageJobEvent) => Promise<void>,
  ) {}
  private locked<T>(run: () => Promise<T>) {
    const task = this.tail.then(run, run);
    this.tail = task.catch(() => {});
    return task;
  }
  async get(id: string) {
    const state = await this.repository.get(id);
    if (!state) throw new Error("Batch not found.");
    return state;
  }
  private async save(state: ImageBatchState, results: ImageBatchResult[] = []) {
    state.updatedAt = now();
    await this.repository.save(state, results);
    await this.emit({ type: "batch-changed", batchId: state.id });
    return state;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Decode before image cleanup starts. Invalid batch records fail startup rather than losing assets.
    await this.repository.states();
    this.images.batchCanDispatch = async (job) => {
      if (job.origin?.kind !== "batch") return true;
      const state = await this.repository.get(job.origin.ownerId ?? "");
      const execution = state?.executions.find((e) =>
        e.attempts.some((a) => a.jobId === job.id || a.requestId === job.clientRequestId),
      );
      return (
        !!state &&
        !state.removed &&
        !!execution &&
        !execution.finishedAt &&
        !execution.paused &&
        !execution.cancelled &&
        !(execution.blockedProviders ?? []).includes(job.providerId)
      );
    };
  }
  private validateTasks(state: ImageBatchState, tasks = state.tasks) {
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
      throw new Error("Task IDs must be unique.");
    if (imageBatchPlanCounts(tasks, state.defaults).images > IMAGE_BATCH_MAX_IMAGES)
      throw new Error(
        "A batch supports at most 500 planned images across enabled tasks. Disable tasks or lower image counts.",
      );
    for (const t of tasks) Schema.decodeUnknownSync(ImageBatchTask)(t);
  }
  async preflight(id: string): Promise<ImageBatchPreflight> {
    const state = await this.get(id);
    return this.check(state, state.tasks, batchStyle(state));
  }
  /** `style` is the batch style a confirm would freeze; retries pass none (it is already frozen). */
  private async check(
    state: ImageBatchState,
    tasks: readonly ImageBatchTask[],
    style: BatchStyle = NO_STYLE,
  ) {
    this.validateTasks(state, [...tasks]);
    const counts = imageBatchPlanCounts(tasks, state.defaults);
    const issues: { taskId: string; message: string }[] = [];
    const providers = await this.images.listProviders();
    if (!counts.tasks) issues.push({ taskId: "", message: "Enable at least one task." });
    for (const t of tasks.filter((t) => t.enabled)) {
      const c = imageBatchTaskConfiguration(t, state.defaults);
      const p = providers.find((p) => p.id === c.providerId && p.enabled);
      if (!t.prompt.trim()) issues.push({ taskId: t.id, message: "Enter an image prompt." });
      if (!p || !p.models.some((m) => m.id === c.model))
        issues.push({ taskId: t.id, message: "Select an enabled image model." });
      try {
        imageRequestParameters(c.parameters);
        const references = imageBatchTaskReferences(t, style.references);
        if (references.length > IMAGE_BATCH_MAX_REFERENCES)
          throw new Error(
            `Batch style and task references exceed ${IMAGE_BATCH_MAX_REFERENCES} images.`,
          );
        if (imageBatchComposePrompt(style.prompt, t.prompt).length > 32000)
          throw new Error("Batch style and prompt exceed 32,000 characters.");
        const assets = await Promise.all(references.map((r) => this.images.getAsset(r.assetId)));
        if (assets.reduce((n, a) => n + a.bytes, 0) > 80 * 1024 * 1024)
          throw new Error("References exceed 80 MiB.");
        for (const a of assets) await this.images.assets.read(a, "original");
        for (const r of references)
          if (r.documentId) {
            const doc = await this.images.getDocument(r.documentId);
            if (doc.compositeAssetId !== r.assetId)
              throw new Error("Editable reference does not match its image.");
          }
        if (t.sourceIds.some((id) => !state.sources.some((s) => s.id === id)))
          throw new Error("A source document is unavailable.");
      } catch (e) {
        issues.push({ taskId: t.id, message: e instanceof Error ? e.message : "Invalid task." });
      }
    }
    return { version: state.version, tasks: counts.tasks, images: counts.images, issues };
  }
  async propose(input: ImageBatchProposalInput, threadId: string, turnId: string) {
    return this.locked(async () => {
      const state = await this.get(input.batchId);
      if (state.removed || state.threadId !== threadId)
        throw new Error("This conversation does not own the batch.");
      const existing = state.proposals.find((p) => p.requestId === input.requestId);
      if (existing) {
        if (
          JSON.stringify(existing.tasks) !== JSON.stringify(input.tasks) ||
          existing.summary !== input.summary ||
          JSON.stringify(existing.warnings) !== JSON.stringify(input.warnings)
        )
          throw new Error("Proposal request ID was reused with different content.");
        return state;
      }
      if (state.version !== input.baseVersion) throw conflict();
      this.validateTasks(state, input.tasks);
      if (
        input.tasks.some((t) =>
          t.sourceIds.some((id) => !state.sources.some((source) => source.id === id)),
        )
      )
        throw new Error("Source document is not owned by this batch.");
      const known = new Set(
        state.sources
          .flatMap((s) => (s.asset ? [s.asset.id] : []))
          .concat(state.tasks.flatMap((t) => t.references.map((r) => r.assetId)))
          .concat((state.defaults.styleReferences ?? []).map((r) => r.assetId)),
      );
      for (const task of input.tasks)
        for (const r of task.references)
          if (!known.has(r.assetId)) throw new Error("Reference is not owned by this batch.");
      state.proposals.push({
        ...input,
        id: randomUUID(),
        threadId,
        turnId,
        createdAt: now(),
        status: "pending",
      });
      return this.save(state);
    });
  }
  async captureSources(
    id: string,
    threadId: string,
    sources: (ImageBatchSource & { data: Uint8Array })[],
  ) {
    return this.locked(async () => {
      const state = await this.get(id);
      if (state.threadId !== threadId || state.removed)
        throw new Error("Invalid batch conversation.");
      let changed = false;
      for (const source of sources) {
        if (
          state.sources.some(
            (s) => s.attachmentId === source.attachmentId && s.messageId === source.messageId,
          )
        )
          continue;
        const directory = path.join(this.root, id, "sources");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, source.id);
        await Effect.runPromise(
          writeFileStringAtomically({ filePath: file, contents: source.data }),
        );
        const { data, ...record } = source;
        if (record.mimeType.startsWith("image/")) {
          try {
            record.asset = await this.images.upload(data, source.name);
          } catch {
            /* Non-generation image formats remain readable documents. */
          }
        }
        state.sources.push({ ...record, path: file });
        changed = true;
      }
      return changed ? this.save(state) : state;
    });
  }
  private async attempt(
    task: ImageBatchTask,
    state: ImageBatchState,
    style: BatchStyle,
    retryOf: string | null = null,
    n?: number,
  ): Promise<ImageBatchAttempt> {
    const c = imageBatchTaskConfiguration(task, state.defaults);
    const references = await Promise.all(
      imageBatchTaskReferences(task, style.references).map(async (r) =>
        Object.assign({}, r, {
          comments: r.documentId ? (await this.images.getDocument(r.documentId)).comments : [],
        }),
      ),
    );
    const providerVersion = (await this.images.listProviders()).find(
      (p) => p.id === c.providerId,
    )?.version;
    const stylePrompt = style.prompt.trim();
    const requestPrompt = imageCommentPrompt(
      imageBatchComposePrompt(stylePrompt, task.prompt),
      references,
    );
    if (requestPrompt.length > 32000)
      throw new Error("Prompt and image comments exceed 32,000 characters.");
    return {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      prompt: task.prompt,
      ...c,
      providerVersion,
      requestPrompt,
      ...(stylePrompt ? { stylePrompt } : {}),
      parameters: { ...c.parameters, ...(n === undefined ? {} : { n }) },
      references,
      sourceIds: [...task.sourceIds],
      requestId: randomUUID(),
      jobId: null,
      status: "prepared",
      outputs: 0,
      error: null,
      retryOf,
    };
  }
  async command(input: ImageBatchCommand): Promise<ImageBatchState> {
    return this.locked(async () => {
      if (input.operation === "create") {
        const id = hash("batch:" + input.requestId);
        const previous = await this.repository.get(id);
        if (previous) {
          if (
            previous.creationFingerprint
              ? previous.creationFingerprint !== fingerprint(input)
              : previous.name !== input.name || previous.brief !== (input.brief ?? "")
          )
            throw new Error("Creation request ID was reused.");
          return previous;
        }
        const provider = (await this.images.listProviders()).find((p) => p.enabled);
        return this.save({
          id,
          creationFingerprint: fingerprint(input),
          name: input.name.trim() || "Untitled batch",
          version: 0,
          projectId: input.projectId ?? null,
          threadId: null,
          sourceThreadId: input.sourceThreadId,
          sourceMessageId: input.sourceMessageId,
          brief: input.brief ?? "",
          archived: false,
          removed: false,
          createdAt: now(),
          updatedAt: now(),
          defaults: {
            providerId: provider?.id ?? "",
            model: provider?.defaultModel ?? "",
            parameters: { n: 2, outputFormat: "png" },
          },
          tasks: [],
          sources: [],
          proposals: [],
          executions: [],
        });
      }
      const state = await this.get(input.batchId);
      if (
        state.removed &&
        !["clear-originals", "collection", "collection-start", "collection-finish"].includes(
          input.operation,
        )
      )
        throw new Error("Batch has been removed.");
      // Confirm receipts are checked before optimistic version checks: an accepted confirmation survives later draft edits.
      if (input.operation === "confirm" || input.operation === "retry") {
        const signature = fingerprint(input);
        const old = state.executions.find((e) => e.requestId === input.requestId);
        if (old) {
          if (old.fingerprint !== signature)
            throw new Error("Execution request ID was reused with different content.");
          return state;
        }
      }
      if ("version" in input && state.version !== input.version) throw conflict();
      if (input.operation === "save") {
        state.name = input.name.trim() || state.name;
        state.brief = input.brief;
        state.defaults = input.defaults;
        this.validateTasks(state, input.tasks);
        state.tasks = structuredClone(input.tasks);
        state.version++;
      } else if (input.operation === "bind-thread") {
        if (state.threadId && state.threadId !== input.threadId)
          throw new Error("Batch already has a conversation.");
        if (
          (await this.repository.forThread(input.threadId))?.id &&
          (await this.repository.forThread(input.threadId))?.id !== state.id
        )
          throw new Error("Conversation already belongs to another batch.");
        state.threadId = input.threadId;
        state.version++;
      } else if (input.operation === "apply-proposal" || input.operation === "dismiss-proposal") {
        const proposal = state.proposals.find((p) => p.id === input.proposalId);
        if (!proposal || proposal.status !== "pending")
          throw new Error("Proposal is no longer pending.");
        if (input.operation === "apply-proposal") {
          if (proposal.baseVersion !== state.version) throw conflict();
          this.validateTasks(state, proposal.tasks);
          state.tasks = structuredClone(proposal.tasks);
          state.version++;
          proposal.status = "applied";
        } else proposal.status = "dismissed";
      } else if (input.operation === "confirm" || input.operation === "retry") {
        if (state.archived || batchActive(state))
          throw new Error("Finish the active execution or restore the batch first.");
        let attempts: ImageBatchAttempt[];
        if (input.operation === "confirm") {
          const style = batchStyle(state);
          const check = await this.check(state, state.tasks, style);
          if (check.issues.length) throw new Error(check.issues.map((i) => i.message).join("\n"));
          attempts = await Promise.all(
            state.tasks.filter((t) => t.enabled).map((t) => this.attempt(t, state, style)),
          );
        } else {
          const selected = input.attemptIds.map((id) =>
            state.executions.flatMap((e) => e.attempts).find((a) => a.id === id),
          );
          if (selected.some((a) => !a)) throw new Error("Retry task is unavailable.");
          if (new Set(input.attemptIds).size !== input.attemptIds.length)
            throw new Error("Duplicate retry task.");
          attempts = [];
          for (const a of selected as ImageBatchAttempt[]) {
            if (
              (input.mode === "missing" ? imageBatchRetryLineage(state, a) : [a]).some(
                (value) => value.status === "uncertain",
              ) &&
              !input.acknowledgeUncertain
            )
              throw new Error("Verify the uncertain request before retrying.");
            const n = input.mode === "missing" ? imageBatchMissingCount(state, a) : a.parameters.n;
            if (!n) continue;
            const task: ImageBatchTask = {
              id: a.taskId,
              name: a.taskName,
              prompt: a.prompt,
              enabled: true,
              providerId: a.providerId,
              model: a.model,
              parameters: { ...a.parameters, n },
              references: a.references,
              sourceIds: a.sourceIds,
            };
            const check = await this.check(state, [task], frozenStyle(a));
            if (check.issues.length) throw new Error(check.issues.map((i) => i.message).join("\n"));
            attempts.push({
              ...(await this.attempt(task, state, frozenStyle(a), a.id, n)),
              retryMode: input.mode,
            });
          }
          if (!attempts.length) throw new Error("No missing images to generate.");
        }
        if (attempts.reduce((n, a) => n + a.parameters.n, 0) > IMAGE_BATCH_MAX_IMAGES)
          throw new Error("Execution exceeds 500 images.");
        if (new Set(attempts.map((a) => a.taskId)).size !== attempts.length)
          throw new Error("Select one attempt per task to retry.");
        const execution: ImageBatchExecution = {
          id: randomUUID(),
          requestId: input.requestId,
          fingerprint: fingerprint(input),
          draftVersion: state.version,
          createdAt: now(),
          paused: false,
          cancelled: false,
          finishedAt: null,
          attempts,
        };
        state.executions.push(execution);
      } else if (
        input.operation === "pause" ||
        input.operation === "resume" ||
        input.operation === "cancel"
      ) {
        const execution = state.executions.find((e) => e.id === input.executionId);
        if (!execution || execution.finishedAt) throw new Error("Execution is no longer active.");
        execution.paused = input.operation !== "resume";
        if (input.operation === "resume") execution.blockedProviders = [];
        if (input.operation === "cancel") {
          execution.cancelled = true;
          for (const a of execution.attempts) {
            if (a.jobId && !terminal(a.status)) await this.images.cancelJob(a.jobId);
            else if (!a.jobId) a.status = "cancelled";
          }
        }
      } else if (input.operation === "archive") {
        if (batchActive(state))
          throw new Error("Finish or cancel this execution before archiving.");
        state.archived = input.archived;
        state.version++;
      } else if (input.operation === "remove") {
        if (batchActive(state))
          throw new Error("Finish or cancel this execution before removing it.");
        state.removed = true;
        state.version++;
      } else if (input.operation === "adopt") {
        const results = await Promise.all(input.resultIds.map((id) => this.repository.result(id)));
        if (results.some((r) => r.batchId !== state.id))
          throw new Error("Result belongs to another batch.");
        await this.repository.updateResults(results.map((r) => ({ ...r, adopted: input.adopted })));
      } else if (input.operation === "collection-start") {
        if (state.activeCollections?.includes(input.operationId)) return state;
        const results = await Promise.all(input.resultIds.map((id) => this.repository.result(id)));
        if (results.some((result) => result.batchId !== state.id))
          throw new Error("Result belongs to another batch.");
        state.activeCollections = [...(state.activeCollections ?? []), input.operationId];
      } else if (input.operation === "collection-finish") {
        if (!state.activeCollections?.includes(input.operationId)) return state;
        state.activeCollections = state.activeCollections.filter((id) => id !== input.operationId);
      } else if (input.operation === "collection") {
        const result = await this.repository.result(input.resultId);
        if (result.batchId !== state.id) throw new Error("Result belongs to another batch.");
        await this.repository.updateResults([
          { ...result, collection: { libraryId: input.libraryId, resourceId: input.resourceId } },
        ]);
      } else if (input.operation === "clear-originals") {
        if (!state.removed || batchActive(state))
          throw new Error("Remove the inactive batch before clearing its originals.");
        if (state.activeCollections?.length)
          throw new Error(
            "Finish or recover pending resource copies before clearing batch originals.",
          );
        if (this.images.spriteRecoveryProjects.size)
          throw new Error(
            "References cannot be fully checked while a sprite project needs recovery.",
          );
        await this.repository.clearResults(state.id);
        state.tasks = [];
        state.proposals = [];
        state.sources = [];
        const jobs = state.executions.flatMap((e) =>
          e.attempts.flatMap((a) => (a.jobId ? [a.jobId] : [])),
        );
        state.sourceReports = [];
        await this.save(state);
        // Engine jobs may still be referenced by other workbenches; its deletion path checks every retained asset.
        for (const jobId of jobs)
          if (await Effect.runPromise(this.images.repository.getJob(jobId)))
            await this.images.deleteJob(jobId);
        await rm(path.join(this.root, state.id), { recursive: true, force: true });
        state.executions = [];
        state.version++;
      }
      return this.save(state);
    });
  }
  async tick() {
    return this.locked(async () => {
      for (const state of await this.repository.states(true)) {
        const before = JSON.stringify(state);
        const results: ImageBatchResult[] = [];
        for (const e of state.executions.filter((e) => !e.finishedAt)) {
          for (const a of e.attempts) {
            if (!a.jobId) {
              const recorded = await Effect.runPromise(
                this.images.repository.getRequest(a.requestId),
              );
              if (recorded) a.jobId = recorded.id;
            }
            if (a.jobId) {
              const job = await this.images.getJob(a.jobId);
              const priorStatus = a.status;
              a.outputs = job.outputs.length;
              a.upstreamRequestId = job.upstreamRequestId ?? job.error?.requestId ?? null;
              a.error = job.error?.message ?? null;
              a.status =
                job.status === "interrupted" ||
                (job.status === "failed" &&
                  ["timeout", "request_failed"].includes(job.error?.code ?? ""))
                  ? "uncertain"
                  : job.status;
              if (
                priorStatus !== a.status &&
                [401, 402, 403, 429].includes(job.error?.upstreamStatus ?? 0)
              )
                e.blockedProviders = [...new Set([...(e.blockedProviders ?? []), a.providerId])];
              if (terminal(job.status))
                job.outputs.forEach((asset, position) =>
                  results.push({
                    id: hash(a.id + ":" + position),
                    batchId: state.id,
                    executionId: e.id,
                    attemptId: a.id,
                    taskId: a.taskId,
                    taskName: a.taskName,
                    position,
                    asset,
                    prompt: imageBatchComposePrompt(a.stylePrompt, a.prompt),
                    model: a.model,
                    parameters: a.parameters,
                    createdAt: job.finishedAt ?? job.createdAt,
                    adopted: false,
                  }),
                );
            } else if (e.cancelled) a.status = "cancelled";
            else if (
              !e.paused &&
              !state.removed &&
              !(e.blockedProviders ?? []).includes(a.providerId) &&
              a.status === "prepared"
            ) {
              try {
                const provider = (await this.images.listProviders()).find(
                  (p) => p.id === a.providerId,
                );
                if (a.providerVersion !== undefined && provider?.version !== a.providerVersion)
                  throw new ImageApiError(
                    "provider_changed",
                    "Channel changed after confirmation. Review and confirm again.",
                  );
                const job = await this.images.createJob(
                  {
                    clientRequestId: a.requestId,
                    providerId: a.providerId,
                    model: a.model,
                    prompt: imageBatchComposePrompt(a.stylePrompt, a.prompt),
                    parameters: a.parameters,
                    inputAssetIds: a.references.map((r) => r.assetId),
                    inputReferences: a.references,
                    maskAssetId: null,
                    sourceJobId: null,
                  },
                  false,
                  { kind: "batch", ownerId: state.id },
                );
                a.jobId = job.id;
                a.status = job.status;
              } catch (error) {
                const recorded = await Effect.runPromise(
                  this.images.repository.getRequest(a.requestId),
                );
                if (recorded) {
                  a.jobId = recorded.id;
                  a.status = recorded.status;
                } else a.status = error instanceof ImageApiError ? "failed" : "prepared";
                a.error = error instanceof Error ? error.message : "Could not prepare task.";
              }
            }
          }
          if (e.attempts.every((a) => terminal(a.status))) e.finishedAt = now();
        }
        if (before !== JSON.stringify(state)) await this.save(state, results);
        else if (results.length) await this.repository.save(state, results);
      }
    });
  }
  async detachThread(threadId: string) {
    const state = await this.repository.forThread(threadId);
    if (state)
      return this.locked(async () => {
        const latest = await this.get(state.id);
        latest.threadId = null;
        latest.version++;
        return this.save(latest);
      });
  }
  async sourceBytes(batchId: string, sourceId: string) {
    const s = (await this.get(batchId)).sources.find((s) => s.id === sourceId);
    if (!s?.path) throw new Error("Source is unavailable.");
    return new Uint8Array(await readFile(s.path));
  }
  async reportSources(
    batchId: string,
    threadId: string,
    turnId: string,
    reports: NonNullable<ImageBatchState["sourceReports"]>,
  ) {
    return this.locked(async () => {
      const state = await this.get(batchId);
      if (state.threadId !== threadId || state.removed)
        throw new Error("Invalid batch conversation.");
      for (const report of reports)
        if (
          !state.sources.some((source) => source.id === report.sourceId) &&
          report.status !== "failed"
        )
          throw new Error("Unknown source report.");
      const merged = new Map(
        (state.sourceReports ?? []).map((report) => [report.sourceId, report]),
      );
      for (const report of reports) merged.set(report.sourceId, { ...report, turnId });
      state.sourceReports = [...merged.values()];
      return this.save(state);
    });
  }
}
