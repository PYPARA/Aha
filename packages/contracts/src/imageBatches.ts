import { Schema, Struct } from "effect";
import {
  ImageAsset,
  ImageGenerationParameters,
  ImageInputReference,
  ImageJobStatus,
} from "./imageGeneration";

export const IMAGE_BATCH_MAX_IMAGES = 500;
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMaxLength(32000));
const Version = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const IMAGE_BATCH_MAX_STYLE_REFERENCES = 8;
export const IMAGE_BATCH_MAX_STYLE_PROMPT = 4000;
export const ImageBatchDefaults = Schema.Struct({
  providerId: Schema.String,
  model: Schema.String,
  parameters: ImageGenerationParameters,
  /** Shared style text placed before every task prompt when an execution is confirmed. */
  stylePrompt: Schema.optional(
    Schema.String.check(Schema.isMaxLength(IMAGE_BATCH_MAX_STYLE_PROMPT)),
  ),
  /** Shared style images placed before every task's own references when confirmed. */
  styleReferences: Schema.optional(
    Schema.mutable(Schema.Array(ImageInputReference)).check(
      Schema.isMaxLength(IMAGE_BATCH_MAX_STYLE_REFERENCES),
    ),
  ),
});
export type ImageBatchDefaults = typeof ImageBatchDefaults.Type;
export const ImageBatchTaskParameters = ImageGenerationParameters.mapFields((fields) => ({
  ...fields,
  n: Schema.optional(fields.n),
}));
/** A segment may not end with a dot or space, which also rules out "." and "..". */
const OUTPUT_SEGMENT = String.raw`[^\\/\u0000-\u001f<>:"|?*]*[^\\/\u0000-\u001f<>:"|?*. ]`;
/** Delivery path relative to the chosen Resource Center folder, e.g. `heroes/ember.png`. */
export const ImageBatchOutputPath = Schema.String.check(
  Schema.isMaxLength(240),
  Schema.isPattern(new RegExp(`^(?:${OUTPUT_SEGMENT}/)*${OUTPUT_SEGMENT}$`, "u")),
);
export const ImageBatchTask = Schema.Struct({
  id: Id,
  name: Schema.String.check(Schema.isMaxLength(200)),
  prompt: Text,
  enabled: Schema.Boolean,
  output: Schema.optional(ImageBatchOutputPath),
  providerId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  parameters: Schema.optional(ImageBatchTaskParameters),
  references: Schema.mutable(Schema.Array(ImageInputReference)).check(Schema.isMaxLength(16)),
  sourceIds: Schema.mutable(Schema.Array(Id)),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchTask = typeof ImageBatchTask.Type;
export const ImageBatchSource = Schema.Struct({
  id: Id,
  name: Schema.String,
  mimeType: Schema.String,
  bytes: Schema.Finite,
  threadId: Schema.String,
  messageId: Schema.String,
  attachmentId: Schema.String,
  asset: Schema.optional(ImageAsset),
  path: Schema.optional(Schema.String),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchSource = typeof ImageBatchSource.Type;
export const ImageBatchProposal = Schema.Struct({
  id: Id,
  requestId: Id,
  baseVersion: Version,
  threadId: Schema.String,
  turnId: Schema.String,
  createdAt: Schema.String,
  summary: Text,
  warnings: Schema.mutable(Schema.Array(Text)),
  tasks: Schema.mutable(Schema.Array(ImageBatchTask)),
  status: Schema.Literals(["pending", "applied", "dismissed"]),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchProposal = typeof ImageBatchProposal.Type;
export const ImageBatchAttempt = Schema.Struct({
  id: Id,
  taskId: Id,
  taskName: Schema.String,
  /** Task output path frozen at confirmation. */
  output: Schema.optional(Schema.String),
  providerId: Schema.String,
  model: Schema.String,
  parameters: ImageGenerationParameters,
  prompt: Text,
  references: Schema.mutable(Schema.Array(ImageInputReference)),
  requestPrompt: Schema.optional(Text),
  /** Batch style frozen at confirmation; retries reuse it instead of the current defaults. */
  stylePrompt: Schema.optional(Text),
  providerVersion: Schema.optional(Version),
  sourceIds: Schema.mutable(Schema.Array(Id)),
  requestId: Id,
  jobId: Schema.NullOr(Id),
  status: Schema.Union([ImageJobStatus, Schema.Literals(["prepared", "uncertain"])]),
  outputs: Version,
  error: Schema.NullOr(Schema.String),
  retryOf: Schema.NullOr(Id),
  retryMode: Schema.optional(Schema.Literals(["missing", "regenerate"])),
  upstreamRequestId: Schema.optional(Schema.NullOr(Schema.String)),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchAttempt = typeof ImageBatchAttempt.Type;
export const ImageBatchExecution = Schema.Struct({
  id: Id,
  requestId: Id,
  fingerprint: Schema.String,
  draftVersion: Version,
  createdAt: Schema.String,
  paused: Schema.Boolean,
  cancelled: Schema.Boolean,
  finishedAt: Schema.NullOr(Schema.String),
  blockedProviders: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  attempts: Schema.mutable(Schema.Array(ImageBatchAttempt)),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchExecution = typeof ImageBatchExecution.Type;
export const ImageBatchState = Schema.Struct({
  id: Id,
  name: Schema.String.check(Schema.isMaxLength(200)),
  version: Version,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  sourceThreadId: Schema.optional(Schema.String),
  sourceMessageId: Schema.optional(Schema.String),
  creationFingerprint: Schema.optional(Schema.String),
  brief: Text,
  archived: Schema.Boolean,
  removed: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  defaults: ImageBatchDefaults,
  tasks: Schema.mutable(Schema.Array(ImageBatchTask)),
  sources: Schema.mutable(Schema.Array(ImageBatchSource)),
  proposals: Schema.mutable(Schema.Array(ImageBatchProposal)),
  sourceReports: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          sourceId: Schema.String,
          status: Schema.Literals(["unread", "read", "failed"]),
          message: Text,
          turnId: Schema.String,
        }),
      ),
    ),
  ),
  executions: Schema.mutable(Schema.Array(ImageBatchExecution)),
  activeCollections: Schema.optional(Schema.mutable(Schema.Array(Id))),
}).mapFields(Struct.map(Schema.mutableKey));
export type ImageBatchState = typeof ImageBatchState.Type;
export const ImageBatchResult = Schema.Struct({
  id: Id,
  batchId: Id,
  executionId: Id,
  attemptId: Id,
  taskId: Id,
  taskName: Schema.String,
  output: Schema.optional(Schema.String),
  position: Version,
  asset: ImageAsset,
  prompt: Text,
  model: Schema.String,
  parameters: ImageGenerationParameters,
  createdAt: Schema.String,
  adopted: Schema.Boolean,
  collection: Schema.optional(
    Schema.Struct({
      libraryId: Schema.String,
      resourceId: Schema.String,
    }),
  ),
});
export type ImageBatchResult = typeof ImageBatchResult.Type;
export const ImageBatchListInput = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.Literals(["all", "draft", "active", "issues", "archived"])),
});
export const ImageBatchSummary = Schema.Struct({
  id: Id,
  name: Schema.String,
  updatedAt: Schema.String,
  archived: Schema.Boolean,
  tasks: Version,
  planned: Version,
  generated: Version,
  issues: Version,
  active: Schema.Boolean,
});
export type ImageBatchSummary = typeof ImageBatchSummary.Type;
export const ImageBatchListResult = Schema.Struct({
  batches: Schema.mutable(Schema.Array(ImageBatchSummary)),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ImageBatchResultsInput = Schema.Struct({
  batchId: Id,
  cursor: Schema.optional(Schema.String),
  taskId: Schema.optional(Id),
  filter: Schema.optional(Schema.Literals(["all", "adopted", "unadopted", "uncollected"])),
});
export const ImageBatchImportSources = Schema.Struct({
  batchId: Id,
  sourceThreadId: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({ messageId: Schema.String, attachmentId: Schema.String }),
  ).check(Schema.isMaxLength(32)),
});
export const ImageBatchResultsPage = Schema.Struct({
  results: Schema.mutable(Schema.Array(ImageBatchResult)),
  total: Version,
  nextCursor: Schema.NullOr(Schema.String),
});
export type ImageBatchResultsPage = typeof ImageBatchResultsPage.Type;
export const ImageBatchIssue = Schema.Struct({ taskId: Schema.String, message: Schema.String });
export const ImageBatchPreflight = Schema.Struct({
  version: Version,
  tasks: Version,
  images: Version,
  issues: Schema.mutable(Schema.Array(ImageBatchIssue)),
});
export type ImageBatchPreflight = typeof ImageBatchPreflight.Type;
export const ImageBatchCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    requestId: Id,
    name: Schema.String,
    brief: Schema.optional(Text),
    projectId: Schema.optional(Schema.String),
    sourceThreadId: Schema.optional(Schema.String),
    sourceMessageId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("save"),
    batchId: Id,
    version: Version,
    name: Schema.String,
    brief: Text,
    defaults: ImageBatchDefaults,
    tasks: Schema.mutable(Schema.Array(ImageBatchTask)),
  }),
  Schema.Struct({
    operation: Schema.Literal("bind-thread"),
    batchId: Id,
    version: Version,
    threadId: Schema.String,
  }),
  Schema.Struct({
    operation: Schema.Literals(["apply-proposal", "dismiss-proposal"]),
    batchId: Id,
    version: Version,
    proposalId: Id,
  }),
  Schema.Struct({
    operation: Schema.Literal("confirm"),
    batchId: Id,
    version: Version,
    requestId: Id,
  }),
  Schema.Struct({
    operation: Schema.Literals(["pause", "resume", "cancel"]),
    batchId: Id,
    executionId: Id,
  }),
  Schema.Struct({
    operation: Schema.Literal("retry"),
    batchId: Id,
    version: Version,
    requestId: Id,
    attemptIds: Schema.mutable(Schema.Array(Id)).check(Schema.isMinLength(1)),
    mode: Schema.Literals(["missing", "regenerate"]),
    acknowledgeUncertain: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("archive"),
    batchId: Id,
    version: Version,
    archived: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("remove"), batchId: Id, version: Version }),
  Schema.Struct({
    operation: Schema.Literal("adopt"),
    batchId: Id,
    resultIds: Schema.mutable(Schema.Array(Id)),
    adopted: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("collection"),
    batchId: Id,
    resultId: Id,
    libraryId: Schema.String,
    resourceId: Schema.String,
  }),
  Schema.Struct({ operation: Schema.Literal("clear-originals"), batchId: Id, version: Version }),
  Schema.Struct({
    operation: Schema.Literal("collection-start"),
    batchId: Id,
    operationId: Id,
    resultIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({ operation: Schema.Literal("collection-finish"), batchId: Id, operationId: Id }),
]);
export type ImageBatchCommand = typeof ImageBatchCommand.Type;
export const ImageBatchProposalInput = Schema.Struct({
  batchId: Id,
  baseVersion: Version,
  requestId: Id,
  summary: Text,
  warnings: Schema.mutable(Schema.Array(Text)),
  tasks: Schema.mutable(Schema.Array(ImageBatchTask)),
});
export type ImageBatchProposalInput = typeof ImageBatchProposalInput.Type;
export interface ImageBatchesApi {
  list(input: typeof ImageBatchListInput.Type): Promise<typeof ImageBatchListResult.Type>;
  get(input: { id: string }): Promise<ImageBatchState>;
  command(input: ImageBatchCommand): Promise<ImageBatchState>;
  preflight(input: { id: string }): Promise<ImageBatchPreflight>;
  results(input: typeof ImageBatchResultsInput.Type): Promise<ImageBatchResultsPage>;
  result(input: { id: string }): Promise<ImageBatchResult>;
  importSources(input: typeof ImageBatchImportSources.Type): Promise<ImageBatchState>;
  forThread(input: { threadId: string }): Promise<ImageBatchState | null>;
  onEvent(callback: (event: { type: string; batchId?: string }) => void): () => void;
}

export function imageBatchTaskConfiguration(task: ImageBatchTask, defaults: ImageBatchDefaults) {
  return {
    providerId: task.providerId ?? defaults.providerId,
    model: task.model ?? defaults.model,
    parameters: {
      ...defaults.parameters,
      ...task.parameters,
      n: task.parameters?.n ?? defaults.parameters.n,
    },
  };
}
/** The prompt sent for a task: frozen batch style, a blank line, then the task prompt. */
export function imageBatchComposePrompt(stylePrompt: string | undefined, prompt: string) {
  const style = stylePrompt?.trim();
  return style ? style + "\n\n" + prompt : prompt;
}
/** Style references first, then the task's own; an image used by both is sent once. */
export function imageBatchTaskReferences(
  task: Pick<ImageBatchTask, "references">,
  styleReferences: readonly ImageInputReference[] = [],
) {
  const seen = new Set<string>();
  return [...styleReferences, ...task.references].filter((r) => {
    if (seen.has(r.assetId)) return false;
    seen.add(r.assetId);
    return true;
  });
}
export function imageBatchPlanCounts(
  tasks: readonly ImageBatchTask[],
  defaults: ImageBatchDefaults,
) {
  const enabled = tasks.filter((t) => t.enabled);
  return {
    tasks: enabled.length,
    images: enabled.reduce((n, t) => n + imageBatchTaskConfiguration(t, defaults).parameters.n, 0),
  };
}
export function imageBatchDiff(
  before: readonly ImageBatchTask[],
  after: readonly ImageBatchTask[],
) {
  const previous = new Map(before.map((t) => [t.id, t]));
  const next = new Map(after.map((t) => [t.id, t]));
  return {
    added: after.filter((t) => !previous.has(t.id)),
    removed: before.filter((t) => !next.has(t.id)),
    changed: after.filter(
      (t) => previous.has(t.id) && JSON.stringify(previous.get(t.id)) !== JSON.stringify(t),
    ),
    reordered:
      before
        .map((t) => t.id)
        .filter((id) => next.has(id))
        .join() !==
      after
        .map((t) => t.id)
        .filter((id) => previous.has(id))
        .join(),
  };
}
/** Missing retries share a lineage; successful descendants satisfy the original deficit. */
export function imageBatchRetryLineage(state: ImageBatchState, attempt: ImageBatchAttempt) {
  const all = state.executions.flatMap((execution) => execution.attempts);
  const byId = new Map(all.map((value) => [value.id, value]));
  const children = new Map<string, string[]>();
  for (const value of all)
    if (value.retryMode === "missing" && value.retryOf)
      children.set(value.retryOf, [...(children.get(value.retryOf) ?? []), value.id]);
  const seen = new Set<string>(),
    pending = [attempt.id];
  const lineage: ImageBatchAttempt[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const value = byId.get(id);
    if (value) lineage.push(value);
    pending.push(...(children.get(id) ?? []));
  }
  return lineage;
}
export function imageBatchMissingCount(state: ImageBatchState, attempt: ImageBatchAttempt) {
  return Math.max(
    0,
    attempt.parameters.n -
      imageBatchRetryLineage(state, attempt).reduce((n, value) => n + value.outputs, 0),
  );
}
