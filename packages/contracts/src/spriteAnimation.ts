import { Schema } from "effect";
import { ImageAsset, ImageGenerationParameters } from "./imageGeneration";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMaxLength(16000));
const Positive = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 4096 }),
);
export const SpriteRenderSpec = Schema.Struct({
  mode: Schema.Literals(["pixel", "illustration"]),
  logicalWidth: Positive,
  logicalHeight: Positive,
  outputScale: Positive,
});
export type SpriteRenderSpec = typeof SpriteRenderSpec.Type;
export const SpriteRegistration = Schema.Struct({
  scale: Schema.Finite.check(Schema.isGreaterThan(0)),
  offsetX: Schema.Finite,
  offsetY: Schema.Finite,
});
export type SpriteRegistration = typeof SpriteRegistration.Type;
export const SpriteCharacterPreview = Schema.Struct({
  background: Schema.optional(Schema.Literals(["chroma", "transparent"])),
  chromaKey: Schema.optional(Schema.String),
  source: ImageAsset,
  asset: ImageAsset,
  generationReference: Schema.optional(ImageAsset),
  renderSpec: SpriteRenderSpec,
  registration: SpriteRegistration,
  pivotX: Schema.Finite,
  pivotY: Schema.Finite,
});
export const SpriteCanonicalReference = Schema.Struct({
  ...SpriteCharacterPreview.fields,
  revision: Id,
  confirmedAt: Schema.String,
});
export type SpriteCanonicalReference = typeof SpriteCanonicalReference.Type;
export const SpriteSizePolicy = Schema.Struct({
  kind: Schema.Literals(["fixed", "custom"]),
  sizes: Schema.optional(Schema.Array(Schema.String)),
  referenceImages: Schema.optional(Schema.Boolean),
  minPixels: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  maxPixels: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  maxEdge: Schema.optional(Positive),
  maxAspectRatio: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))),
  multiple: Schema.optional(Positive),
});
export type SpriteSizePolicy = typeof SpriteSizePolicy.Type;
export const SpriteTaskSegment = Schema.Struct({
  actionId: Id,
  frameStart: Schema.Int,
  frameCount: Positive,
  totalFrames: Positive,
  index: Schema.Int,
  count: Positive,
});
export type SpriteTaskSegment = typeof SpriteTaskSegment.Type;
export const SpriteTaskLayout = Schema.Struct({
  width: Positive,
  height: Positive,
  columns: Positive,
  rows: Positive,
  cells: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Id),
      actionId: Schema.NullOr(Id),
      frameIndex: Schema.NullOr(Schema.Int),
      x: Schema.Int,
      y: Schema.Int,
      width: Positive,
      height: Positive,
    }),
  ),
});
export type SpriteTaskLayout = typeof SpriteTaskLayout.Type;
export const SpriteTaskSnapshot = Schema.Struct({
  runId: Id,
  canonicalRevision: Schema.optional(Id),
  renderSpec: SpriteRenderSpec,
  segment: SpriteTaskSegment,
  layout: SpriteTaskLayout,
  sourceAssetId: Schema.optional(Id),
  processingVersionId: Schema.optional(Id),
});
export type SpriteTaskSnapshot = typeof SpriteTaskSnapshot.Type;
export const SpriteContext = Schema.Struct({
  selection: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["character", "actions", "export"]),
      actionId: Schema.optional(Id),
      candidateId: Schema.optional(Id),
      processingVersionId: Schema.optional(Id),
      frameId: Schema.optional(Id),
      frameIndex: Schema.optional(Schema.Int),
    }),
  ),
  workflowVersion: Schema.optional(Schema.Literal(2)),
  renderSpec: Schema.optional(SpriteRenderSpec),
  canonical: Schema.optional(SpriteCanonicalReference),
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
/** Imported/edited actions may exceed the separate 32-frame generation limit. */
export const SpriteProcessingAction = Schema.Struct({
  ...SpritePlanAction.fields,
  frameCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })),
});
export const SpriteEditDescription = Schema.Struct({
  version: Schema.Literal(1),
  cells: Schema.Array(
    Schema.Struct({
      id: Id,
      x: PixelValue(),
      y: PixelValue(),
      width: Positive,
      height: Positive,
      originX: Schema.Finite,
      originY: Schema.Finite,
      enabled: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(1024)),
  actions: Schema.Array(
    Schema.Struct({
      action: SpriteProcessingAction,
      frames: Schema.Array(
        Schema.Struct({
          id: Id,
          cellId: Id,
          allowEmpty: Schema.optional(Schema.Boolean),
          offsetX: Schema.Finite,
          offsetY: Schema.Finite,
          durationMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
          anchor: Schema.optional(
            Schema.Struct({ x: Schema.Finite, y: Schema.Finite, confirmed: Schema.Boolean }),
          ),
        }),
      ).check(Schema.isMaxLength(1024)),
    }),
  ).check(Schema.isMaxLength(1024)),
  common: Schema.Struct({
    canvasWidth: Positive,
    canvasHeight: Positive,
    anchorX: Schema.Finite,
    anchorY: Schema.Finite,
    registration: SpriteRegistration,
  }),
});
function PixelValue() {
  return Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
}
export type SpriteEditDescription = typeof SpriteEditDescription.Type;
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
export const SpriteSizing = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literals(["linked", "manual", "model"]),
  sourceScale: Schema.Literals([1, 2]),
  arrangement: Schema.Literals(["auto", "fixed"]),
  columns: Schema.optional(Positive),
  rows: Schema.optional(Positive),
  margin: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4096 })),
  gap: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4096 })),
});
export type SpriteSizing = typeof SpriteSizing.Type;
export const SpritePlanConfiguration = Schema.Struct({
  sizing: Schema.optional(SpriteSizing),
  sequenceId: Schema.optional(Id),
  workflowVersion: Schema.optional(Schema.Literal(2)),
  renderSpec: Schema.optional(SpriteRenderSpec),
  canonical: Schema.optional(SpriteCanonicalReference),
  sizePolicy: Schema.optional(SpriteSizePolicy),
  segment: Schema.optional(SpriteTaskSegment),
  layout: Schema.optional(SpriteTaskLayout),
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
  targetKey: Schema.optional(Schema.String),
  supersededBy: Schema.optional(Id),
  displayAfter: Schema.optional(Schema.String),
});
export type SpriteGenerationPlan = typeof SpriteGenerationPlan.Type;
export const SpriteActionOutput = Schema.Struct({
  action: SpriteProcessingAction,
  frameMetadata: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        cellId: Id,
        durationMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
      }),
    ),
  ),
  frames: Schema.Array(ImageAsset),
  masters: Schema.optional(Schema.Array(ImageAsset)),
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
export const SpriteRetryConfirmInput = Schema.Struct({
  projectId: Id,
  threadId: Id,
  runIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  requestId: Id,
});
export type SpriteRetryConfirmInput = typeof SpriteRetryConfirmInput.Type;
const PixelCoordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SpriteSliceCell = Schema.Struct({
  id: Schema.optional(Id),
  frameId: Schema.optional(Id),
  allowEmpty: Schema.optional(Schema.Boolean),
  offsetX: Schema.optional(Schema.Finite),
  offsetY: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  originX: Schema.optional(Schema.Finite),
  originY: Schema.optional(Schema.Finite),
  x: PixelCoordinate,
  y: PixelCoordinate,
  width: Positive,
  height: Positive,
  enabled: Schema.Boolean,
});
export const SpriteSliceConfiguration = Schema.Struct({
  edit: Schema.optional(SpriteEditDescription),
  background: Schema.optional(Schema.Literals(["chroma", "transparent"])),
  chromaKey: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
  registration: Schema.optional(SpriteRegistration),
  rows: Schema.Array(
    Schema.Struct({ action: SpriteProcessingAction, cells: Schema.Array(SpriteSliceCell) }),
  ),
  canvasWidth: Positive,
  canvasHeight: Positive,
  anchorX: Schema.Finite,
  anchorY: Schema.Finite,
  reviewedActionIds: Schema.Array(Id),
});
export type SpriteSliceConfiguration = typeof SpriteSliceConfiguration.Type;
export const SpriteProcessingSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  runId: Id,
  sourceAssetId: Id,
  processingVersionId: Schema.optional(Id),
  renderSpec: Schema.optional(SpriteRenderSpec),
  configuration: SpriteSliceConfiguration,
});
export type SpriteProcessingSnapshot = typeof SpriteProcessingSnapshot.Type;

