import { Schema } from "effect";
import { ImageAsset } from "./imageGeneration";

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
export const SpriteRun = Schema.Struct({
  id: Id,
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
});
export type SpriteState = typeof SpriteState.Type;
export const SpriteCommand = Schema.Struct({
  operation: Schema.Literals(["get", "sync", "generate", "cancel", "retry"]),
  projectId: Id,
  context: Schema.optional(SpriteContext),
  input: Schema.optional(SpriteGenerationInput),
  runId: Schema.optional(Id),
});
export type SpriteCommand = typeof SpriteCommand.Type;
