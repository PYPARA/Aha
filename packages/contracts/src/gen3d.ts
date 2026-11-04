import { Schema } from "effect";
import { Model3DValidationReport } from "./model3d";

export const GEN3D_LIMITS = {
  sourceBytes: 1024 * 1024,
  fileBytes: 200 * 1024 * 1024,
  referenceBytes: 32 * 1024 * 1024,
  triangles: 1_000_000,
  buildTimeoutMs: 60_000,
  maxRounds: 10,
  blueprintSize: 256,
  threeVersion: "0.186.1",
} as const;
export const GEN3D_VIEWS = ["front", "side", "back"] as const;
export const Gen3DId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const Gen3DView = Schema.Literals(GEN3D_VIEWS);
export type Gen3DView = typeof Gen3DView.Type;

export const Gen3DReference = Schema.Struct({
  id: Gen3DId,
  name: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
  origin: Schema.Literals(["upload", "drawing"]),
  imageJobId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Gen3DReference = typeof Gen3DReference.Type;
const Gen3DBox = Schema.Struct({
  x0: Schema.Finite,
  x1: Schema.Finite,
  y0: Schema.Finite,
  y1: Schema.Finite,
});
export const Gen3DBlueprint = Schema.Struct({
  referenceId: Gen3DId,
  /** Real height of the asset, metres. */
  targetHeight: Schema.Finite,
  /** Blueprint pixels per metre, shared by the three views. */
  pxPerMetre: Schema.Finite,
  /** Column boxes of front/side/back in the reference image, in reference pixels. */
  boxes: Schema.Struct({ front: Gen3DBox, side: Gen3DBox, back: Gen3DBox }),
  confirmed: Schema.Boolean,
  createdAt: Schema.String,
});
export type Gen3DBlueprint = typeof Gen3DBlueprint.Type;
export const Gen3DBuild = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(GEN3D_LIMITS.sourceBytes)),
  prompt: Schema.String,
  parentVersionId: Schema.NullOr(Gen3DId),
});
export type Gen3DBuild = typeof Gen3DBuild.Type;
export const Gen3DViewScore = Schema.Struct({
  iou: Schema.Finite,
  contourPct: Schema.Finite,
  shiftPx: Schema.Finite,
  mirrored: Schema.optional(Schema.Boolean),
});
export const Gen3DRegion = Schema.Struct({
  view: Gen3DView,
  kind: Schema.Literals(["extra", "missing"]),
  where: Schema.String,
  pct: Schema.Finite,
});
export type Gen3DRegion = typeof Gen3DRegion.Type;
export const Gen3DScore = Schema.Struct({
  score: Schema.Finite,
  maxRegionPct: Schema.Finite,
  views: Schema.Struct({ front: Gen3DViewScore, side: Gen3DViewScore, back: Gen3DViewScore }),
  regions: Schema.Array(Gen3DRegion),
});
export type Gen3DScore = typeof Gen3DScore.Type;
export const Gen3DTopology = Schema.Struct({
  boundaryEdges: Schema.Finite,
  nonManifoldEdges: Schema.Finite,
});
export const Gen3DVersion = Schema.Struct({
  id: Gen3DId,
  name: Schema.String,
  createdAt: Schema.String,
  build: Gen3DBuild,
  hash: Schema.String,
  report: Model3DValidationReport,
  topology: Gen3DTopology,
  score: Schema.NullOr(Gen3DScore),
  runId: Schema.NullOr(Gen3DId),
  round: Schema.NullOr(Schema.Finite),
  files: Schema.Array(
    Schema.Struct({ name: Schema.String, hash: Schema.String, bytes: Schema.Finite }),
  ),
  runtime: Schema.Struct({ three: Schema.String }),
});
export type Gen3DVersion = typeof Gen3DVersion.Type;
export const Gen3DJob = Schema.Struct({
  id: Gen3DId,
  requestId: Gen3DId,
  fingerprint: Schema.String,
  createdAt: Schema.String,
  status: Schema.Literals([
    "queued",
    "running",
    "validating",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  build: Gen3DBuild,
  runId: Schema.NullOr(Gen3DId),
  turnId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Gen3DId),
});
export type Gen3DJob = typeof Gen3DJob.Type;
/** A user authorization for the model to iterate up to maxRounds submissions on its own. */
export const Gen3DRun = Schema.Struct({
  id: Gen3DId,
  createdAt: Schema.String,
  maxRounds: Schema.Finite,
  usedRounds: Schema.Finite,
  stopMaxRegionPct: Schema.Finite,
  stopMinGain: Schema.Finite,
  status: Schema.Literals(["active", "completed", "stopped", "interrupted"]),
  stopReason: Schema.NullOr(Schema.String),
});
export type Gen3DRun = typeof Gen3DRun.Type;
export const Gen3DProject = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Gen3DId,
  revision: Schema.Finite,
  name: Schema.String,
  description: Schema.String,
  updatedAt: Schema.String,
  triangleBudget: Schema.Finite,
  threadId: Schema.NullOr(Schema.String),
  adoptedVersionId: Schema.NullOr(Gen3DId),
  previewVersionId: Schema.NullOr(Gen3DId),
  references: Schema.Array(Gen3DReference),
  blueprint: Schema.NullOr(Gen3DBlueprint),
  versions: Schema.Array(Gen3DVersion),
  jobs: Schema.Array(Gen3DJob),
  runs: Schema.Array(Gen3DRun),
  archived: Schema.Boolean,
});
export type Gen3DProject = typeof Gen3DProject.Type;
export const Gen3DEnvironment = Schema.Struct({
  desktop: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type Gen3DEnvironment = typeof Gen3DEnvironment.Type;
export const Gen3DCommand = Schema.Struct({
  operation: Schema.Literals([
    "create",
    "update",
    "bind-thread",
    "add-reference",
    "import-reference-asset",
    "extract-blueprint",
    "confirm-blueprint",
    "start-run",
    "stop-run",
    "submit",
    "cancel",
    "adopt",
    "select-version",
    "archive",
    "export",
    "environment",
  ]),
  projectId: Schema.optional(Gen3DId),
  revision: Schema.optional(Schema.Finite),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  triangleBudget: Schema.optional(Schema.Finite),
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  referenceId: Schema.optional(Gen3DId),
  imageAssetId: Schema.optional(Schema.String),
  imageJobId: Schema.optional(Schema.String),
  targetHeight: Schema.optional(Schema.Finite),
  maxRounds: Schema.optional(Schema.Finite),
  runId: Schema.optional(Gen3DId),
  build: Schema.optional(Gen3DBuild),
  requestId: Schema.optional(Gen3DId),
  turnId: Schema.optional(Schema.String),
  versionId: Schema.optional(Gen3DId),
  jobId: Schema.optional(Gen3DId),
  archived: Schema.optional(Schema.Boolean),
});
export type Gen3DCommand = typeof Gen3DCommand.Type;
export const Gen3DCommandResult = Schema.Struct({
  project: Schema.NullOr(Gen3DProject),
  environment: Schema.optional(Gen3DEnvironment),
  exportPath: Schema.optional(Schema.String),
});
export type Gen3DCommandResult = typeof Gen3DCommandResult.Type;
export const Gen3DList = Schema.Array(
  Schema.Struct({
    id: Gen3DId,
    name: Schema.String,
    updatedAt: Schema.String,
    versions: Schema.Finite,
    running: Schema.Boolean,
    archived: Schema.Boolean,
    previewVersionId: Schema.NullOr(Gen3DId),
    stage: Schema.Literals(["empty", "blueprint", "modeling", "adopted"]),
    score: Schema.NullOr(Schema.Finite),
    maxRegionPct: Schema.NullOr(Schema.Finite),
    triangles: Schema.NullOr(Schema.Finite),
    error: Schema.optional(Schema.String),
  }),
);
export type Gen3DList = typeof Gen3DList.Type;
export const Gen3DEvent = Schema.Struct({ projectId: Gen3DId, revision: Schema.Finite });
export type Gen3DEvent = typeof Gen3DEvent.Type;
export interface Gen3DApi {
  list: () => Promise<Gen3DList>;
  get: (input: { id: string }) => Promise<Gen3DProject>;
  command: (input: Gen3DCommand) => Promise<Gen3DCommandResult>;
  forThread: (input: { threadId: string }) => Promise<Gen3DProject | null>;
  onEvent: (listener: (event: Gen3DEvent) => void) => () => void;
}
