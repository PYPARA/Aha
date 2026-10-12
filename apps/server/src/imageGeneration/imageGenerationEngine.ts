import { imageCommentPrompt } from "./imageEditDocuments";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  IMAGE_INPUT_MAX_TOTAL_BYTES,
  type ImageDraft,
  type ImageEditDocument,
  type ImageEditDocumentCreateInput,
  type ImageInputReference,
  type ImageGenerationError,
  type ImageJob,
  type ImageJobCreateInput,
  type ImageJobEvent,
  type ImageProvider,
  type ImageProviderDiscoveryInput,
  type ImageProviderInput,
  type ImageTestInput,
} from "@synara/contracts";
import type { ImageGenerationRepositoryShape } from "../persistence/Services/ImageGenerationRepository";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import { writeFileStringAtomically } from "../atomicWrite";
import { ImageAssetStore } from "./imageAssetStore";
import {
  discoverImageModels,
  downloadImage,
  ImageApiError,
  imageRequestParameters,
  normalizeImageBaseUrl,
  redactImageError,
  requestImages,
} from "./imageApi";

interface SavingManifest {
  payload: Record<string, unknown>;
  saved: Record<string, string>;
}
const now = () => new Date().toISOString();
export const isImageJobActive = (status: ImageJob["status"]) =>
  ["queued", "running", "saving"].includes(status);
