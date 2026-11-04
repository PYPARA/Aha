import * as fs from "node:fs/promises";
import { Effect, Schema } from "effect";
import { Gen3DBuild, type Gen3DEnvironment, type Gen3DProject } from "@synara/contracts";
import { modelPath } from "@synara/shared/model3dFiles";
import { GEN3D_RENDERS, gen3DEngine } from "../gen3d/engine";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import type { ToolEntry } from "./toolRuntime";

const genPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const GEN3D_GUIDANCE = `This conversation is bound to Aha's 3D Generation workbench. It builds a game asset that matches a confirmed three-view blueprint (front, side, back silhouettes) by writing Three.js source with an SDF helper, or Blender Python. Use the gen3d tool: get at the beginning of EVERY turn; views before deciding what to change; submit to build a candidate; status until the job finishes. Reuse this conversation's configured model; do not install providers, request API keys or use image generation tools. Adoption, export, archive and deletion belong to the workbench and are not agent operations. Never write project files with shell tools. Never claim success from code alone: read the real status, score and views.
Two routes, chosen per build with build.mode. "threejs" (default) suits most assets and is fastest. "blender" suits shapes that need modifiers (Skin, Subdivision, Bevel, Boolean, Mirror, Solidify, Array); use it only when get.routes.blender.ready is true.
Three.js route: source is a self-contained function buildModel({ THREE, SDF, params }) returning a THREE.Group, with bundled Three.js 0.186.1, metres, Y up, origin at the bottom centre, front facing +Z. No imports, network, files, DOM, lights, cameras or textures. The isolated worker has 60 seconds, 1 MiB source and 1 million triangles.
SDF builds organic or rounded shapes: sphere([x,y,z], r), capsule(a, b, r), cylinder(a, b, r), cappedCone(a, b, r1, r2), roundCone(a, b, r1, r2) (rounded ends), skeleton(nodes, { blend }), roundBox(centre, halfSize, edgeRadius) (axis aligned), ellipsoid(centre, radii), torus(centre, ringRadius, tubeRadius) (around Y), smoothUnion(k, ...shapes), union(...shapes), subtract(a, b), intersect(a, b). SDF.mesh(shape, { id, name, material, resolution }) returns a THREE.Mesh (resolution 16–256, default 128); give each mesh a stable id and a MeshStandardMaterial. Combine SDF meshes with ordinary Three.js meshes for hard-surface parts, and group parts with stable userData.ahaId values. Preserve parts and ids the user did not ask to change.
Blender route: source is Blender Python (bpy) run in Aha's dedicated Blender instance, which can take a minute to start. Every build starts from an empty scene, so always send the full source. Blender is Z up in metres and front faces -Y; the fixed export converts to glTF Y up, applies modifiers and centres the base. Use Principled BSDF materials only (no texture nodes). Helpers already defined: params; aha_skeleton (build.skeleton or None); aha_point([x,y,z]) converts an Aha Y-up point to Blender; aha_skin(skeleton=None, name='Body', subdivisions=2, material=None) grows a Skin + Subdivision body whose radii match the nodes and that ends at leaf joints; aha_material(name, '#rrggbb', roughness=0.6, metallic=0.0). Aha's policy rejects file and path operations, import/export operators, bpy.ops.wm, getattr/setattr/vars and dunder names. The shared Blender lock also serves the 3D workshop, so a build may wait for it.
Skeletons: for characters, creatures, trees and tentacles, send build.skeleton as nodes { id, parent (null for the root), position [x,y,z] in metres Y up (the published model frame), radius } (up to 256), and grow the body from it with SDF.skeleton(params.skeleton) or aha_skin(). SDF.skeleton rounds every joint with its radius, so its leaf tips reach one radius beyond the leaf joint. Use rig-friendly ids (hips, spine, chest, neck, head, upperarm_l, forearm_l, hand_l, thigh_l, shin_l, foot_l, tail_1...). The skeleton is saved with the version for later rigging; keep it consistent with the body.
Scoring: each build renders orthographic silhouettes at the blueprint scale and compares them. views returns the blueprint, diff images (grey = match, orange = model extra, blue = model missing) and renders. The side view may be mirrored in the reference; scoring matches either facing. The total score is a weak signal; the largest deviating region is what stops iteration. Fix the largest regions first and change only what deviates.
Optimized versions (mode "process") are made by the workbench's fixed Blender pipeline (decimation, UV, baked textures, LODs, collision), and the user may locally repaint their baked texture from a view with a mask and the drawing channel; never submit either kind, and a new modeling build drops those texture edits. get.current is always a modeling version you can continue from, and get.optimizedPreview tells you when the user is viewing an optimized one.
Rounds: with an active authorization (get.authorization) you may submit up to its remaining rounds in this turn, reading status and views after each build, and stop early when it reports completed. Without one, submit at most one candidate per user message and then report. Jobs are asynchronous: poll status by jobId instead of resubmitting. Submit requires baseRevision and a unique requestId. Report failures accurately; the previous version is kept.`;

