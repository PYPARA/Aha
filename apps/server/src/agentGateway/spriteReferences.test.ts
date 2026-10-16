import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { Effect, Option } from "effect";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments";
import { makeSpriteReferenceReader } from "./spriteReferences";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sprite-refs-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const attachment = {
    type: "image",
    id: "att_v2_sent",
    name: "fox.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const messages: Array<{
    messageId: string;
    role: "user";
    turnId: string | null;
    attachments: Array<typeof attachment>;
  }> = [
    { messageId: "past", role: "user", turnId: "old-turn", attachments: [attachment] },
    { messageId: "current", role: "user", turnId: null, attachments: [] },
    {
      messageId: "future",
      role: "user",
      turnId: "future-turn",
      attachments: [{ ...attachment, id: "att_v2_future" }],
    },
  ];
  const found = {
    ownerThreadId: "thread",
    claimMessageId: "past",
    kind: "image",
    sha256: createHash("sha256")
      .update(new Uint8Array([1, 2, 3]))
      .digest("hex"),
    relativePath: "blob.png",
  };
  const repo = { findClaimedById: vi.fn(() => Effect.succeed(Option.some(found))) };
  const reader = makeSpriteReferenceReader({
    turns: {
      getByTurnId: ({ turnId }: { turnId: string }) =>
        Effect.succeed(
          turnId === "turn" ? Option.some({ pendingMessageId: "current" }) : Option.none(),
        ),
    } as unknown as ProjectionTurnRepositoryShape,
    messages: {
      listByThreadId: () => Effect.succeed(messages),
    } as unknown as ProjectionThreadMessageRepositoryShape,
    attachments: repo as unknown as ManagedAttachmentRepositoryShape,
    attachmentsDir: root,
  });
  return { reader, repo, found, messages };
}
it("lists only images in sent messages through the calling turn, retaining historical references", async () => {
  const { reader } = fixture();
  expect(await reader.list("thread", "turn")).toEqual([
    { id: "attachment:att_v2_sent", name: "fox.png", source: "attachment", messageId: "past" },
  ]);
  await expect(reader.read("thread", "turn", "attachment:att_v2_future")).rejects.toThrow("belong");
  await expect(reader.list("thread", "missing-turn")).rejects.toThrow("active turn");
});
it("validates ownership, claim, hash and path before reading a chat reference", async () => {
  const { reader, repo, found } = fixture();
  await fs.writeFile(path.join(root, "blob.png"), new Uint8Array([1, 2, 3]));
  expect([...(await reader.read("thread", "turn", "attachment:att_v2_sent")).bytes]).toEqual([
    1, 2, 3,
  ]);
  repo.findClaimedById.mockReturnValueOnce(
    Effect.succeed(Option.some({ ...found, ownerThreadId: "another" })),
  );
  await expect(reader.read("thread", "turn", "attachment:att_v2_sent")).rejects.toThrow(
    "unavailable",
  );
  repo.findClaimedById.mockReturnValueOnce(
    Effect.succeed(Option.some({ ...found, relativePath: "../outside.png" })),
  );
  await expect(reader.read("thread", "turn", "attachment:att_v2_sent")).rejects.toThrow();
  await fs.writeFile(path.join(root, "blob.png"), new Uint8Array([4, 5, 6]));
  await expect(reader.read("thread", "turn", "attachment:att_v2_sent")).rejects.toThrow(
    "corrupted",
  );
});

it("includes current null-turn attachments and accepted steering without admitting queued images", async () => {
  const { reader, messages } = fixture();
  messages[1]!.attachments.push({ ...messages[0]!.attachments[0]!, id: "att_v2_current" });
  messages.push({
    messageId: "steer",
    role: "user",
    turnId: "turn",
    attachments: [{ ...messages[0]!.attachments[0]!, id: "att_v2_steer" }],
  });
  expect((await reader.list("thread", "turn")).map((image) => image.id)).toEqual([
    "attachment:att_v2_sent",
    "attachment:att_v2_current",
    "attachment:att_v2_steer",
  ]);
  messages.splice(1, 1);
  await expect(reader.list("thread", "turn")).rejects.toThrow("active turn message");
});
