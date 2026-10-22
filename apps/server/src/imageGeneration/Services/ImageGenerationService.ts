import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ImageBatchRepository } from "../../imageBatches/repository";
import { ImageBatchEngine } from "../../imageBatches/engine";
import { SpriteEngine } from "../../spriteAnimation/spriteEngine";
import type {
  SpriteCommand,
  SpriteState,
  SpritePlanConfirmInput,
  SpriteRetryConfirmInput,
} from "@synara/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";
import path from "node:path";
import type {
  ImageAsset,
  ImageEditDocument,
  ImageEditDocumentCreateInput,
  ImageDraft,
  ImageJob,
  ImageJobCreateInput,
  ImageJobEvent,
  ImageJobListInput,
  ImageJobListResult,
  ImageProvider,
  ImageProviderDiscoveryInput,
  ImageProviderDiscoveryResult,
  ImageProviderInput,
  ImageTestInput,
} from "@synara/contracts";
import { ServerConfig } from "../../config";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { ImageGenerationRepository } from "../../persistence/Services/ImageGenerationRepository";
import { ImageGenerationEngine } from "../imageGenerationEngine";
export interface ImageGenerationServiceShape {
  batches: ImageBatchEngine;
  spriteDetachThread: (threadId: string) => Effect.Effect<void, Error>;
  spritePropose: (input: SpriteCommand) => Effect.Effect<SpriteState, Error>;
  spriteRetryConfirm: (input: SpriteRetryConfirmInput) => Effect.Effect<SpriteState, Error>;
  spriteConfirm: (input: SpritePlanConfirmInput) => Effect.Effect<SpriteState, Error>;
  spriteCommand: (input: SpriteCommand) => Effect.Effect<SpriteState, Error>;
  spriteForThread: (threadId: string, turnId?: string) => Effect.Effect<SpriteState | null, Error>;
  createDocument: (input: ImageEditDocumentCreateInput) => Effect.Effect<ImageEditDocument, Error>;
  getDocument: (id: string) => Effect.Effect<ImageEditDocument, Error>;
  listProviders: () => Effect.Effect<readonly ImageProvider[], Error>;
  upsertProvider: (input: ImageProviderInput) => Effect.Effect<ImageProvider, Error>;
  deleteProvider: (id: string) => Effect.Effect<void, Error>;
  discoverModels: (
    input: ImageProviderDiscoveryInput,
  ) => Effect.Effect<ImageProviderDiscoveryResult, Error>;
  testModel: (input: ImageTestInput) => Effect.Effect<ImageJob, Error>;
  listJobs: (input: ImageJobListInput) => Effect.Effect<ImageJobListResult, Error>;
  getJob: (id: string) => Effect.Effect<ImageJob, Error>;
  createJob: (input: ImageJobCreateInput) => Effect.Effect<ImageJob, Error>;
  cancelJob: (id: string) => Effect.Effect<ImageJob, Error>;
  deleteJob: (id: string) => Effect.Effect<void, Error>;
  getDraft: (id: string) => Effect.Effect<ImageDraft | null, Error>;
  upsertDraft: (draft: ImageDraft) => Effect.Effect<ImageDraft, Error>;
  deleteDraft: (id: string) => Effect.Effect<void, Error>;
  upload: (bytes: Uint8Array, name: string) => Effect.Effect<ImageAsset, Error>;
  getAsset: (id: string) => Effect.Effect<ImageAsset, Error>;
  readAsset: (
    asset: ImageAsset,
    variant: "original" | "edit" | "thumbnail",
  ) => Effect.Effect<Uint8Array, Error>;
  events: Stream.Stream<ImageJobEvent>;
}
export class ImageGenerationService extends ServiceMap.Service<
  ImageGenerationService,
  ImageGenerationServiceShape
>()("synara/imageGeneration/ImageGenerationService") {}
const promise = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (e) => (e instanceof Error ? e : new Error("Drawing request failed.")),
  });
