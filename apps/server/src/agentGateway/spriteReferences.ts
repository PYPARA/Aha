import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { Effect, Option } from "effect";
import {
  ThreadId,
  TurnId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatImageAttachment,
  type ChatFileAttachment,
} from "@synara/contracts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments";
import { resolveAttachmentRelativePath } from "../attachmentPaths";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
  resolveAttachmentPath,
} from "../attachmentStore";
import { resolveRealPathWithinRoot } from "../workspace/realPathContainment";

export interface SpriteChatReference {
  id: string;
  name: string;
  source: "attachment" | "candidate";
  messageId?: string;
  mimeType?: string;
  runId?: string;
}
export interface SpriteReferenceReader {
  readSent?: (
    threadId: string,
    messageId: string,
    attachmentId: string,
  ) => Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType?: string;
    messageId?: string;
    attachmentId?: string;
  }>;
  list: (threadId: string, turnId: string) => Promise<SpriteChatReference[]>;
  read: (
    threadId: string,
    turnId: string,
    id: string,
  ) => Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType?: string;
    messageId?: string;
    attachmentId?: string;
  }>;
}
export function makeSpriteReferenceReader(deps: {
  turns: Pick<ProjectionTurnRepositoryShape, "getByTurnId">;
  messages: Pick<ProjectionThreadMessageRepositoryShape, "listByThreadId">;
  attachments?: Pick<ManagedAttachmentRepositoryShape, "findClaimedById"> | undefined;
  attachmentsDir: string;
  includeFiles?: boolean;
}): SpriteReferenceReader {
  async function records(threadId: string, turnId: string) {
    const thread = ThreadId.makeUnsafe(threadId);
    const turn = await Effect.runPromise(
      deps.turns.getByTurnId({ threadId: thread, turnId: TurnId.makeUnsafe(turnId) }),
    );
    if (Option.isNone(turn) || !turn.value.pendingMessageId)
      throw new Error("The active turn is unavailable. Retry after the message is saved.");
    // Use canonical causal order, not the paginated UI transcript or nullable message.turnId.
    const messages = await Effect.runPromise(deps.messages.listByThreadId({ threadId: thread }));
    const current = messages.findIndex(
      (m) => m.role === "user" && m.messageId === turn.value.pendingMessageId,
    );
    if (current < 0)
      throw new Error("The active turn message is unavailable. Retry after the message is saved.");
    // Accepted steering messages carry this turn ID; queued future sends do not.
    // Include those steers without admitting intervening queued messages.
    return messages
      .filter((m, index) => index <= current || m.turnId === turnId)
      .flatMap((m) =>
        (m.attachments ?? [])
          .filter(
            (a): a is ChatImageAttachment | ChatFileAttachment =>
              a.type === "image" || (!!deps.includeFiles && a.type === "file"),
          )
          .map((attachment) => ({ messageId: m.messageId, attachment })),
      );
  }
  async function readRecord(threadId: string, record: Awaited<ReturnType<typeof records>>[number]) {
    const { attachment, messageId } = record;
    let file: string | null;
    let hash: string | null = null;
    if (attachment.id.startsWith("att_v2_")) {
      if (!deps.attachments) throw new Error("Attachment storage is unavailable.");
      const found = await Effect.runPromise(
        deps.attachments.findClaimedById({ attachmentId: attachment.id }),
      );
      if (
        Option.isNone(found) ||
        found.value.ownerThreadId !== threadId ||
        found.value.claimMessageId !== messageId ||
        found.value.kind !== attachment.type ||
        !found.value.sha256
      )
        throw new Error("Reference image is unavailable. Reattach it and retry.");
      file = resolveAttachmentRelativePath({
        attachmentsDir: deps.attachmentsDir,
        relativePath: found.value.relativePath,
      });
      hash = found.value.sha256;
    } else {
      if (
        parseThreadSegmentFromAttachmentId(attachment.id) !==
        toSafeThreadAttachmentSegment(threadId)
      )
        throw new Error("Reference image does not belong to this conversation.");
      file = resolveAttachmentPath({ attachmentsDir: deps.attachmentsDir, attachment });
    }
    const real = file ? await resolveRealPathWithinRoot(deps.attachmentsDir, file) : null;
    if (!real) throw new Error("Reference image is unavailable.");
    const stat = await fs.stat(real);
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size !== attachment.sizeBytes ||
      stat.size >
        (attachment.type === "file"
          ? PROVIDER_SEND_TURN_MAX_FILE_BYTES
          : PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
    )
      throw new Error("Reference image is invalid.");
    const bytes = await fs.readFile(real);
    if (
      bytes.length !== stat.size ||
      (hash && createHash("sha256").update(bytes).digest("hex") !== hash)
    )
      throw new Error("Reference image is corrupted.");
    return {
      bytes,
      name: attachment.name,
      mimeType: attachment.mimeType,
      messageId,
      attachmentId: attachment.id,
    };
  }

  return {
    readSent: async (threadId, messageId, attachmentId) => {
      const messages = await Effect.runPromise(
        deps.messages.listByThreadId({ threadId: ThreadId.makeUnsafe(threadId) }),
      );
      const message = messages.find((message) => message.messageId === messageId);
      const attachment = message?.attachments?.find(
        (a) =>
          a.id === attachmentId &&
          (a.type === "image" || (!!deps.includeFiles && a.type === "file")),
      );
      if (!attachment || (attachment.type !== "image" && attachment.type !== "file"))
        throw new Error("Attachment does not belong to the selected source message.");
      return readRecord(threadId, { messageId: message!.messageId, attachment });
    },
    list: async (threadId, turnId) =>
      (await records(threadId, turnId)).map(({ attachment, messageId }) => ({
        id: `attachment:${attachment.id}`,
        name: attachment.name,
        source: "attachment",
        messageId,
        ...(deps.includeFiles ? { mimeType: attachment.mimeType } : {}),
      })),
    read: async (threadId, turnId, id) => {
      const record = (await records(threadId, turnId)).find(
        (r) => `attachment:${r.attachment.id}` === id,
      );
      if (!record) throw new Error("Reference image does not belong to this conversation.");
      return readRecord(threadId, record);
    },
  };
}