const summary = (project: Gen3DProject, environment: Gen3DEnvironment) => {
  const previewed =
    project.versions.find((v) => v.id === project.previewVersionId) ??
    project.versions.at(-1) ??
    null;
  // Optimized and repainted versions have no source; the model keeps modeling from the version
  // they came from, however many fixed steps (optimize, repaint) lie in between.
  let current = previewed;
  for (let i = 0; current?.build.mode === "process" && i < project.versions.length; i++)
    current = project.versions.find((v) => v.id === current!.build.parentVersionId) ?? current;
  if (current?.build.mode === "process") current = previewed;
  const authorization =
    project.runs.find((r) => r.status === "active") ?? project.runs.at(-1) ?? null;
  return {
    projectId: project.id,
    name: project.name,
    description: project.description,
    baseRevision: project.revision,
    triangleBudget: project.triangleBudget,
    routes: {
      threejs: { ready: environment.desktop },
      blender: environment.blender ?? { ready: false, version: null, error: environment.error },
    },
    blueprint: project.blueprint && {
      confirmed: project.blueprint.confirmed,
      targetHeightMetres: project.blueprint.targetHeight,
      pxPerMetre: +project.blueprint.pxPerMetre.toFixed(2),
    },
    authorization: authorization && {
      id: authorization.id,
      status: authorization.status,
      maxRounds: authorization.maxRounds,
      usedRounds: authorization.usedRounds,
      remainingRounds:
        authorization.status === "active" ? authorization.maxRounds - authorization.usedRounds : 0,
      stopWhenLargestRegionBelowPct: authorization.stopMaxRegionPct,
      stopReason: authorization.stopReason,
    },
    adoptedVersionId: project.adoptedVersionId,
    current: current && {
      id: current.id,
      name: current.name,
      round: current.round,
      mode: current.build.mode ?? "threejs",
      score: current.score,
      triangles: current.report.triangles,
      dimensions: current.report.dimensions,
      topology: current.topology,
      warnings: current.report.warnings,
      source: current.build.source,
      skeleton: current.build.skeleton ?? null,
    },
    optimizedPreview:
      previewed && previewed !== current
        ? {
            id: previewed.id,
            name: previewed.name,
            fromVersionId: previewed.build.parentVersionId,
            process: previewed.process ?? null,
            repaint: previewed.build.repaint
              ? {
                  view: previewed.build.repaint.view,
                  instruction: previewed.build.repaint.instruction,
                }
              : null,
          }
        : null,
    versions: project.versions.map((v) => ({
      id: v.id,
      name: v.name,
      parentVersionId: v.build.parentVersionId,
      mode: v.build.mode ?? "threejs",
      score: v.score?.score ?? null,
      maxRegionPct: v.score?.maxRegionPct ?? null,
    })),
    jobs: project.jobs.slice(-5).map((j) => ({
      id: j.id,
      status: j.status,
      error: j.error,
      versionId: j.versionId,
    })),
    location: "/gen3d?projectId=" + project.id,
    instructions: GEN3D_GUIDANCE,
  };
};