export const SpriteLayoutIssue = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  actionId: Schema.NullOr(Id),
  frameIndex: Schema.NullOr(Schema.Int),
  message: Schema.String,
});
export type SpriteLayoutIssue = typeof SpriteLayoutIssue.Type;
export const SpriteLayoutAnalysis = Schema.Struct({
  cellGeometries: Schema.optional(SpriteTaskLayout),
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
export const SpriteReviewRecord = Schema.Struct({
  actionId: Id,
  processingVersionId: Schema.optional(Id),
  analysisRevision: Schema.Int,
  createdAt: Schema.String,
});
export type SpriteReviewRecord = typeof SpriteReviewRecord.Type;
export const SpriteCandidate = Schema.Struct({
  reviews: Schema.optional(Schema.Array(SpriteReviewRecord)),
  analysisRevision: Schema.optional(Schema.Int),
  processingAttempts: Schema.optional(Schema.Int),
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
  importOrigin: Schema.optional(
    Schema.Struct({
      version: Schema.Literal(1),
      sourceAssetId: Id,
      targetActionIds: Schema.Array(Id),
      branchId: Id,
      legacyRequestId: Schema.optional(Text),
    }),
  ),
  assembledRunIds: Schema.optional(Schema.Array(Id)),
  dependsOnRunId: Schema.optional(Id),
  submissionProviderName: Schema.optional(Schema.String),
  retryOfRunId: Schema.optional(Id),
  retryRequestId: Schema.optional(Id),
  submissionInputs: Schema.optional(Schema.Array(Id)),
  submissionParameters: Schema.optional(ImageGenerationParameters),
  submissionPhase: Schema.optional(
    Schema.Literals(["prepared", "submitting", "submitted", "rejected", "uncertain"]),
  ),
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
  recovery: Schema.optional(
    Schema.Struct({
      version: Schema.Literal(1),
      status: Schema.Literals(["recovered", "partial", "failed"]),
      readOnly: Schema.Boolean,
      backupFile: Schema.optional(Schema.String),
      diagnostics: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
    }),
  ),
  canonicalVersions: Schema.optional(Schema.Array(SpriteCanonicalReference)),
  canonical: Schema.optional(SpriteCanonicalReference),
  characterPreview: Schema.optional(SpriteCharacterPreview),
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
    "preview-character",
    "confirm-character",
    "reprocess-candidate",
    "fork-slicing",
    "review-candidate",
  ]),
  projectId: Id,
  renderSpec: Schema.optional(SpriteRenderSpec),
  registration: Schema.optional(SpriteRegistration),
  context: Schema.optional(SpriteContext),
  threadIds: Schema.optional(Schema.Array(Id)),
  input: Schema.optional(SpriteGenerationInput),
  runId: Schema.optional(Id),
  candidateId: Schema.optional(Id),
  processingVersionId: Schema.optional(Id),
  analysisRevision: Schema.optional(Schema.Int),
  slice: Schema.optional(SpriteSliceConfiguration),
  runIds: Schema.optional(Schema.Array(Id)),
  planId: Schema.optional(Id),
  version: Schema.optional(Schema.Int),
  turnId: Schema.optional(Id),
  actionId: Schema.optional(Id),
  importBranchId: Schema.optional(Id),
  reload: Schema.optional(Schema.Boolean),
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
