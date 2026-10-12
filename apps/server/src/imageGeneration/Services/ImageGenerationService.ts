import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";
import path from "node:path";
import type {
  ImageAsset,
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
    yield* promise(() => engine.initialize());
    const timer = setInterval(() => {
      void engine.tick().catch(() => {});
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
      listProviders: () => promise(() => engine.listProviders()),
      upsertProvider: (i) => promise(() => engine.upsertProvider(i)),
      deleteProvider: (id) => promise(() => engine.deleteProvider(id)),
      discoverModels: (i) => promise(() => engine.discoverModels(i)),
      testModel: (i) => promise(() => engine.testModel(i)),
      listJobs: (i) => repository.listJobs(i),
      getJob: (id) => promise(() => engine.getJob(id)),
      createJob: (i) => promise(() => engine.createJob(i)),
      cancelJob: (id) => promise(() => engine.cancelJob(id)),
      deleteJob: (id) => promise(() => engine.deleteJob(id)),
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
