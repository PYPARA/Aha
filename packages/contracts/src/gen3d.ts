import { Schema } from "effect";
import { ImageAsset } from "./imageGeneration";
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
  skeletonNodes: 256,
  /** Blender start, modeling and the fixed export; waiting for the shared Blender lock is extra. */
  blenderBuildMs: 170_000,
  blenderWaitMs: 90_000,
  /** Fixed headless Blender scripts (optimize, convert); baking 4K maps is the slow case. */
  processMs: 600_000,
} as const;
/** Low-poly presets from the asset pipeline plan: hero, prop, background, mobile. */
export const GEN3D_TRIANGLE_PRESETS = [20_000, 5_000, 1_500, 800] as const;
export const GEN3D_TEXTURE_SIZES = [512, 1024, 2048, 4096] as const;
/** Procedural PBR presets Aha's fixed script builds and bakes; AI never writes material nodes. */
export const GEN3D_MATERIAL_PRESETS = [
  "wood",
  "metal",
  "painted-metal",
  "gold",
  "stone",
  "fabric",
  "leather",
  "plastic",
] as const;
export const GEN3D_EXPORT_PRESETS = {
  generic: "glb",
  godot: "glb",
  unity: "fbx",
  unreal: "fbx",
} as const;
export const GEN3D_VIEWS = ["front", "side", "back"] as const;
/** Orthographic views a baked version can be repainted from (Blender numpad naming, glTF +Z front). */
export const GEN3D_REPAINT_VIEWS = [
  "front",
  "front-right",
  "right",
  "back",
  "left",
  "front-left",
  "top",
] as const;
/** Procedural clips the fixed rigging script can add; generic skeletons get idle only. */
export const GEN3D_ANIMATION_CLIPS = ["idle", "walk", "run", "attack"] as const;
/** Fixed stylizations and the range of their detail value. */
export const GEN3D_STYLES = {
  /** Cells along the longest side. */
  voxel: { min: 8, max: 96, default: 32 },
  /** Brick widths along the longest side. */
  bricks: { min: 6, max: 64, default: 20 },
  /** Target triangles. */
  lowpoly: { min: 50, max: 20_000, default: 600 },
} as const;
export type Gen3DStyle = keyof typeof GEN3D_STYLES;
/** Square size of repaint view renders and of the edited image projected back. */
export const GEN3D_REPAINT_SIZE = 1024;
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
/** A seamless texture the project keeps for tiled materials (generated or uploaded). */
export const Gen3DTexture = Schema.Struct({
  id: Gen3DId,
  name: Schema.String,
  /** The user's description, without Aha's prompt template. */
  prompt: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
  imageJobId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Gen3DTexture = typeof Gen3DTexture.Type;
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
/**
 * Which runtime produced the version; builds written before Blender support are Three.js.
 * "process" versions come from Aha's fixed optimization script, never from AI source.
 */
export const Gen3DMode = Schema.Literals(["threejs", "blender", "process"]);
export type Gen3DMode = typeof Gen3DMode.Type;
/** One joint of a skeleton graph: metres, Y up, the same frame as the published model. */
export const Gen3DSkeletonNode = Schema.Struct({
  id: Gen3DId,
  parent: Schema.NullOr(Gen3DId),
  position: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]),
  radius: Schema.Finite,
});
export type Gen3DSkeletonNode = typeof Gen3DSkeletonNode.Type;
export const Gen3DSkeleton = Schema.Array(Gen3DSkeletonNode).check(
  Schema.isMaxLength(GEN3D_LIMITS.skeletonNodes),
);
/** Fixed post-processing of a parent version into a game-ready low poly. */
export const Gen3DProcess = Schema.Struct({
  targetTriangles: Schema.Finite.check(Schema.isBetween({ minimum: 100, maximum: 200_000 })),
  textureSize: Schema.Literals(GEN3D_TEXTURE_SIZES),
  /** Merge duplicate vertices, drop loose vertices and edges, recalculate normals. */
  repair: Schema.Boolean,
  /** Bake color, roughness, metalness, normal and AO from the parent onto the low poly. */
  bake: Schema.Boolean,
  /** Extra levels of detail as fractions of the low poly's triangles, e.g. [0.5, 0.25]. */
  lods: Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0.05, maximum: 0.95 }))).check(
    Schema.isMaxLength(3),
  ),
  collision: Schema.Literals(["none", "box", "convex"]),
  /** Base colour source when baking: the parent's materials, or the three-view reference. */
  texture: Schema.optional(Schema.Literals(["bake", "projection"])),
  /** Procedural presets per parent material, applied before baking. */
  materials: Schema.optional(
    Schema.Array(
      Schema.Struct({
        materialId: Schema.String.check(Schema.isMaxLength(128)),
        /** A procedural preset, or "tiled" for one of the project's seamless textures. */
        preset: Schema.Literals([...GEN3D_MATERIAL_PRESETS, "tiled"]),
        color: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
        tile: Schema.optional(
          Schema.Struct({
            textureId: Gen3DId,
            /** Real-world size of one repeat. */
            metres: Schema.Finite.check(Schema.isBetween({ minimum: 0.02, maximum: 20 })),
            roughness: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
          }),
        ),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
});
export type Gen3DProcess = typeof Gen3DProcess.Type;
export const Gen3DProcessReport = Schema.Struct({
  highTriangles: Schema.Finite,
  lowTriangles: Schema.Finite,
  lods: Schema.Array(Schema.Struct({ file: Schema.String, triangles: Schema.Finite })),
  collision: Schema.NullOr(Schema.Struct({ file: Schema.String, triangles: Schema.Finite })),
  baked: Schema.Array(Schema.String),
  textureSize: Schema.Finite,
  seconds: Schema.Finite,
  /** Share of the low poly's texels painted from the reference, percent. */
  projectedPct: Schema.optional(Schema.Finite),
  /** Parent materials that received a procedural preset. */
  materials: Schema.optional(Schema.Array(Schema.String)),
  /** Set on rigged versions (and versions derived from them): the skinned, animated asset. */
  rig: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["biped", "quadruped", "generic"]),
      bones: Schema.Finite,
      clips: Schema.Array(
        Schema.Struct({
          name: Schema.Literals(GEN3D_ANIMATION_CLIPS),
          seconds: Schema.Finite,
          loop: Schema.Boolean,
        }),
      ),
      /** Separate small parts weighted to the bone nearest their centre. */
      attachments: Schema.Finite,
    }),
  ),
  /** Set on stylized versions. */
  stylize: Schema.optional(
    Schema.Struct({
      style: Schema.Literals(["voxel", "bricks", "lowpoly"]),
      detail: Schema.Finite,
      colors: Schema.Finite,
      voxels: Schema.optional(Schema.Finite),
      studs: Schema.optional(Schema.Finite),
    }),
  ),
  /** Set on repainted versions: what the local repaint changed in the base colour texture. */
  repaint: Schema.optional(
    Schema.Struct({
      view: Schema.Literals(GEN3D_REPAINT_VIEWS),
      maskPixels: Schema.Finite,
      changedTexels: Schema.Finite,
    }),
  ),
});
export type Gen3DProcessReport = typeof Gen3DProcessReport.Type;
export const Gen3DStylize = Schema.Struct({
  style: Schema.Literals(["voxel", "bricks", "lowpoly"]),
  detail: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 6, maximum: 20_000 })),
});
export type Gen3DStylize = typeof Gen3DStylize.Type;
export const Gen3DRepaintView = Schema.Literals(GEN3D_REPAINT_VIEWS);
export type Gen3DRepaintView = typeof Gen3DRepaintView.Type;
export const Gen3DRepaint = Schema.Struct({
  view: Gen3DRepaintView,
  /** Drawing job whose first output is the edit; its input is the view render and its mask the area. */
  imageJobId: Schema.String.check(Schema.isMaxLength(128)),
  imageAssetId: Schema.String.check(Schema.isMaxLength(128)),
  /** The user's instruction, without Aha's prompt template. */
  instruction: Schema.String.check(Schema.isMaxLength(2000)),
  /** Inward soft edge of the mask, in view pixels. */
  feather: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 48 })),
});
export type Gen3DRepaint = typeof Gen3DRepaint.Type;
export const Gen3DBuild = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(GEN3D_LIMITS.sourceBytes)),
  prompt: Schema.String,
  parentVersionId: Schema.NullOr(Gen3DId),
  mode: Schema.optional(Gen3DMode),
  /** Skeleton graph the body is grown from; kept with the version for later rigging. */
  skeleton: Schema.optional(Gen3DSkeleton),
  process: Schema.optional(Gen3DProcess),
  /** Rig the parent from the nearest skeleton in its version chain and add these clips. */
  rig: Schema.optional(
    Schema.Struct({
      clips: Schema.Array(Schema.Literals(GEN3D_ANIMATION_CLIPS)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(GEN3D_ANIMATION_CLIPS.length),
      ),
    }),
  ),
  /** Rebuild the parent as voxels, bricks or flat low poly with colours from its surface. */
  stylize: Schema.optional(Gen3DStylize),
  /** Local repaint of a baked parent: a masked drawing edit of one view, projected back. */
  repaint: Schema.optional(Gen3DRepaint),
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
  runtime: Schema.Struct({
    three: Schema.String,
    blender: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  process: Schema.optional(Gen3DProcessReport),
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
  /** Added with tiled materials; older projects have none. */
  textures: Schema.optional(Schema.Array(Gen3DTexture).check(Schema.isMaxLength(64))),
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
  /** The 3D workshop's Blender runtime, shared with its global Blender lock. */
  blender: Schema.optional(
    Schema.Struct({
      ready: Schema.Boolean,
      version: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      /** Headless Blender for fixed scripts (optimize, convert); needs no MCP runtime. */
      headless: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type Gen3DEnvironment = typeof Gen3DEnvironment.Type;
export const Gen3DCommand = Schema.Struct({
  operation: Schema.Literals([
    "create",
    "update",
    "bind-thread",
    "add-reference",
    "import-reference-asset",
    "import-texture-asset",
    "extract-blueprint",
    "confirm-blueprint",
    "start-run",
    "stop-run",
    "submit",
    "optimize",
    "render-view",
    "repaint",
    "rig",
    "stylize",
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
  process: Schema.optional(Gen3DProcess),
  exportPreset: Schema.optional(Schema.Literals(["generic", "godot", "unity", "unreal"])),
  exportFormat: Schema.optional(Schema.Literals(["glb", "fbx", "obj", "usdz", "stl"])),
  repaintView: Schema.optional(Gen3DRepaintView),
  clips: Schema.optional(Schema.Array(Schema.Literals(GEN3D_ANIMATION_CLIPS))),
  stylize: Schema.optional(Gen3DStylize),
  instruction: Schema.optional(Schema.String),
  feather: Schema.optional(Schema.Finite),
});
export type Gen3DExportFormat = NonNullable<Gen3DCommand["exportFormat"]>;
export type Gen3DCommand = typeof Gen3DCommand.Type;
export const Gen3DCommandResult = Schema.Struct({
  project: Schema.NullOr(Gen3DProject),
  environment: Schema.optional(Gen3DEnvironment),
  exportPath: Schema.optional(Schema.String),
  /** render-view: the view render saved as a drawing asset, ready for mask painting. */
  viewAsset: Schema.optional(ImageAsset),
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
