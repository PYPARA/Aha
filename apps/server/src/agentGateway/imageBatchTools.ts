import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { ImageBatchProposalInput } from "@synara/contracts";
import type { ImageBatchEngine } from "../imageBatches/engine";
import type { SpriteReferenceReader } from "./spriteReferences";
import type { ToolEntry } from "./toolRuntime";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";

export const IMAGE_BATCH_GUIDANCE = `This conversation belongs to an Aha batch image workbench. Call image_batch get each turn to read the latest draft, defaults, source documents and available image references. Read user attachments with your existing tools; a successfully uploaded file is not proof that its contents were read. Source paths belong to this batch. Report unavailable or unread documents, assumptions and ambiguities in proposal warnings. propose changes only the tasks you send: each sent task is matched by its stable ID and replaces that task (send it complete, keeping fields you are not asked to change); new IDs are added; tasks you do not send stay exactly as they are. To delete tasks, list their IDs in removeTaskIds; never assume leaving a task out deletes it. Every task has id, name, prompt, enabled, references (assetId and documentId:null), sourceIds; optionally output, providerId, model and parameters (n and optional size/quality/outputFormat/background). When the requirements name a delivery file, put its relative path in output (e.g. heroes/ember.png) and keep name a short readable title; output creates subfolders when the user adds results to the Resource Center. Omit overrides to inherit batch defaults. defaults.stylePrompt and defaults.styleReferences are the batch style: they are placed before every task prompt and reference list automatically when the user confirms, so do not repeat the style text or style images inside task prompts or task references. To set them, or the default parameters, include defaults {stylePrompt, styleReferences, parameters} in propose; a present field replaces the current value and parameters must include n. Put a prefix shared by every task in defaults.stylePrompt, not in each prompt. The channel and model stay the user's choice. Never invent asset IDs or source IDs. This batch's saved results (results[].asset.id from get) may be task references: for staged work, have the user generate and adopt a sample first, then propose later tasks that reference the adopted result; tasks have no automatic dependencies. After reading each source with your tools, use image_batch report with sourceId, status read or failed, and a concise message; do not report read merely because a snapshot exists. Use image_batch propose with the current baseVersion and a stable requestId. Proposals only preview changes: ask the user to choose 「应用并检查生成」 (or 「仅应用」) in the workbench, then 「确认生成」. Name workbench controls by these on-screen Chinese labels (also 「检查并生成」, 「生成结果」, 「标记采用」, 「作为任务参考图」, 「加入资源中心」) rather than English names; reply in the user's language. Neither conversation text nor tool calls can authorize a paid image generation, apply a proposal, retry a generation or overwrite an execution. Do not use other image generation tools, imagegen skills or external providers. A batch has no task count limit, but enabled tasks may plan at most 500 images; keep later stages disabled when needed. If propose fails, fix the reported problem and propose again with a new requestId instead of saving the list elsewhere. Keep requirements in separate tasks; never expand a Cartesian product without explicit scope. Image tasks use the selected Drawing model independently of your conversation model. Existing executions and results remain unchanged. Link to the batch workbench returned by get for review.`;

/** Fills reference IDs the model may omit, as task references do. */
const proposalDefaults = (raw: Record<string, unknown>) => ({
  ...raw,
  ...(Array.isArray(raw.styleReferences)
    ? {
        styleReferences: raw.styleReferences.map((r, i) => ({
          id: "style-reference-" + i,
          documentId: null,
          ...r,
        })),
      }
    : {}),
});

