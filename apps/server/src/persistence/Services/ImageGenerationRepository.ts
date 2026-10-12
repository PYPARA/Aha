import type {
  ImageAsset,
  ImageEditDocument,
  ImageDraft,
  ImageJob,
  ImageJobListInput,
  ImageJobListResult,
  ImageProvider,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
export interface ImageGenerationRepositoryShape {
  getDocument: (id: string) => Effect.Effect<ImageEditDocument | null, Error>;
  saveDocument: (document: ImageEditDocument) => Effect.Effect<void, Error>;
  unusedDocuments: (before: string) => Effect.Effect<readonly ImageEditDocument[], Error>;
  deleteDocument: (id: string) => Effect.Effect<void, Error>;
  listProviders: () => Effect.Effect<readonly ImageProvider[], Error>;
  saveProvider: (provider: ImageProvider) => Effect.Effect<void, Error>;
  deleteProvider: (id: string) => Effect.Effect<void, Error>;
  listJobs: (input: ImageJobListInput) => Effect.Effect<ImageJobListResult, Error>;
  activeJobs: () => Effect.Effect<readonly ImageJob[], Error>;
  getJob: (id: string) => Effect.Effect<ImageJob | null, Error>;
  getRequest: (id: string) => Effect.Effect<ImageJob | null, Error>;
  saveJob: (job: ImageJob) => Effect.Effect<void, Error>;
  deleteJob: (id: string) => Effect.Effect<void, Error>;
  getAsset: (id: string) => Effect.Effect<ImageAsset | null, Error>;
  findAsset: (hash: string) => Effect.Effect<ImageAsset | null, Error>;
  saveAsset: (asset: ImageAsset, hash: string) => Effect.Effect<void, Error>;
  getDraft: (id: string) => Effect.Effect<ImageDraft | null, Error>;
  saveDraft: (draft: ImageDraft) => Effect.Effect<void, Error>;
  deleteDraft: (id: string) => Effect.Effect<void, Error>;
  unusedAssets: (before: string) => Effect.Effect<readonly ImageAsset[], Error>;
  deleteAsset: (id: string) => Effect.Effect<void, Error>;
}
export class ImageGenerationRepository extends ServiceMap.Service<
  ImageGenerationRepository,
  ImageGenerationRepositoryShape
>()("synara/persistence/ImageGenerationRepository") {}
