import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

const Id = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const ModelId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Integer = Schema.Finite.check(Schema.isInt());
export const IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_INPUT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
export const IMAGE_INPUT_MAX_COUNT = 16;
export const ImageProviderId = Id;
export type ImageProviderId = typeof ImageProviderId.Type;
export const ImageProviderModel = Schema.Struct({
  id: ModelId,
  source: Schema.Literals(["discovered", "manual"]),
  lastTestAt: Schema.NullOr(IsoDateTime),
  lastTestStatus: Schema.NullOr(Schema.String),
});
export type ImageProviderModel = typeof ImageProviderModel.Type;
export const ImageProvider = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  baseUrl: TrimmedNonEmptyString,
  apiKeyConfigured: Schema.Boolean,
  enabled: Schema.Boolean,
  models: Schema.Array(ImageProviderModel),
  defaultModel: ModelId,
  concurrency: Integer.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  timeoutSeconds: Integer.check(Schema.isBetween({ minimum: 30, maximum: 1800 })),
  version: Integer,
  updatedAt: IsoDateTime,
});
export type ImageProvider = typeof ImageProvider.Type;
export const ImageProviderInput = Schema.Struct({
  id: Schema.optional(Id),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  baseUrl: TrimmedNonEmptyString,
  apiKey: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  models: Schema.Array(ImageProviderModel).check(Schema.isMinLength(1)),
  defaultModel: ModelId,
  concurrency: Integer.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  timeoutSeconds: Integer.check(Schema.isBetween({ minimum: 30, maximum: 1800 })),
});
export type ImageProviderInput = typeof ImageProviderInput.Type;
export const ImageProviderDiscoveryInput = Schema.Struct({
  id: Schema.optional(Id),
  baseUrl: TrimmedNonEmptyString,
  apiKey: Schema.optional(Schema.String),
});
export type ImageProviderDiscoveryInput = typeof ImageProviderDiscoveryInput.Type;
export const ImageModel = Schema.Struct({
  id: ModelId,
  created: Schema.NullOr(Schema.Finite),
  ownedBy: Schema.NullOr(Schema.String),
  imageHint: Schema.Boolean,
});
export type ImageModel = typeof ImageModel.Type;
export const ImageProviderDiscoveryResult = Schema.Struct({ models: Schema.Array(ImageModel) });
export type ImageProviderDiscoveryResult = typeof ImageProviderDiscoveryResult.Type;
export const ImageGenerationParameters = Schema.Struct({
  size: Schema.optional(
    Schema.String.check(Schema.isPattern(/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/)),
  ),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high", "xhigh", "max"])),
  n: Integer.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  outputFormat: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
  background: Schema.optional(Schema.Literals(["auto", "opaque", "transparent"])),
});
export type ImageGenerationParameters = typeof ImageGenerationParameters.Type;
export const ImageAsset = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  url: TrimmedNonEmptyString,
  thumbnailUrl: TrimmedNonEmptyString,
  width: Integer,
  height: Integer,
  bytes: Integer,
  createdAt: IsoDateTime,
});
export type ImageAsset = typeof ImageAsset.Type;
export const ImageComment = Schema.Struct({
  id: Id,
  x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  text: Schema.String.check(Schema.isMaxLength(2000)),
});
export type ImageComment = typeof ImageComment.Type;
const EditPoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
const EditStroke = Schema.Struct({
  width: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  points: Schema.Array(EditPoint).check(Schema.isMaxLength(100000)),
});
const EditStyle = {
  id: Id,
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  width: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  erase: Schema.optional(Schema.Array(EditStroke)),
};
export const ImageEditElement = Schema.Union([
  Schema.Struct({
    ...EditStyle,
    type: Schema.Literal("path"),
    points: Schema.Array(EditPoint).check(Schema.isMinLength(1), Schema.isMaxLength(100000)),
  }),
  Schema.Struct({
    ...EditStyle,
    type: Schema.Literal("shape"),
    shape: Schema.Literals([
      "line",
      "arrow",
      "rect",
      "ellipse",
      "triangle",
      "diamond",
      "star",
      "heart",
    ]),
    start: EditPoint,
    end: EditPoint,
  }),
  Schema.Struct({
    ...EditStyle,
    type: Schema.Literal("text"),
    x: Schema.Finite,
    y: Schema.Finite,
    text: Schema.String.check(Schema.isMaxLength(10000)),
    fontSize: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  }),
]);
export type ImageEditElement = typeof ImageEditElement.Type;
export const ImageEditDocumentCreateInput = Schema.Struct({
  baseAssetId: Schema.NullOr(Id),
  compositeAssetId: Id,
  width: Integer.check(Schema.isBetween({ minimum: 1, maximum: 99999 })),
  height: Integer.check(Schema.isBetween({ minimum: 1, maximum: 99999 })),
  elements: Schema.Array(ImageEditElement).check(Schema.isMaxLength(2000)),
  comments: Schema.Array(ImageComment).check(Schema.isMaxLength(100)),
});
export type ImageEditDocumentCreateInput = typeof ImageEditDocumentCreateInput.Type;
export const ImageEditDocument = Schema.Struct({
  ...ImageEditDocumentCreateInput.fields,
  id: Id,
  version: Schema.Literal(1),
  createdAt: IsoDateTime,
});
export type ImageEditDocument = typeof ImageEditDocument.Type;
export const ImageInputReference = Schema.Struct({
  id: Id,
  assetId: Id,
  documentId: Schema.NullOr(Id),
  comments: Schema.optional(Schema.Array(ImageComment).check(Schema.isMaxLength(100))),
});
export type ImageInputReference = typeof ImageInputReference.Type;
const InputReferences = Schema.optional(
  Schema.Array(ImageInputReference).check(Schema.isMaxLength(16)),
);
export const ImageJobStatus = Schema.Literals([
  "queued",
  "running",
  "saving",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ImageJobStatus = typeof ImageJobStatus.Type;
export const ImageGenerationError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  upstreamStatus: Schema.optional(Integer),
  requestId: Schema.optional(Schema.String),
});
export type ImageGenerationError = typeof ImageGenerationError.Type;
export const ImageJob = Schema.Struct({
  id: Id,
  clientRequestId: Id,
  providerId: Id,
  providerName: TrimmedNonEmptyString,
  providerVersion: Integer,
  model: ModelId,
  prompt: Schema.String.check(Schema.isMaxLength(32000)),
  parameters: ImageGenerationParameters,
  inputReferences: InputReferences,
  requestPrompt: Schema.optional(Schema.String.check(Schema.isMaxLength(32000))),
  status: ImageJobStatus,
  error: Schema.NullOr(ImageGenerationError),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  sourceJobId: Schema.NullOr(Id),
  isTest: Schema.Boolean,
  inputs: Schema.Array(ImageAsset),
  mask: Schema.NullOr(ImageAsset),
  outputs: Schema.Array(ImageAsset),
  actualParameters: Schema.Record(Schema.String, Schema.Json),
  usage: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
  upstreamRequestId: Schema.NullOr(Schema.String),
});
export type ImageJob = typeof ImageJob.Type;
export const ImageJobCreateInput = Schema.Struct({
  clientRequestId: Id,
  providerId: Id,
  model: ModelId,
  prompt: Schema.String.check(Schema.isMaxLength(32000)),
  parameters: ImageGenerationParameters,
  inputAssetIds: Schema.Array(Id).check(Schema.isMaxLength(16)),
  inputReferences: InputReferences,
  maskAssetId: Schema.NullOr(Id),
  sourceJobId: Schema.NullOr(Id),
});
export type ImageJobCreateInput = typeof ImageJobCreateInput.Type;
export const ImageJobListInput = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  statusGroup: Schema.optional(Schema.Literals(["all", "active", "completed", "issues"])),
});
export type ImageJobListInput = typeof ImageJobListInput.Type;
export const ImageJobListResult = Schema.Struct({
  jobs: Schema.Array(ImageJob),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ImageJobListResult = typeof ImageJobListResult.Type;
export const ImageDraft = Schema.Struct({
  id: Id,
  prompt: Schema.String.check(Schema.isMaxLength(32000)),
  providerId: Schema.NullOr(Id),
  model: Schema.String,
  parameters: ImageGenerationParameters,
  inputAssetIds: Schema.Array(Id).check(Schema.isMaxLength(16)),
  inputReferences: InputReferences,
  maskAssetId: Schema.NullOr(Id),
  updatedAt: IsoDateTime,
});
export type ImageDraft = typeof ImageDraft.Type;
export const ImageJobEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("changed"), jobId: Id }),
  Schema.Struct({ type: Schema.Literal("deleted"), jobId: Id }),
  Schema.Struct({ type: Schema.Literal("providers-changed") }),
  Schema.Struct({ type: Schema.Literal("snapshot") }),
]);
export type ImageJobEvent = typeof ImageJobEvent.Type;
export const ImageIdInput = Schema.Struct({ id: Id });
export const ImageTestInput = Schema.Struct({ id: Id, model: ModelId, clientRequestId: Id });
export type ImageTestInput = typeof ImageTestInput.Type;