export function makeImageBatchTools(
  batches: ImageBatchEngine,
  reader: SpriteReferenceReader,
): ToolEntry[] {
  return [
    {
      definition: {
        name: "image_batch",
        description:
          "Read this conversation's image batch or prepare an editable proposal. get/status/report/propose/preview only. A proposal NEVER applies changes or starts paid image requests. Read get first and preserve stable task IDs and unspecified fields. User applies and confirms in the workbench.",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["get", "status", "propose", "preview", "report"] },
            baseVersion: { type: "integer" },
            requestId: { type: "string" },
            cursor: { type: "string" },
            taskId: { type: "string" },
            summary: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  prompt: { type: "string" },
                  enabled: { type: "boolean" },
                  output: { type: "string" },
                  providerId: { type: "string" },
                  model: { type: "string" },
                  parameters: { type: "object" },
                  references: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        assetId: { type: "string" },
                        documentId: { type: ["string", "null"] },
                      },
                      required: ["assetId"],
                    },
                  },
                  sourceIds: { type: "array", items: { type: "string" } },
                },
                required: ["id", "name", "prompt", "enabled"],
              },
            },
            removeTaskIds: { type: "array", items: { type: "string" } },
            defaults: {
              type: "object",
              properties: {
                stylePrompt: { type: "string" },
                styleReferences: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      assetId: { type: "string" },
                      documentId: { type: ["string", "null"] },
                    },
                    required: ["assetId"],
                  },
                },
                parameters: { type: "object" },
              },
              additionalProperties: false,
            },
            resultId: { type: "string" },
            reports: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sourceId: { type: "string" },
                  status: { type: "string", enum: ["read", "failed", "unread"] },
                  message: { type: "string" },
                },
                required: ["sourceId", "status", "message"],
                additionalProperties: false,
              },
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
          return yield* Effect.tryPromise({
            try: async () => {
              let state = await batches.repository.forThread(context.callerThreadId);
              if (!state || !context.callerTurnId)
                throw new Error("This active conversation is not bound to an image batch.");
              if (args.operation === "get" || args.operation === "propose") {
                const listed = await reader.list(context.callerThreadId, context.callerTurnId);
                const sources = [];
                const failures = [];
                for (const reference of listed) {
                  if (
                    state.sources.some(
                      (s) =>
                        s.attachmentId === reference.id.replace(/^attachment:/, "") &&
                        s.messageId === reference.messageId,
                    )
                  )
                    continue;
                  let file;
                  try {
                    file = await reader.read(
                      context.callerThreadId,
                      context.callerTurnId,
                      reference.id,
                    );
                  } catch (cause) {
                    failures.push({
                      sourceId: reference.id,
                      status: "failed" as const,
                      message:
                        reference.name +
                        ": " +
                        (cause instanceof Error ? cause.message : String(cause)),
                      turnId: context.callerTurnId,
                    });
                    continue;
                  }
                  const id = createHash("sha256")
                    .update(reference.id + ":" + file.messageId)
                    .digest("hex");
                  sources.push({
                    id,
                    name: file.name,
                    mimeType: file.mimeType ?? "application/octet-stream",
                    bytes: file.bytes.length,
                    threadId: context.callerThreadId,
                    messageId: file.messageId ?? "",
                    attachmentId: file.attachmentId ?? reference.id,
                    data: file.bytes,
                  });
                }
                if (sources.length)
                  state = await batches.captureSources(state.id, context.callerThreadId, sources);
                if (failures.length)
                  state = await batches.reportSources(
                    state.id,
                    context.callerThreadId,
                    context.callerTurnId,
                    failures,
                  );
              }
              const location = "/image-batches?batchId=" + state.id;
              if (args.operation === "report") {
                const reports = Schema.decodeUnknownSync(
                  Schema.Array(
                    Schema.Struct({
                      sourceId: Schema.String,
                      status: Schema.Literals(["read", "unread", "failed"]),
                      message: Schema.String.check(Schema.isMaxLength(32000)),
                    }),
                  ),
                )(args.reports);
                state = await batches.reportSources(
                  state.id,
                  context.callerThreadId,
                  context.callerTurnId,
                  reports.map((report) => ({ ...report, turnId: context.callerTurnId! })),
                );
                return mcpToolResultJson({ sourceReports: state.sourceReports, location });
              }
              if (args.operation === "get" || args.operation === "status") {
                const { executions, ...draft } = state;
                const results = await batches.repository.results({
                  batchId: state.id,
                  ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
                  ...(typeof args.taskId === "string" ? { taskId: args.taskId } : {}),
                });
                return mcpToolResultJson({
                  batch: draft,
                  executions: executions.map((e) => ({
                    id: e.id,
                    paused: e.paused,
                    finishedAt: e.finishedAt,
                    attempts: e.attempts,
                  })),
                  location,
                  submitted: false,
                  results,
                });
              }
              if (args.operation === "propose") {
                const tasks = Array.isArray(args.tasks)
                  ? args.tasks.map((raw, index) => {
                      const t = raw as Record<string, unknown>;
                      return {
                        ...t,
                        references: Array.isArray(t.references)
                          ? t.references.map((r, i) => ({
                              id: "reference-" + index + "-" + i,
                              documentId: null,
                              ...r,
                            }))
                          : [],
                        sourceIds: t.sourceIds ?? [],
                      };
                    })
                  : [];
                const unread = state.sources.filter(
                  (source) =>
                    !state.sourceReports?.some(
                      (report) => report.sourceId === source.id && report.status === "read",
                    ),
                );
                const warnings = [
                  ...(Array.isArray(args.warnings) ? args.warnings : []),
                  ...unread.map((source) => "Unread source: " + source.name),
                  ...(state.sourceReports ?? [])
                    .filter((report) => report.status === "failed")
                    .map((report) => report.message),
                ];
                const input = Schema.decodeUnknownSync(ImageBatchProposalInput)({
                  batchId: state.id,
                  baseVersion: args.baseVersion,
                  requestId: args.requestId,
                  summary: args.summary ?? "",
                  warnings,
                  tasks,
                  ...(Array.isArray(args.removeTaskIds) && args.removeTaskIds.length
                    ? { removeTaskIds: args.removeTaskIds }
                    : {}),
                  ...(args.defaults && typeof args.defaults === "object"
                    ? { defaults: proposalDefaults(args.defaults as Record<string, unknown>) }
                    : {}),
                });
                const updated = await batches.propose(
                  input,
                  context.callerThreadId,
                  context.callerTurnId,
                );
                return mcpToolResultJson({
                  proposal: updated.proposals.find((p) => p.requestId === input.requestId),
                  location,
                  submitted: false,
                  applied: false,
                });
              }
              if (args.operation === "preview") {
                const result = await batches.repository.result(String(args.resultId));
                if (result.batchId !== state.id)
                  throw new Error("Result belongs to another batch.");
                const bytes = await batches.images.assets.read(result.asset, "thumbnail");
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        id: result.id,
                        task: result.taskName,
                        adopted: result.adopted,
                      }),
                    },
                    {
                      type: "image" as const,
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: "image/webp",
                    },
                  ],
                };
              }
              throw new Error("Unknown batch operation.");
            },
            // Keep the real cause: the model can only fix a rejected proposal it can read.
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                mcpToolResultError(error instanceof Error ? error.message : String(error)),
              ),
            ),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(String(error))))),
    },
  ];
}