export function makeGen3DTools(): ToolEntry[] {
  return [
    {
      definition: {
        name: "gen3d",
        description:
          "Read the bound 3D generation project, view blueprint/diff/render images, submit Three.js + SDF or Blender Python source (optionally with a skeleton) as a new candidate, and query real build and score results. Does not adopt, export or delete assets.",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["get", "views", "submit", "status", "report"] },
            baseRevision: { type: "integer" },
            requestId: { type: "string" },
            jobId: { type: "string" },
            versionId: { type: "string" },
            build: {
              type: "object",
              properties: {
                source: { type: "string" },
                prompt: { type: "string" },
                parentVersionId: { type: ["string", "null"] },
                mode: { type: "string", enum: ["threejs", "blender"] },
                skeleton: {
                  type: "array",
                  maxItems: 256,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      parent: { type: ["string", "null"] },
                      position: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 3,
                        maxItems: 3,
                      },
                      radius: { type: "number" },
                    },
                    required: ["id", "parent", "position", "radius"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["source", "prompt", "parentVersionId"],
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
          const engine = yield* Effect.promise(gen3DEngine);
          const project = yield* genPromise(() => engine.forThread(context.callerThreadId));
          if (!project || !context.callerTurnId)
            return mcpToolResultError(
              "This active conversation is not bound to a 3D generation project.",
            );
          if (args.operation === "get")
            return mcpToolResultJson(
              summary(project, yield* genPromise(() => engine.environment())),
            );
          if (args.operation === "views") {
            const version =
              project.versions.find((v) => v.id === (args.versionId ?? project.previewVersionId)) ??
              project.versions.at(-1);
            const images: { label: string; file: string }[] = [];
            if (project.blueprint)
              for (const view of ["front", "side", "back"])
                images.push({
                  label: `blueprint ${view}`,
                  file: yield* genPromise(() =>
                    modelPath(engine.root, project.id, "blueprint", view + ".png"),
                  ),
                });
            if (version) {
              const names = [
                ...(version.score ? ["diff-front.png", "diff-side.png", "diff-back.png"] : []),
                ...GEN3D_RENDERS,
              ];
              for (const name of names)
                if (version.files.some((f) => f.name === name))
                  images.push({
                    label: `${version.name} ${name.replace(".png", "")}`,
                    file: yield* genPromise(() =>
                      modelPath(engine.root, project.id, "versions", version.id, name),
                    ),
                  });
            }
            if (!images.length)
              return mcpToolResultError("Nothing to show yet: add a blueprint or build a model.");
            const content: (
              | { type: "text"; text: string }
              | { type: "image"; data: string; mimeType: string }
            )[] = [
              {
                type: "text",
                text: JSON.stringify({
                  version: version
                    ? { id: version.id, name: version.name, score: version.score }
                    : null,
                  images: images.map((i) => i.label),
                }),
              },
            ];
            for (const image of images) {
              const bytes = yield* genPromise(() => fs.readFile(image.file));
              content.push({ type: "text", text: image.label });
              content.push({
                type: "image",
                data: bytes.toString("base64"),
                mimeType: "image/png",
              });
            }
            return { content };
          }
          if (args.operation === "submit") {
            const build = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(Gen3DBuild)(args.build),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            });
            if (typeof args.baseRevision !== "number" || typeof args.requestId !== "string")
              return mcpToolResultError("Provide baseRevision and requestId.");
            yield* context.assertCallerTurnActive();
            const result = yield* genPromise(() =>
              engine.command({
                operation: "submit",
                projectId: project.id,
                revision: args.baseRevision as number,
                requestId: args.requestId as string,
                turnId: context.callerTurnId!,
                build,
              }),
            );
            const job = result.project?.jobs.find((j) => j.requestId === args.requestId);
            return mcpToolResultJson({ job, location: "/gen3d?projectId=" + project.id });
          }
          if (args.operation === "status") {
            const job = args.jobId
              ? project.jobs.find((j) => j.id === args.jobId)
              : project.jobs.at(-1);
            if (!job) return mcpToolResultError("Task not found.");
            const version = job.versionId
              ? project.versions.find((v) => v.id === job.versionId)
              : undefined;
            const authorization = job.runId
              ? project.runs.find((r) => r.id === job.runId)
              : undefined;
            return mcpToolResultJson({
              job: { id: job.id, status: job.status, error: job.error, versionId: job.versionId },
              version: version && {
                id: version.id,
                name: version.name,
                score: version.score,
                triangles: version.report.triangles,
                dimensions: version.report.dimensions,
                topology: version.topology,
                warnings: version.report.warnings,
              },
              authorization: authorization && {
                status: authorization.status,
                usedRounds: authorization.usedRounds,
                maxRounds: authorization.maxRounds,
                stopReason: authorization.stopReason,
              },
            });
          }
          if (args.operation === "report") {
            const version = project.versions.find((v) => v.id === args.versionId);
            return version
              ? mcpToolResultJson({
                  report: version.report,
                  topology: version.topology,
                  score: version.score,
                })
              : mcpToolResultError("Version not found.");
          }
          return mcpToolResultError("Unknown gen3d operation.");
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
