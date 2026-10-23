import { Schema } from "effect";

export const MODEL3D_LIMITS = {
  sourceBytes: 1024 * 1024,
  fileBytes: 100 * 1024 * 1024,
  triangles: 1_000_000,
  threeTimeoutMs: 30_000,
  blenderTimeoutMs: 120_000,
  threeVersion: "0.186.1",
  blenderMcpVersion: "2.2.2",
} as const;
export const Model3DId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const Model3DMode = Schema.Literals(["threejs", "blender"]);
export type Model3DMode = typeof Model3DMode.Type;
export const Model3DParameters = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
);
export const Model3DParameter = Schema.Struct({
  key: Model3DId,
  label: Schema.String,
  type: Schema.Literals(["number", "boolean", "color", "string"]),
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
  step: Schema.optional(Schema.Finite),
});
export type Model3DParameter = typeof Model3DParameter.Type;
const PbrFactor = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const Model3DMaterialEdit = Schema.Struct({
  materialId: Schema.String,
  color: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
  roughness: Schema.optional(PbrFactor),
  metalness: Schema.optional(PbrFactor),
  opacity: Schema.optional(PbrFactor),
  baseColor: Schema.optional(Schema.NullOr(Model3DId)),
  normal: Schema.optional(Schema.NullOr(Model3DId)),
  roughnessMap: Schema.optional(Schema.NullOr(Model3DId)),
  metalnessMap: Schema.optional(Schema.NullOr(Model3DId)),
});
export type Model3DMaterialEdit = typeof Model3DMaterialEdit.Type;
export const Model3DBuild = Schema.Struct({
  mode: Model3DMode,
  source: Schema.String.check(Schema.isMaxLength(MODEL3D_LIMITS.sourceBytes)),
  parameters: Model3DParameters,
  parameterDefinitions: Schema.Array(Model3DParameter),
  parentVersionId: Schema.NullOr(Model3DId),
  prompt: Schema.String,
  materialEdits: Schema.Array(Model3DMaterialEdit),
});
export type Model3DBuild = typeof Model3DBuild.Type;
export const Model3DValidationReport = Schema.Struct({
  triangles: Schema.Finite,
  vertices: Schema.Finite,
  bytes: Schema.Finite,
  dimensions: Schema.Array(Schema.Finite),
  objects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      triangles: Schema.Finite,
      parentId: Schema.optional(Schema.NullOr(Schema.String)),
      kind: Schema.optional(Schema.Literals(["group", "mesh"])),
      depth: Schema.optional(Schema.Finite),
    }),
  ),
  materials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      color: Schema.String,
      roughness: Schema.Finite,
      metalness: Schema.Finite,
      opacity: Schema.Finite,
    }),
  ),
  textures: Schema.Array(
    Schema.Struct({ name: Schema.String, width: Schema.Finite, height: Schema.Finite }),
  ),
  warnings: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  validatorErrors: Schema.Finite,
});
export type Model3DValidationReport = typeof Model3DValidationReport.Type;
export const Model3DVersion = Schema.Struct({
  id: Model3DId,
  createdAt: Schema.String,
  name: Schema.String,
  build: Model3DBuild,
  hash: Schema.String,
  hasBlend: Schema.Boolean,
  report: Model3DValidationReport,
  files: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, hash: Schema.String, bytes: Schema.Finite })),
  ),
  runtime: Schema.optional(
    Schema.Struct({
      three: Schema.String,
      blenderMcp: Schema.String,
      blender: Schema.NullOr(Schema.String),
    }),
  ),
});
export type Model3DVersion = typeof Model3DVersion.Type;
export const Model3DJob = Schema.Struct({
  id: Model3DId,
  requestId: Model3DId,
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
  build: Model3DBuild,
  error: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Model3DId),
});
export type Model3DJob = typeof Model3DJob.Type;
export const Model3DProject = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Model3DId,
  revision: Schema.Finite,
  name: Schema.String,
  updatedAt: Schema.String,
  mode: Model3DMode,
  triangleBudget: Schema.Finite,
  textureBudget: Schema.Finite,
  threadId: Schema.NullOr(Schema.String),
  adoptedVersionId: Schema.NullOr(Model3DId),
  previewVersionId: Schema.NullOr(Model3DId).pipe(Schema.withDecodingDefault(() => null)),
  versions: Schema.Array(Model3DVersion),
  jobs: Schema.Array(Model3DJob),
  textures: Schema.Array(
    Schema.Struct({
      id: Model3DId,
      name: Schema.String,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  ),
  archived: Schema.Boolean,
});
export type Model3DProject = typeof Model3DProject.Type;
export const Model3DEnvironment = Schema.Struct({
  desktop: Schema.Boolean,
  blenderPath: Schema.NullOr(Schema.String),
  uvxPath: Schema.NullOr(Schema.String),
  prepared: Schema.Boolean,
  blenderVersion: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Model3DEnvironment = typeof Model3DEnvironment.Type;
export const Model3DCommand = Schema.Struct({
  operation: Schema.Literals([
    "create",
    "update",
    "bind-thread",
    "submit",
    "cancel",
    "adopt",
    "select-version",
    "archive",
    "environment",
    "prepare-runtime",
    "check-runtime",
    "export",
    "import",
    "texture",
    "blender-settings",
  ]),
  projectId: Schema.optional(Model3DId),
  revision: Schema.optional(Schema.Finite),
  name: Schema.optional(Schema.String),
  mode: Schema.optional(Model3DMode),
  triangleBudget: Schema.optional(Schema.Finite),
  textureBudget: Schema.optional(Schema.Finite),
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  build: Schema.optional(Model3DBuild),
  requestId: Schema.optional(Model3DId),
  versionId: Schema.optional(Model3DId),
  jobId: Schema.optional(Model3DId),
  includeSource: Schema.optional(Schema.Boolean),
  target: Schema.optional(Schema.Literals(["generic", "godot"])),
  archived: Schema.optional(Schema.Boolean),
  blenderPath: Schema.optional(Schema.String),
  uvxPath: Schema.optional(Schema.String),
});
export type Model3DCommand = typeof Model3DCommand.Type;
export const Model3DCommandResult = Schema.Struct({
  project: Schema.NullOr(Model3DProject),
  environment: Schema.optional(Model3DEnvironment),
  exportPath: Schema.optional(Schema.String),
});
export type Model3DCommandResult = typeof Model3DCommandResult.Type;
export const Model3DList = Schema.Array(
  Schema.Struct({
    id: Model3DId,
    name: Schema.String,
    mode: Model3DMode,
    updatedAt: Schema.String,
    versions: Schema.Finite,
    running: Schema.Boolean,
    archived: Schema.Boolean,
    previewVersionId: Schema.NullOr(Model3DId),
    error: Schema.optional(Schema.String),
  }),
);
export type Model3DList = typeof Model3DList.Type;
export const Model3DEvent = Schema.Struct({ projectId: Model3DId, revision: Schema.Finite });
export type Model3DEvent = typeof Model3DEvent.Type;
export interface Model3DApi {
  list: () => Promise<Model3DList>;
  get: (input: { id: string }) => Promise<Model3DProject>;
  command: (input: Model3DCommand) => Promise<Model3DCommandResult>;
  forThread: (input: { threadId: string }) => Promise<Model3DProject | null>;
  onEvent: (listener: (event: Model3DEvent) => void) => () => void;
}
