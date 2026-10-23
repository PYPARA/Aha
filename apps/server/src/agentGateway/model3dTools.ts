import { Effect, Schema } from "effect";
import { Model3DBuild } from "@synara/contracts";
import { model3DEngine } from "../model3d/engine";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import type { ToolEntry } from "./toolRuntime";

const modelPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const MODEL3D_GUIDANCE = `This conversation is bound to Aha's 3D Workshop. Use the model3d tool: get at the beginning of EVERY modeling turn, then submit to build a new candidate directly. Reuse this conversation's configured model; do not install providers or request API keys. The user has authorized ordinary modeling iterations. Do not ask for repetitive confirmation. Adoption, export, archive and deletion belong to explicit workbench controls and are not agent operations. Never write canonical model files with shell tools. Read actual job status and validation after submitting; never claim success from code alone. Use stable userData.ahaId identifiers for Three.js parts and materials; Blender custom properties ahaId for objects/materials. Preserve unrequested parts, parameters and materials.
Three.js: source is a self-contained function buildModel({ THREE, params }) returning THREE.Group, using bundled Three.js 0.186.1. No imports, network, files, DOM, lights, cameras, sprites or external packages. Use MeshStandardMaterial, finite BufferGeometry/primitives, curves/extrusions/groups. The isolated worker has 30 seconds, 1 MiB source, 100 MiB result and 1 million triangles. Define editable parameterDefinitions (key,label,type,min/max/step as appropriate) and parameters. Default meters, Y-up, bottom center. Suggested budget 5000 triangles, 2K textures. To modify geometry resubmit the complete source and preserve stable IDs. To adjust existing materials without regenerating geometry, send source empty and parentVersionId. Textures are selected/imported in the inspector; refer only to IDs from get. Do not create texture URLs in source.
Blender: Python bpy/bmesh/mathutils and pure Python modules under upstream safe mode. Aha starts its own visible Blender GUI, loads the chosen parent .blend or GLB and executes the submitted source. For a new model start from the empty scene; for a child, modify the existing named parts. Use Principled BSDF with portable PBR nodes. Blender internally uses Z-up/meters; Aha exports Y-up GLB. No OS/process/network access, handlers, timers, drivers or third-party generators. Never read, save, import or export files yourself, or set filepath properties. Aha owns those operations. Aha's fixed publisher saves the checkpoint and GLB. This instance is project isolation, not an operating-system Python sandbox. A Three.js GLB can be a Blender parent; edited Blender meshes cannot recover the original procedural source.
Submit requires baseRevision, a unique stable requestId, and build {mode,source,parameters,parameterDefinitions,parentVersionId,prompt,materialEdits}. Use the selected mode from get unless the user explicitly changes it. Keep GLB bytes out of chat. Jobs are asynchronous: query status by jobId and read the actual report; do not keep resubmitting. Failures retain source and the previous usable version. Report errors accurately and repair the source when the user requests another iteration.`;

export function makeModel3DTools(): ToolEntry[] {
  return [
    {
      definition: {
        name: "model3d",
        description:
          "Read the bound 3D project, submit modeling source as a new candidate, and query actual build/check results. Does not adopt, export or delete assets.",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["get", "submit", "status", "report"] },
            baseRevision: { type: "integer" },
            requestId: { type: "string" },
            jobId: { type: "string" },
            versionId: { type: "string" },
            build: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["threejs", "blender"] },
                source: { type: "string" },
                parameters: {
                  type: "object",
                  additionalProperties: { type: ["number", "string", "boolean"] },
                },
                parameterDefinitions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                      type: { type: "string", enum: ["number", "boolean", "color", "string"] },
                      min: { type: "number" },
                      max: { type: "number" },
                      step: { type: "number" },
                    },
                    required: ["key", "label", "type"],
                  },
                },
                parentVersionId: { type: ["string", "null"] },
                prompt: { type: "string" },
                materialEdits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      materialId: { type: "string" },
                      color: { type: "string" },
                      roughness: { type: "number" },
                      metalness: { type: "number" },
                      opacity: { type: "number" },
                      baseColor: { type: ["string", "null"] },
                      normal: { type: ["string", "null"] },
                      roughnessMap: { type: ["string", "null"] },
                      metalnessMap: { type: ["string", "null"] },
                    },
                    required: ["materialId"],
                  },
                },
              },
              required: [
                "mode",
                "source",
                "parameters",
                "parameterDefinitions",
                "parentVersionId",
                "prompt",
                "materialEdits",
              ],
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const engine = yield* Effect.promise(model3DEngine);
          const project = yield* modelPromise(() => engine.forThread(context.callerThreadId));
          if (!project || !context.callerTurnId)
            return mcpToolResultError("This active conversation is not bound to a 3D project.");
          if (args.operation === "get")
            return mcpToolResultJson({
              projectId: project.id,
              name: project.name,
              baseRevision: project.revision,
              mode: project.mode,
              budgets: { triangles: project.triangleBudget, texture: project.textureBudget },
              adoptedVersionId: project.adoptedVersionId,
              current:
                project.versions.find((v) => v.id === project.previewVersionId) ??
                project.versions.at(-1) ??
                null,
              textures: project.textures,
              versions: project.versions.map((v) => ({
                id: v.id,
                name: v.name,
                mode: v.build.mode,
                parentVersionId: v.build.parentVersionId,
                hasBlend: v.hasBlend,
              })),
              jobs: project.jobs.slice(-5),
              location: "/model3d?projectId=" + project.id,
              instructions: MODEL3D_GUIDANCE,
            });
          if (args.operation === "submit") {
            const build = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(Model3DBuild)(args.build),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            });
            if (build.mode !== project.mode)
              return mcpToolResultError(
                "The workbench mode changed. Read get and use its selected mode.",
              );
            if (typeof args.baseRevision !== "number" || typeof args.requestId !== "string")
              return mcpToolResultError("Provide baseRevision and requestId.");
            yield* context.assertCallerTurnActive();
            const result = yield* modelPromise(() =>
              engine.command({
                operation: "submit",
                projectId: project.id,
                revision: args.baseRevision as number,
                requestId: args.requestId as string,
                build,
              }),
            );
            return mcpToolResultJson({
              job: result.project?.jobs.find((j) => j.requestId === args.requestId),
              location: "/model3d?projectId=" + project.id,
            });
          }
          if (args.operation === "status")
            return mcpToolResultJson(
              args.jobId
                ? (project.jobs.find((j) => j.id === args.jobId) ?? { error: "Task not found" })
                : project.jobs.slice(-5),
            );
          if (args.operation === "report")
            return mcpToolResultJson(
              project.versions.find((v) => v.id === args.versionId)?.report ?? {
                error: "Version not found",
              },
            );
          return mcpToolResultError("Unknown model3d operation.");
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              mcpToolResultError(error instanceof Error ? error.message : String(error)),
            ),
          ),
        ),
    },
  ];
}
