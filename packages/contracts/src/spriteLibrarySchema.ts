import { z } from "zod";
import { Schema } from "effect";
import {
  SpriteRenderSpec,
  SpriteCanonicalReference,
  SpriteTaskSnapshot,
  SpriteProcessingSnapshot,
} from "./spriteAnimation";
import { spriteOutputSize } from "./spriteWorkflow";
const RenderSpecSchema = z.unknown().transform((v, ctx) => {
  try {
    const value = Schema.decodeUnknownSync(SpriteRenderSpec)(v);
    spriteOutputSize(value);
    return value;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid sprite render specification." });
    return z.NEVER;
  }
});
const CanonicalSchema = z.unknown().transform((v, ctx) => {
  try {
    return Schema.decodeUnknownSync(SpriteCanonicalReference)(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid character reference." });
    return z.NEVER;
  }
});
const TaskSnapshotSchema = z.unknown().transform((v, ctx) => {
  try {
    return Schema.decodeUnknownSync(SpriteTaskSnapshot)(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid sprite task snapshot." });
    return z.NEVER;
  }
});

export const SpriteId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const text = z.string().max(16000);
const pixel = z.number().int().min(1).max(4096);
const ActionSchema = z.object({
  id: SpriteId,
  name: text,
  description: text.optional(),
  plannedFrameCount: z.number().int().min(1).max(32).optional(),
  fps: z.number().min(1).max(60),
  loop: z.boolean(),
  frames: z
    .array(
      z.object({
        id: SpriteId,
        sourceId: SpriteId,
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: pixel,
        height: pixel,
        offsetX: z.number().int(),
        offsetY: z.number().int(),
        durationMs: z.number().finite().positive().optional(),
      }),
    )
    .max(1024),
});
const ProcessingSnapshotSchema = z.unknown().transform((v, ctx) => {
  try {
    return Schema.decodeUnknownSync(SpriteProcessingSnapshot)(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid sprite processing snapshot." });
    return z.NEVER;
  }
});
const ProvenanceSchema = z.object({
  runId: SpriteId,
  segmentRunIds: z.array(SpriteId).max(4).optional(),
  taskSnapshots: z.array(TaskSnapshotSchema).max(4).optional(),
  processingSnapshots: z.array(ProcessingSnapshotSchema).max(4).optional(),
  prompt: text,
  action: text,
  actionId: SpriteId.optional(),
  candidateId: SpriteId.optional(),
  localActionId: SpriteId.optional(),
  processingVersionId: SpriteId.optional(),
  planId: SpriteId.optional(),
  model: text,
  providerId: text,
});
const ProjectSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    renderSpec: RenderSpecSchema.optional(),
    canonical: CanonicalSchema.optional(),
    canonicalVersions: z.array(CanonicalSchema).optional(),
    id: SpriteId,
    name: z.string().trim().min(1).max(200),
    updatedAt: z.iso.datetime(),
    width: pixel,
    height: pixel,
    sources: z
      .array(
        z.object({
          id: SpriteId,
          name: text,
          width: pixel,
          height: pixel,
          file: z.string().regex(/^images\/[a-f0-9]{64}\.(png|jpg|webp)$/),
          mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          assetId: SpriteId.optional(),
          masterSourceId: SpriteId.optional(),
          usage: z.enum(["material", "generated-frame", "generated-master"]).optional(),
          origin: z
            .object({
              runId: SpriteId,
              candidateId: SpriteId,
              processingVersionId: SpriteId.optional(),
            })
            .optional(),
        }),
      )
      .max(1024),
    actions: z.array(ActionSchema).min(1).max(1024),
    selectedActionId: SpriteId,
    threadIds: z.array(SpriteId).max(1024).default([]),
    activeThreadId: SpriteId.nullable().default(null),
    providerId: text,
    model: text,
    referenceSourceId: SpriteId.nullable(),
    background: z.enum(["chroma", "transparent"]),
    chromaKey: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    generationFrameCount: z.number().int().min(1).max(32),
    adoptedCandidateIds: z.array(
      z.string().regex(/^[a-zA-Z0-9_-]{1,128}(?::[a-zA-Z0-9_-]{1,128}){0,2}$/),
    ),
    provenance: z.array(ProvenanceSchema),
    actionVersions: z
      .array(
        z.object({
          id: SpriteId,
          createdAt: z.iso.datetime(),
          action: ActionSchema,
          width: pixel,
          height: pixel,
          renderSpec: RenderSpecSchema.optional(),
          canonical: CanonicalSchema.optional(),
          provenance: z.array(ProvenanceSchema),
        }),
      )
      .max(1024)
      .optional(),
    lastExport: z
      .object({
        createdAt: z.iso.datetime(),
        actionIds: z.array(SpriteId).max(1024),
        actionVersionIds: z.array(SpriteId).max(1024).optional(),
        outputScale: pixel.optional(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.enum(["combined", "atlas", "sequence"]),
        columns: z.number().int().min(1).max(64),
        gap: z.number().int().min(0).max(128),
        files: z.array(z.string().max(512)).max(32768),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (
      p.version === 2 &&
      (!p.renderSpec ||
        p.width !== spriteOutputSize(p.renderSpec).width ||
        p.height !== spriteOutputSize(p.renderSpec).height)
    )
      ctx.addIssue({
        code: "custom",
        message: "Output dimensions do not match the render specification.",
      });
    const sources = new Map(p.sources.map((s) => [s.id, s]));
    if (p.sources.some((s) => s.masterSourceId && !sources.has(s.masterSourceId)))
      ctx.addIssue({ code: "custom", message: "Missing sprite logical master." });
    if (
      sources.size !== p.sources.length ||
      new Set(p.actions.map((a) => a.id)).size !== p.actions.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate sprite identifiers." });
    if (
      !p.actions.some((a) => a.id === p.selectedActionId) ||
      (p.referenceSourceId && !sources.has(p.referenceSourceId))
    )
      ctx.addIssue({ code: "custom", message: "Invalid sprite selection." });
    for (const a of [...p.actions, ...(p.actionVersions ?? []).map((v) => v.action)])
      for (const f of a.frames) {
        const s = sources.get(f.sourceId);
        if (!s || f.x + f.width > s.width || f.y + f.height > s.height)
          ctx.addIssue({ code: "custom", message: "Frame is outside its source image." });
      }
  });
export const SpriteProjectDataSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const { threadId, ...data } = raw as Record<string, unknown>;
    const ids = data.threadIds ?? (typeof threadId === "string" ? [threadId] : []);
    return {
      ...data,
      threadIds: ids,
      activeThreadId: data.activeThreadId ?? (typeof threadId === "string" ? threadId : null),
    };
  },
  ProjectSchema.superRefine((p, ctx) => {
    if (
      new Set(p.threadIds).size !== p.threadIds.length ||
      (p.activeThreadId && !p.threadIds.includes(p.activeThreadId))
    )
      ctx.addIssue({ code: "custom", message: "Invalid sprite conversation selection." });
  }),
);
export type SpriteProjectData = z.infer<typeof SpriteProjectDataSchema>;
export const SpriteActionVersionsSchema = ProjectSchema.shape.actionVersions;
export const SpriteExportRecordSchema = ProjectSchema.shape.lastExport;
