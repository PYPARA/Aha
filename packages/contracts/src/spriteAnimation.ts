import { Schema } from "effect";
import { ImageAsset, ImageGenerationParameters } from "./imageGeneration";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMaxLength(16000));
const Positive = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 4096 }),
);
export const SpriteContext = Schema.Struct({
  projectId: Id,
  threadId: Schema.NullOr(Id),
  name: Text,
  providerId: Schema.String,
  model: Schema.String,
  referenceAssetId: Schema.NullOr(Id),
  action: Text,
  frameCount: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32 })),
  loop: Schema.optional(Schema.Boolean),
  existingFrameCount: Schema.optional(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1024 })),
  ),
  fps: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  width: Positive,
  height: Positive,
  background: Schema.Literals(["chroma", "transparent"]),
  chromaKey: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
});
export type SpriteContext = typeof SpriteContext.Type;
export const SpriteGenerationInput = Schema.Struct({
  requestId: Id,
  referenceId: Schema.optional(Text),
  kind: Schema.Literals(["character", "animation"]),
  prompt: Text,
  fps: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
  loop: Schema.optional(Schema.Boolean),
  action: Schema.optional(Text),
  frameCount: Schema.optional(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32 })),
  ),
});
export type SpriteGenerationInput = typeof SpriteGenerationInput.Type;
export const SpritePlanAction = Schema.Struct({
  id: Id,
  name: Text,
  description: Text,
  enabled: Schema.Boolean,
  frameCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  fps: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  loop: Schema.Boolean,
});
export type SpritePlanAction = typeof SpritePlanAction.Type;
export const SpritePlanReference = Schema.Struct({
  purpose: Schema.optional(Text),
  source: Schema.optional(Schema.Literals(["upload", "attachment", "candidate", "project"])),
  derivedFrom: Schema.optional(Id),
  referenceId: Text,
  asset: ImageAsset,
  role: Schema.Literals(["reference", "character", "style", "pose"]),
  actionId: Schema.NullOr(Id),
});
export type SpritePlanReference = typeof SpritePlanReference.Type;
export const SpritePlanConfiguration = Schema.Struct({
  sizeSource: Schema.optional(Schema.Literals(["recommended", "user", "auto"])),
  kind: Schema.Literals(["character", "animation"]),
  mode: Schema.Literals(["combined", "separate"]),
  prompt: Text,
  creative: Schema.optional(
    Schema.Struct({
      character: Text,
      style: Text,
      view: Text,
      sources: Schema.Record(
        Schema.String,
        Schema.Literals(["user", "project", "reference", "suggested"]),
      ),
    }),
  ),
  legacyPrompt: Schema.optional(Text),
  needsReview: Schema.optional(Schema.Boolean),
  actions: Schema.Array(SpritePlanAction).check(Schema.isMaxLength(1024)),
  references: Schema.Array(SpritePlanReference).check(Schema.isMaxLength(15)),
  providerId: Schema.String,
  model: Schema.String,
  width: Positive,
  height: Positive,
  background: Schema.Literals(["chroma", "transparent"]),
  chromaKey: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  parameters: ImageGenerationParameters,
});
export type SpritePlanConfiguration = typeof SpritePlanConfiguration.Type;
export const SpriteGenerationPlan = Schema.Struct({
  id: Id,
  projectId: Id,
  threadId: Id,
  turnId: Schema.NullOr(Id),
  requestId: Id,
  version: Schema.Int,
  status: Schema.Literals(["draft", "confirmed", "dismissed"]),
  configuration: SpritePlanConfiguration,
  compiled: Schema.optional(
    Schema.Array(
      Schema.Struct({
        prompt: Schema.String,
        rows: Schema.Int,
        columns: Schema.Int,
        actionIds: Schema.Array(Id),
        referenceAssetIds: Schema.Array(Id),
      }),
    ),
  ),
  createdAt: Schema.String,
  confirmedAt: Schema.NullOr(Schema.String),
  sourceKey: Schema.optional(Schema.String),
  supersededBy: Schema.optional(Id),
  displayAfter: Schema.optional(Schema.String),
});
export type SpriteGenerationPlan = typeof SpriteGenerationPlan.Type;
export const SpriteActionOutput = Schema.Struct({
  action: SpritePlanAction,
  frames: Schema.Array(ImageAsset),
  warnings: Schema.Array(Schema.String),
});
export type SpriteActionOutput = typeof SpriteActionOutput.Type;
export const SpritePlanConfirmInput = Schema.Struct({
  projectId: Id,
  planId: Id,
  threadId: Id,
  version: Schema.Int,
});
export type SpritePlanConfirmInput = typeof SpritePlanConfirmInput.Type;
const PixelCoordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SpriteSliceCell = Schema.Struct({
  x: PixelCoordinate,
  y: PixelCoordinate,
  width: Positive,
  height: Positive,
  enabled: Schema.Boolean,
});
export const SpriteSliceConfiguration = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({ action: SpritePlanAction, cells: Schema.Array(SpriteSliceCell) }),
  ),
  canvasWidth: Positive,
  canvasHeight: Positive,
  anchorX: Schema.Finite,
  anchorY: Schema.Finite,
  reviewedActionIds: Schema.Array(Id),
});
export type SpriteSliceConfiguration = typeof SpriteSliceConfiguration.Type;
export const SpriteLayoutIssue = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  actionId: Schema.NullOr(Id),
  frameIndex: Schema.NullOr(Schema.Int),
  message: Schema.String,
});
export type SpriteLayoutIssue = typeof SpriteLayoutIssue.Type;
export const SpriteLayoutAnalysis = Schema.Struct({
  algorithmVersion: Schema.String,
  sourceId: Id,
  width: Positive,
  height: Positive,
  plannedFrames: Schema.Int,
  cells: Schema.Int,
  nonEmptyCells: Schema.Int,
  suspectedSubjects: Schema.NullOr(Schema.Int),
  reliable: Schema.Boolean,
  issues: Schema.Array(SpriteLayoutIssue),
  suggestion: SpriteSliceConfiguration,
});
export type SpriteLayoutAnalysis = typeof SpriteLayoutAnalysis.Type;
export const SpriteProcessingVersion = Schema.Struct({
  id: Id,
  createdAt: Schema.String,
  configuration: SpriteSliceConfiguration,
  frames: Schema.Array(ImageAsset),
  actions: Schema.Array(SpriteActionOutput),
  warnings: Schema.Array(Schema.String),
  issues: Schema.Array(SpriteLayoutIssue),
});
export type SpriteProcessingVersion = typeof SpriteProcessingVersion.Type;
export const SpriteCandidate = Schema.Struct({
  version: Schema.optional(Schema.Int),
  analysis: Schema.optional(SpriteLayoutAnalysis),
  slice: Schema.optional(SpriteSliceConfiguration),
  processingVersionId: Schema.optional(Id),
  processingVersions: Schema.optional(Schema.Array(SpriteProcessingVersion)),
  issues: Schema.optional(Schema.Array(SpriteLayoutIssue)),
  id: Id,
  source: ImageAsset,
  status: Schema.Literals(["pending", "processing", "ready", "needs-adjustment", "failed"]),
  frames: Schema.Array(ImageAsset),
  actions: Schema.Array(SpriteActionOutput),
  warnings: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type SpriteCandidate = typeof SpriteCandidate.Type;
export const SpriteRun = Schema.Struct({
  candidates: Schema.optional(Schema.Array(SpriteCandidate)),
  selectedCandidateId: Schema.optional(Id),
  imageStatus: Schema.optional(Schema.String),
  removedAt: Schema.optional(Schema.NullOr(Schema.String)),
  id: Id,
  planId: Schema.optional(Id),
  planVersion: Schema.optional(Schema.Int),
  requestPrompt: Schema.optional(Schema.String),
  configuration: Schema.optional(SpritePlanConfiguration),
  actions: Schema.optional(Schema.Array(SpriteActionOutput)),
  context: SpriteContext,
  input: SpriteGenerationInput,
  jobId: Schema.NullOr(Id),
  status: Schema.Literals([
    "queued",
    "running",
    "processing",
    "ready",
    "needs-adjustment",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  source: Schema.NullOr(ImageAsset),
  frames: Schema.Array(ImageAsset),
  warnings: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type SpriteRun = typeof SpriteRun.Type;
export const SpriteState = Schema.Struct({
  context: Schema.NullOr(SpriteContext),
  runs: Schema.Array(SpriteRun),
  plans: Schema.optional(Schema.Array(SpriteGenerationPlan)),
  referencePool: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: Id, reference: SpritePlanReference })),
  ),
  selectedReferences: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: Id, reference: SpritePlanReference })),
  ),
  resultPlanId: Schema.optional(Id),
  threadIds: Schema.optional(Schema.Array(Id)),
  turnContexts: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: Id, turnId: Id, context: SpriteContext })),
  ),
});
export type SpriteState = typeof SpriteState.Type;
export const SpriteCommand = Schema.Struct({
  operation: Schema.Literals([
    "get",
    "sync",
    "generate",
    "cancel",
    "retry",
    "delete",
    "propose",
    "update-plan",
    "dismiss-plan",
    "clone-plan",
    "capture-references",
    "select-reference",
    "import-references",
    "remove-run",
    "restore-run",
    "select-candidate",
    "analyze-candidate",
    "inspect-source",
    "preview-slicing",
    "save-slicing",
    "restore-slicing",
  ]),
  projectId: Id,
  context: Schema.optional(SpriteContext),
  threadIds: Schema.optional(Schema.Array(Id)),
  input: Schema.optional(SpriteGenerationInput),
  runId: Schema.optional(Id),
  candidateId: Schema.optional(Id),
  processingVersionId: Schema.optional(Id),
  slice: Schema.optional(SpriteSliceConfiguration),
  runIds: Schema.optional(Schema.Array(Id)),
  planId: Schema.optional(Id),
  version: Schema.optional(Schema.Int),
  turnId: Schema.optional(Id),
  actionId: Schema.optional(Id),
  configuration: Schema.optional(SpritePlanConfiguration),
  references: Schema.optional(Schema.Array(SpritePlanReference)),
  threadId: Schema.optional(Id),
  replacePlanId: Schema.optional(Id),
  displayAfter: Schema.optional(Schema.String),
});
export type SpriteCommand = typeof SpriteCommand.Type;

/** Stable, credential-free failures returned by the sprite MCP tool. */
export const SpriteToolFailure = Schema.Struct({
  code: Schema.String,
  phase: Schema.Literals(["context", "reference", "provider", "processing"]),
  message: Schema.String,
  retryable: Schema.Boolean,
  submitted: Schema.Boolean,
  jobId: Schema.NullOr(Id),
  runId: Schema.optional(Id),
});
export type SpriteToolFailure = typeof SpriteToolFailure.Type;
