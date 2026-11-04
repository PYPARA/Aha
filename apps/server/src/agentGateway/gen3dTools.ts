import * as fs from "node:fs/promises";
import { Effect, Schema } from "effect";
import { Gen3DBuild, type Gen3DProject } from "@synara/contracts";
import { modelPath } from "@synara/shared/model3dFiles";
import { GEN3D_RENDERS, gen3DEngine } from "../gen3d/engine";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import type { ToolEntry } from "./toolRuntime";

const genPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const GEN3D_GUIDANCE = `This conversation is bound to Aha's 3D Generation workbench. It builds a game asset that matches a confirmed three-view blueprint (front, side, back silhouettes) by writing Three.js source with an SDF helper. Use the gen3d tool: get at the beginning of EVERY turn; views before deciding what to change; submit to build a candidate; status until the job finishes. Reuse this conversation's configured model; do not install providers, request API keys or use image generation tools. Adoption, export, archive and deletion belong to the workbench and are not agent operations. Never write project files with shell tools. Never claim success from code alone: read the real status, score and views.
Source is a self-contained function buildModel({ THREE, SDF, params }) returning a THREE.Group, with bundled Three.js 0.186.1, metres, Y up, origin at the bottom centre, front facing +Z. No imports, network, files, DOM, lights, cameras or textures. The isolated worker has 60 seconds, 1 MiB source and 1 million triangles.
SDF builds organic or rounded shapes: sphere([x,y,z], r), capsule(a, b, r), cylinder(a, b, r), cappedCone(a, b, r1, r2), roundBox(centre, halfSize, edgeRadius) (axis aligned), ellipsoid(centre, radii), torus(centre, ringRadius, tubeRadius) (around Y), smoothUnion(k, ...shapes), union(...shapes), subtract(a, b), intersect(a, b). SDF.mesh(shape, { id, name, material, resolution }) returns a THREE.Mesh (resolution 16–256, default 128); give each mesh a stable id and a MeshStandardMaterial. Combine SDF meshes with ordinary Three.js meshes for hard-surface parts, and group parts with stable userData.ahaId values. Preserve parts and ids the user did not ask to change.
Scoring: each build renders orthographic silhouettes at the blueprint scale and compares them. views returns the blueprint, diff images (grey = match, orange = model extra, blue = model missing) and renders. The side view may be mirrored in the reference; scoring matches either facing. The total score is a weak signal; the largest deviating region is what stops iteration. Fix the largest regions first and change only what deviates.
Rounds: with an active authorization (get.authorization) you may submit up to its remaining rounds in this turn, reading status and views after each build, and stop early when it reports completed. Without one, submit at most one candidate per user message and then report. Jobs are asynchronous: poll status by jobId instead of resubmitting. Submit requires baseRevision and a unique requestId. Report failures accurately; the previous version is kept.`;

const summary = (project: Gen3DProject) => {
  const current =
    project.versions.find((v) => v.id === project.previewVersionId) ??
    project.versions.at(-1) ??
    null;
  const authorization =
    project.runs.find((r) => r.status === "active") ?? project.runs.at(-1) ?? null;
  return {
    projectId: project.id,
    name: project.name,
    description: project.description,
    baseRevision: project.revision,
    triangleBudget: project.triangleBudget,
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
      score: current.score,
      triangles: current.report.triangles,
      dimensions: current.report.dimensions,
      topology: current.topology,
      warnings: current.report.warnings,
      source: current.build.source,
    },
    versions: project.versions.map((v) => ({
      id: v.id,
      name: v.name,
      parentVersionId: v.build.parentVersionId,
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
          "Read the bound 3D generation project, view blueprint/diff/render images, submit Three.js + SDF source as a new candidate, and query real build and score results. Does not adopt, export or delete assets.",
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
          if (args.operation === "get") return mcpToolResultJson(summary(project));
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