const secretName = (id: string) => `image-provider-${id}-key`;
export class ImageGenerationEngine {
  /** Assets retained by persistent sprite generation records. */
  readonly spriteAssetIds = new Set<string>();
  readonly assets: ImageAssetStore;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<
    string,
    { providerId: string; controller: AbortController; task: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly repository: ImageGenerationRepositoryShape,
    readonly secrets: ServerSecretStoreShape,
    readonly root: string,
    readonly publish: (event: ImageJobEvent) => Promise<void>,
  ) {
    this.assets = new ImageAssetStore(root, repository);
  }
  locked<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.catch(() => {});
    return task;
  }
  async key(id: string) {
    const bytes = await Effect.runPromise(this.secrets.get(secretName(id)));
    return bytes ? new TextDecoder().decode(bytes) : "";
  }
  async initialize() {
    await mkdir(path.join(this.root, "pending"), { recursive: true, mode: 0o700 });
    for (const job of await Effect.runPromise(this.repository.activeJobs())) {
      if (job.status === "running")
        await this.save({
          ...job,
          status: "interrupted",
          finishedAt: now(),
          error: {
            code: "interrupted",
            message:
              "The request was interrupted. Retry manually; the provider may already have charged it.",
          },
        });
      else if (job.status === "saving") {
        try {
          const manifest = JSON.parse(
            await readFile(this.manifest(job.id), "utf8"),
          ) as SavingManifest;
          await this.complete(job, manifest, job.upstreamRequestId, AbortSignal.timeout(120000));
        } catch {
          await this.save({
            ...job,
            status: job.outputs.length ? "partial" : "failed",
            finishedAt: now(),
            error: {
              code: "save_interrupted",
              message: "Some image results could not be recovered. Generation was not resent.",
            },
          });
        }
      }
    }
    await this.cleanup(false);
    await this.tick();
  }
  private manifest(id: string) {
    return path.join(this.root, "pending", `${id}.json`);
  }
  private async save(job: ImageJob) {
    const stored = { ...job, updatedAt: now() };
    await Effect.runPromise(this.repository.saveJob(stored));
    await this.publish({ type: "changed", jobId: stored.id });
    return stored;
  }
  async listProviders() {
    return Effect.runPromise(this.repository.listProviders());
  }
  async upsertProvider(input: ImageProviderInput) {
    return this.locked(async () => {
      const baseUrl = normalizeImageBaseUrl(input.baseUrl),
        id = input.id ?? randomUUID();
      const previous = (await this.listProviders()).find((p) => p.id === id);
      const models = [...new Map(input.models.map((m) => [m.id, m])).values()];
      if (!models.length || !models.some((m) => m.id === input.defaultModel))
        throw new ImageApiError(
          "invalid_models",
          "Choose at least one model and a default model from the selected list.",
        );
      const oldKey = await this.key(id),
        key = input.apiKey === undefined ? oldKey : input.apiKey.trim();
      const version =
        (previous?.version ?? 0) + (previous?.baseUrl !== baseUrl || oldKey !== key ? 1 : 0);
      const provider: ImageProvider = {
        id,
        name: input.name.trim(),
        baseUrl,
        apiKeyConfigured: Boolean(key),
        enabled: input.enabled,
        models: models.map((m) => {
          const old = previous?.models.find((o) => o.id === m.id);
          return {
            id: m.id,
            source: m.source,
            lastTestAt: old?.lastTestAt ?? null,
            lastTestStatus: old?.lastTestStatus ?? null,
          };
        }),
        defaultModel: input.defaultModel,
        concurrency: input.concurrency,
        timeoutSeconds: input.timeoutSeconds,
        version,
        updatedAt: now(),
      };
      if (key !== oldKey) {
        if (key)
          await Effect.runPromise(this.secrets.set(secretName(id), new TextEncoder().encode(key)));
        else await Effect.runPromise(this.secrets.remove(secretName(id)));
      }
      try {
        await Effect.runPromise(this.repository.saveProvider(provider));
      } catch (e) {
        if (key !== oldKey) {
          if (oldKey)
            await Effect.runPromise(
              this.secrets.set(secretName(id), new TextEncoder().encode(oldKey)),
            );
          else await Effect.runPromise(this.secrets.remove(secretName(id)));
        }
        throw e;
      }
      await this.publish({ type: "providers-changed" });
      return provider;
    });
  }
  async deleteProvider(id: string) {
    return this.locked(async () => {
      if ((await Effect.runPromise(this.repository.activeJobs())).some((j) => j.providerId === id))
        throw new ImageApiError(
          "provider_busy",
          "Cancel or finish this provider's queued and running tasks before deleting it.",
        );
      await Effect.runPromise(this.repository.deleteProvider(id));
      await Effect.runPromise(this.secrets.remove(secretName(id)));
      await this.publish({ type: "providers-changed" });
    });
  }
  async discoverModels(input: ImageProviderDiscoveryInput) {
    return {
      models: await discoverImageModels(
        input.baseUrl,
        input.apiKey ?? (input.id ? await this.key(input.id) : ""),
      ),
    };
  }
  async getJob(id: string) {
    const job = await Effect.runPromise(this.repository.getJob(id));
    if (!job) throw new ImageApiError("not_found", "Image task was not found.");
    return job;
  }
  async getAsset(id: string) {
    const asset = await Effect.runPromise(this.repository.getAsset(id));
    if (!asset) throw new ImageApiError("asset_missing", "Image asset was not found.");
    return asset;
  }
  async upload(bytes: Uint8Array, name: string) {
    return this.locked(() => this.assets.save(bytes, name));
  }
  async getDocument(id: string): Promise<ImageEditDocument> {
    const document = await Effect.runPromise(this.repository.getDocument(id));
    if (!document)
      throw new ImageApiError("document_missing", "Editable image document was not found.");
    return document;
  }
  async createDocument(input: ImageEditDocumentCreateInput): Promise<ImageEditDocument> {
    return this.locked(async () => {
      const composite = await this.getAsset(input.compositeAssetId);
      const base = input.baseAssetId ? await this.getAsset(input.baseAssetId) : null;
      if (
        composite.width !== input.width ||
        composite.height !== input.height ||
        (base && (base.width !== input.width || base.height !== input.height))
      )
        throw new ImageApiError(
          "document_dimensions",
          "Editable document dimensions must match its images.",
        );
      if (
        new Set(input.elements.map((e) => e.id)).size !== input.elements.length ||
        new Set(input.comments.map((c) => c.id)).size !== input.comments.length
      )
        throw new ImageApiError("document_ids", "Editable document IDs must be unique.");
      const document: ImageEditDocument = {
        ...input,
        comments: input.comments
          .filter((c) => c.text.trim())
          .map((c) => ({ id: c.id, x: c.x, y: c.y, text: c.text.trim() })),
        id: randomUUID(),
        version: 1,
        createdAt: now(),
      };
      await Effect.runPromise(this.repository.saveDocument(document));
      return document;
    });
  }
  private async references(
    ids: readonly string[],
    supplied?: readonly ImageInputReference[],
  ): Promise<ImageInputReference[]> {
    if (!supplied) return ids.map((assetId) => ({ id: randomUUID(), assetId, documentId: null }));
    if (
      supplied.length !== ids.length ||
      supplied.some((r, i) => r.assetId !== ids[i]) ||
      new Set(supplied.map((r) => r.id)).size !== supplied.length
    )
      throw new ImageApiError(
        "reference_order",
        "Reference metadata must match the ordered input images.",
      );
    return Promise.all(
      supplied.map(async (r) => {
        if (!r.documentId) return { ...r, comments: [] };
        const document = await this.getDocument(r.documentId);
        if (document.compositeAssetId !== r.assetId)
          throw new ImageApiError(
            "document_asset",
            "Editable document does not match its reference image.",
          );
        return { ...r, comments: document.comments };
      }),
    );
  }
  async createJob(input: ImageJobCreateInput, isTest = false) {
    return this.locked(async () => {
      const existing = await Effect.runPromise(this.repository.getRequest(input.clientRequestId));
      if (existing) return existing;
      const provider = (await this.listProviders()).find((p) => p.id === input.providerId);
      if (!provider) throw new ImageApiError("provider_missing", "Image provider was not found.");
      if (!provider.enabled)
        throw new ImageApiError("provider_disabled", "Image provider is disabled.");
      if (!provider.models.some((m) => m.id === input.model))
        throw new ImageApiError("model_missing", "Select a model enabled for this provider.");
      imageRequestParameters(input.parameters);
      const references = await this.references(input.inputAssetIds, input.inputReferences);
      const requestPrompt = imageCommentPrompt(input.prompt, references);
      if (!requestPrompt)
        throw new ImageApiError("prompt_required", "Enter a prompt or an image comment.");
      if (requestPrompt.length > 32000)
        throw new ImageApiError(
          "prompt_limit",
          "Prompt and image comments exceed 32,000 characters.",
        );
      const inputs = await Promise.all(input.inputAssetIds.map((id) => this.getAsset(id)));
      const mask = input.maskAssetId ? await this.getAsset(input.maskAssetId) : null;
      if (inputs.some((a) => a.bytes > 20 * 1024 * 1024))
        throw new ImageApiError("input_limit", "Each reference image must be at most 20 MiB.");
      if (
        inputs.length > 16 ||
        inputs.reduce((sum, a) => sum + a.bytes, 0) + (mask?.bytes ?? 0) >
          IMAGE_INPUT_MAX_TOTAL_BYTES
      )
        throw new ImageApiError("input_limit", "Reference images exceed the task size limit.");
      if (mask) {
        if (!inputs[0])
          throw new ImageApiError("mask_without_image", "A mask requires a reference image.");
        await this.assets.validateMask(mask, inputs[0]);
      }
      const job: ImageJob = {
        id: randomUUID(),
        clientRequestId: input.clientRequestId,
        providerId: provider.id,
        providerName: provider.name,
        providerVersion: provider.version,
        model: input.model,
        prompt: input.prompt.trim(),
        requestPrompt,
        inputReferences: references,
        parameters: input.parameters,
        status: "queued",
        error: null,
        createdAt: now(),
        updatedAt: now(),
        startedAt: null,
        finishedAt: null,
        sourceJobId: input.sourceJobId,
        isTest,
        inputs,
        mask,
        outputs: [],
        actualParameters: {},
        usage: null,
        upstreamRequestId: null,
      };
      await this.save(job);
      return job;
    });
  }
  testModel(input: ImageTestInput) {
    return this.createJob(
      {
        clientRequestId: input.clientRequestId,
        providerId: input.id,
        model: input.model,
        prompt: "A simple blue circle on a white background.",
        parameters: { n: 1 },
        inputAssetIds: [],
        maskAssetId: null,
        sourceJobId: null,
      },
      true,
    );
  }
  async tick() {
    if (this.stopped) return;
    await this.locked(async () => {
      const providers = await this.listProviders();
      const jobs = await Effect.runPromise(this.repository.activeJobs());
      for (const queued of jobs) {
        if (queued.status !== "queued") continue;
        const provider = providers.find((p) => p.id === queued.providerId);
        if (!provider) {
          await this.save({
            ...queued,
            status: "failed",
            finishedAt: now(),
            error: { code: "provider_missing", message: "Image provider is no longer available." },
          });
          continue;
        }
        if (!provider.enabled) continue;
        if (provider.version !== queued.providerVersion) {
          await this.save({
            ...queued,
            status: "failed",
            finishedAt: now(),
            error: {
              code: "provider_changed",
              message:
                "Provider connection or API Key changed after submission. Submit the task again.",
            },
          });
          continue;
        }
        if (
          [...this.active.values()].filter((v) => v.providerId === provider.id).length >=
          provider.concurrency
        )
          continue;
        const key = await this.key(provider.id);
        const job = await this.save({ ...queued, status: "running", startedAt: now() });
        const controller = new AbortController();
        const slot = { providerId: provider.id, controller, task: Promise.resolve() };
        this.active.set(job.id, slot);
        slot.task = this.run(job, provider, key, controller)
          .catch(() => {})
          .finally(() => {
            this.active.delete(job.id);
          });
      }
    });
  }
  private async run(
    job: ImageJob,
    provider: ImageProvider,
    key: string,
    controller: AbortController,
  ) {
    try {
      const images = await Promise.all(job.inputs.map((a) => this.assets.read(a)));
      const mask = job.mask ? await this.assets.read(job.mask) : undefined;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(provider.timeoutSeconds * 1000),
      ]);
      const result = await requestImages({
        baseUrl: provider.baseUrl,
        key,
        model: job.model,
        prompt: job.requestPrompt ?? job.prompt,
        parameters: job.parameters,
        images,
        ...(mask ? { mask } : {}),
        signal,
      });
      await this.locked(async () => {
        const current = await this.getJob(job.id);
        if (current.status !== "running" || this.stopped) return;
        await Effect.runPromise(
          writeFileStringAtomically({
            filePath: this.manifest(job.id),
            contents: JSON.stringify({
              payload: result.payload,
              saved: {},
            } satisfies SavingManifest),
          }),
        );
        await this.save({ ...current, status: "saving", upstreamRequestId: result.requestId });
      });
      if (!this.stopped)
        await this.complete(
          await this.getJob(job.id),
          { payload: result.payload, saved: {} },
          result.requestId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        );
    } catch (e) {
      if (this.stopped) return;
      await this.locked(async () => {
        const current = await this.getJob(job.id);
        if (!isImageJobActive(current.status)) return;
        const api = e instanceof ImageApiError ? e : null;
        const error: ImageGenerationError = {
          code:
            api?.code ??
            (e instanceof Error && e.name === "TimeoutError" ? "timeout" : "request_failed"),
          message: redactImageError(
            e instanceof Error ? e.message : "Image generation failed.",
            key,
          ),
          ...(api?.upstreamStatus ? { upstreamStatus: api.upstreamStatus } : {}),
          ...(api?.requestId ? { requestId: api.requestId } : {}),
        };
        const failed = await this.save({
          ...current,
          status: current.outputs.length ? "partial" : "failed",
          error,
          finishedAt: now(),
        });
        await this.recordTest(failed);
      });
    }
  }
  private async complete(
    job: ImageJob,
    manifest: SavingManifest,
    requestId: string | null,
    signal: AbortSignal,
  ) {
    if (job.status !== "saving") return;
    const payload = manifest.payload;
    const data = Array.isArray(payload.data) ? payload.data : [];
    let failures = 0;
    for (const [index, item] of data.entries()) {
      if (signal.aborted || this.stopped) break;
      try {
        if (manifest.saved[String(index)]) {
          await this.locked(async () => {
            const current = await this.getJob(job.id);
            if (current.status !== "saving") return;
            const assets = await Promise.all(
              Object.keys(manifest.saved)
                .map(Number)
                .toSorted((a, b) => a - b)
                .map((i) => this.getAsset(manifest.saved[String(i)]!)),
            );
            job = await this.save({ ...current, outputs: assets });
          });
          continue;
        }
        const value = item as { b64_json?: unknown; url?: unknown };
        let bytes: Uint8Array;
        if (typeof value.b64_json === "string") {
          if (
            value.b64_json.length > 90 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.b64_json)
          )
            throw new ImageApiError("invalid_image", "Provider returned invalid image data.");
          bytes = Uint8Array.from(Buffer.from(value.b64_json, "base64"));
        } else if (typeof value.url === "string") bytes = await downloadImage(value.url, signal);
        else throw new ImageApiError("invalid_image", "Provider returned an empty image result.");
        await this.locked(async () => {
          const current = await this.getJob(job.id);
          if (current.status !== "saving") return;
          const asset = await this.assets.save(
            bytes,
            `generated-${index + 1}.${job.parameters.outputFormat ?? "png"}`,
            64 * 1024 * 1024,
          );
          manifest.saved[String(index)] = asset.id;
          await Effect.runPromise(
            writeFileStringAtomically({
              filePath: this.manifest(job.id),
              contents: JSON.stringify(manifest),
            }),
          );
          const assets = await Promise.all(
            Object.keys(manifest.saved)
              .map(Number)
              .toSorted((a, b) => a - b)
              .map((i) => this.getAsset(manifest.saved[String(i)]!)),
          );
          job = await this.save({ ...current, outputs: assets });
        });
      } catch {
        failures++;
      }
    }
    await this.locked(async () => {
      const current = await this.getJob(job.id);
      if (current.status !== "saving" || this.stopped) return;
      const actual: Record<string, import("effect").Schema.Json> = {};
      for (const k of ["size", "quality", "background", "output_format", "created"])
        if (payload[k] !== undefined) actual[k] = payload[k] as import("effect").Schema.Json;
      const revised = data
        .map((i) => (i as { revised_prompt?: unknown })?.revised_prompt)
        .filter((v) => typeof v === "string");
      if (revised.length) actual.revised_prompts = revised as string[];
      const count = current.outputs.length;
      const status =
        count === current.parameters.n && !failures ? "succeeded" : count ? "partial" : "failed";
      const completed = await this.save({
        ...current,
        status,
        error:
          status === "succeeded"
            ? null
            : {
                code: "incomplete_results",
                message: `Saved ${count} of ${current.parameters.n} requested images. Some results were missing or could not be saved.`,
              },
        actualParameters: actual,
        usage:
          payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
            ? (payload.usage as ImageJob["usage"])
            : null,
        upstreamRequestId: requestId,
        finishedAt: now(),
      });
      await this.recordTest(completed);
      await rm(this.manifest(job.id), { force: true });
    });
  }
  private async recordTest(job: ImageJob) {
    if (!job.isTest) return;
    const p = (await this.listProviders()).find((p) => p.id === job.providerId);
    if (p) {
      await Effect.runPromise(
        this.repository.saveProvider({
          ...p,
          models: p.models.map((m) =>
            m.id === job.model
              ? { id: m.id, source: m.source, lastTestAt: now(), lastTestStatus: job.status }
              : m,
          ),
        }),
      );
      await this.publish({ type: "providers-changed" });
    }
  }
  async cancelJob(id: string) {
    return this.locked(async () => {
      const job = await this.getJob(id);
      if (!isImageJobActive(job.status)) return job;
      this.active.get(id)?.controller.abort();
      return this.save({ ...job, status: "cancelled", finishedAt: now(), error: null });
    });
  }
  async deleteJob(id: string) {
    return this.locked(async () => {
      const job = await this.getJob(id);
      if (isImageJobActive(job.status))
        throw new ImageApiError("task_active", "Cancel the task before deleting it.");
      await Effect.runPromise(this.repository.deleteJob(id));
      await rm(this.manifest(id), { force: true });
      await this.publish({ type: "deleted", jobId: id });
      const candidates = new Set(
        [...job.inputs, ...job.outputs, ...(job.mask ? [job.mask] : [])].map((a) => a.id),
      );
      for (const asset of await Effect.runPromise(this.repository.unusedAssets(now())))
        if (candidates.has(asset.id) && !this.spriteAssetIds.has(asset.id))
          await this.assets.remove(asset.id);
    });
  }
  async upsertDraft(draft: ImageDraft) {
    return this.locked(async () => {
      if (draft.inputAssetIds.length > 16)
        throw new ImageApiError("input_limit", "At most 16 reference images are allowed.");
      for (const id of [...draft.inputAssetIds, ...(draft.maskAssetId ? [draft.maskAssetId] : [])])
        await this.getAsset(id);
      const inputReferences = await this.references(draft.inputAssetIds, draft.inputReferences);
      const stored = { ...draft, inputReferences, updatedAt: now() };
      await Effect.runPromise(this.repository.saveDraft(stored));
      return stored;
    });
  }
  async cleanup(_immediate: boolean) {
    await this.locked(async () => {
      const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      for (const doc of await Effect.runPromise(this.repository.unusedDocuments(before)))
        await Effect.runPromise(this.repository.deleteDocument(doc.id));
      for (const asset of await Effect.runPromise(this.repository.unusedAssets(before)))
        if (!this.spriteAssetIds.has(asset.id)) await this.assets.remove(asset.id);
    });
  }
  async shutdown() {
    this.stopped = true;
    for (const slot of this.active.values()) slot.controller.abort();
    await Promise.allSettled([...this.active.values()].map((slot) => slot.task));
  }
}