export const ImageGenerationServiceLive = Layer.effect(
  ImageGenerationService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const secrets = yield* ServerSecretStore;
    const repository = yield* ImageGenerationRepository;
    const events = yield* PubSub.unbounded<ImageJobEvent>();
    const engine = new ImageGenerationEngine(
      repository,
      secrets,
      path.join(config.stateDir, "drawing"),
      (event) => Effect.runPromise(PubSub.publish(events, event)).then(() => {}),
    );
    const sprites = new SpriteEngine(path.join(config.stateDir, "sprites"), engine, (event) =>
      Effect.runPromise(PubSub.publish(events, event)).then(() => {}),
    );
    const batches = new ImageBatchEngine(
      new ImageBatchRepository(yield* SqlClient.SqlClient),
      engine,
      path.join(config.stateDir, "image-batches"),
      (event) => Effect.runPromise(PubSub.publish(events, event)).then(() => {}),
    );
    yield* promise(() => batches.initialize());
    yield* promise(() => sprites.initialize());
    yield* promise(() => sprites.migrateJobOrigins());
    yield* promise(() => batches.tick());
    yield* promise(() => engine.initialize());
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void batches
        .tick()
        .then(() => engine.tick())
        .then(() => sprites.tick())
        .catch((error) => {
          console.error(
            "Creative queue tick failed",
            error instanceof Error ? error.message : "Unknown error",
          );
        })
        .finally(() => {
          ticking = false;
        });
    }, 500);
    timer.unref();
    const cleanup = setInterval(
      () => {
        void engine.cleanup(false).catch(() => {});
      },
      60 * 60 * 1000,
    );
    cleanup.unref();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(timer);
        clearInterval(cleanup);
        await engine.shutdown();
      }),
    );
    const service: ImageGenerationServiceShape = {
      batches,
      spriteDetachThread: (id) => promise(() => sprites.detachThread(id)),
      spritePropose: (input) => promise(() => sprites.command(input, true)),
      spriteRetryConfirm: (input) => promise(() => sprites.retryConfirm(input)),
      spriteConfirm: (input) => promise(() => sprites.confirm(input)),
      spriteCommand: (input) => promise(() => sprites.command(input)),
      spriteForThread: (id, turnId) => promise(() => sprites.forThread(id, turnId)),
      createDocument: (i) => promise(() => engine.createDocument(i)),
      getDocument: (id) => promise(() => engine.getDocument(id)),
      listProviders: () => promise(() => engine.listProviders()),
      upsertProvider: (i) => promise(() => engine.upsertProvider(i)),
      deleteProvider: (id) => promise(() => engine.deleteProvider(id)),
      discoverModels: (i) => promise(() => engine.discoverModels(i)),
      testModel: (i) => promise(() => engine.testModel(i)),
      listJobs: (i) => repository.listJobs(i),
      getJob: (id) => promise(() => engine.getJob(id)),
      createJob: (i) => promise(() => engine.createJob(i)),
      cancelJob: (id) =>
        promise(async () => {
          const job = await engine.getJob(id);
          if (job.origin?.kind === "batch" || job.origin?.kind === "sprite")
            throw new Error("Manage this task from its source workbench.");
          return engine.cancelJob(id);
        }),
      deleteJob: (id) =>
        promise(async () => {
          const job = await engine.getJob(id);
          if (job.origin?.kind === "batch" || job.origin?.kind === "sprite")
            throw new Error("Manage this task from its source workbench.");
          return engine.deleteJob(id);
        }),
      getDraft: (id) => repository.getDraft(id),
      upsertDraft: (i) => promise(() => engine.upsertDraft(i)),
      deleteDraft: (id) => repository.deleteDraft(id),
      upload: (bytes, name) => promise(() => engine.upload(bytes, name)),
      getAsset: (id) => promise(() => engine.getAsset(id)),
      readAsset: (asset, variant) => promise(() => engine.assets.read(asset, variant)),
      events: Stream.fromPubSub(events),
    };
    return service;
  }),
);
