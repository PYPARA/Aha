import { z } from "zod";

export const SpriteId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const text = z.string().max(16000);
const pixel = z.number().int().min(1).max(4096);
const ProjectSchema = z
  .object({
    version: z.literal(1),
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
          usage: z.enum(["material", "generated-frame"]).optional(),
          origin: z.object({runId: SpriteId, candidateId: SpriteId, processingVersionId: SpriteId.optional()}).optional(),
        }),
      )
      .max(1024),
    actions: z
      .array(
        z.object({
          id: SpriteId,
          name: text,
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
              }),
            )
            .max(1024),
        }),
      )
      .min(1)
      .max(1024),
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
    provenance: z.array(
      z.object({
        runId: SpriteId,
        prompt: text,
        action: text,
        actionId: SpriteId.optional(),
        candidateId: SpriteId.optional(),
        localActionId: SpriteId.optional(),
        processingVersionId: SpriteId.optional(),
        planId: SpriteId.optional(),
        model: text,
        providerId: text,
      }),
    ),
  })
  .superRefine((p, ctx) => {
    const sources = new Map(p.sources.map((s) => [s.id, s]));
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
    for (const a of p.actions)
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
