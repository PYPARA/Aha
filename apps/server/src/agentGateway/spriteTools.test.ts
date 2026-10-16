import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SpriteContext, SpriteRun } from "@synara/contracts";
import { makeSpriteTools } from "./spriteTools";
import type { ToolContext } from "./toolRuntime";
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: "Sprite",
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
const project: SpriteContext = {
  projectId: "sprite",
  threadId: "thread",
  name: "Fox",
  providerId: "provider",
  model: "model",
  referenceAssetId: "ref",
  action: "idle",
  frameCount: 8,
  fps: 12,
  width: 128,
  height: 128,
  background: "chroma",
  chromaKey: "#00ff00",
};
function fixture(bound = true) {
  const state = { context: project, runs: [] as SpriteRun[] };
  const spriteCommand = vi.fn((_input: import("@synara/contracts").SpriteCommand) =>
    Effect.succeed(state),
  );
  const service = {
    spriteCommand,
    spritePropose: spriteCommand,
    spriteForThread: vi.fn(() => Effect.succeed(bound ? state : null)),
    upload: vi.fn(() =>
      Effect.succeed({
        id: "uploaded",
        name: "fox.png",
        mimeType: "image/png" as const,
        url: "/asset",
        thumbnailUrl: "/thumb",
        width: 8,
        height: 8,
        bytes: 1,
        createdAt: "2026-10-14T00:00:00.000Z",
      }),
    ),
    readAsset: () => Effect.succeed(new Uint8Array()),
  };
  return {
    service,
    tool: makeSpriteTools(service, {
      list: async () => [{ id: "attachment:sent", name: "fox.png", source: "attachment" }],
      read: async (_thread, _turn, id) => {
        if (id !== "attachment:sent") throw new Error("foreign image");
        return { name: "fox.png", bytes: new Uint8Array([1]) };
      },
    })[0]!,
  };
}
it("scopes calls to the bound workbench and exposes no credential fields", async () => {
  const { tool, service } = fixture();
  const result = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  expect(service.spriteForThread).toHaveBeenCalledWith("thread", "turn");
  expect(service.spriteCommand).toHaveBeenCalledWith({ operation: "get", projectId: "sprite" });
  expect(JSON.stringify(result)).not.toMatch(/apiKey/);
});
it("rejects unbound conversations", async () => {
  const { tool, service } = fixture(false);
  expect(
    (
      await Effect.runPromise(
        tool.handler({ operation: "generate", kind: "character", prompt: "fox" }, context),
      )
    ).isError,
  ).toBe(true);
  expect(service.spriteCommand).not.toHaveBeenCalled();
});
it("uses stable generation request ids on a replay and validates frame counts", async () => {
  const { tool, service } = fixture();
  const args = {
    operation: "generate",
    kind: "animation",
    prompt: "walk",
    action: "walk",
    fps: 8,
    frameCount: 4,
    referenceId: "attachment:sent",
  };
  await Effect.runPromise(tool.handler(args, context));
  await Effect.runPromise(tool.handler(args, context));
  const proposals = service.spriteCommand.mock.calls.filter(
    ([command]) => (command as { operation: string }).operation === "propose",
  );
  expect(proposals[0]).toEqual(proposals[1]);
  expect(
    (await Effect.runPromise(tool.handler({ ...args, frameCount: 999 }, context))).isError,
  ).toBe(true);
  expect(proposals).toHaveLength(2);
});

it("requires a conversation reference and uploads the selected attachment to Drawing", async () => {
  const { tool, service } = fixture();
  const args = { operation: "generate", kind: "animation", prompt: "walk" };
  expect((await Effect.runPromise(tool.handler(args, context))).isError).not.toBe(true);
  expect(
    (await Effect.runPromise(tool.handler({ ...args, referenceId: "attachment:foreign" }, context)))
      .isError,
  ).toBe(true);
  await Effect.runPromise(tool.handler({ ...args, referenceId: "attachment:sent" }, context));
  expect(service.upload).toHaveBeenCalled();
  expect(service.spriteCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "propose",
      configuration: expect.objectContaining({
        references: [
          expect.objectContaining({
            referenceId: "attachment:sent",
            asset: expect.objectContaining({ id: "uploaded" }),
          }),
        ],
      }),
    }),
  );
});

it("lists and accepts only candidate images from the calling conversation", async () => {
  const { service } = fixture();
  const asset = {
    id: "image",
    name: "fox.png",
    mimeType: "image/png" as const,
    url: "/image",
    thumbnailUrl: "/thumb",
    width: 8,
    height: 8,
    bytes: 1,
    createdAt: new Date().toISOString(),
  };
  const run: SpriteRun = {
    id: "own",
    context: project,
    input: { kind: "character", requestId: "r", prompt: "fox" },
    jobId: null,
    status: "ready",
    source: asset,
    frames: [],
    warnings: [],
    error: null,
    createdAt: asset.createdAt,
  };
  const state = {
    context: project,
    runs: [run, { ...run, id: "foreign", context: { ...project, threadId: "other-thread" } }],
  };
  service.spriteForThread.mockReturnValue(Effect.succeed(state));
  service.spriteCommand.mockReturnValue(Effect.succeed(state));
  const tool = makeSpriteTools(service)[0]!;
  const result = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  const data = JSON.parse((result.content[0] as { text: string }).text);
  expect(data.references.map((r: { id: string }) => r.id)).toEqual(["candidate:own:image"]);
  expect(
    (await Effect.runPromise(tool.handler({ operation: "preview", runId: "foreign" }, context)))
      .isError,
  ).toBe(true);
  expect(
    (
      await Effect.runPromise(
        tool.handler(
          {
            operation: "generate",
            kind: "animation",
            prompt: "walk",
            referenceId: "candidate:foreign:image",
          },
          context,
        ),
      )
    ).isError,
  ).toBe(true);
  await Effect.runPromise(
    tool.handler(
      {
        operation: "generate",
        kind: "animation",
        prompt: "walk",
        referenceId: "candidate:own:image",
      },
      context,
    ),
  );
  expect(service.upload).not.toHaveBeenCalled();
  expect(service.spriteCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        references: [expect.objectContaining({ asset: expect.objectContaining({ id: "image" }) })],
      }),
    }),
  );
});

it("does not read message references for an unreferenced character or cancel/retry/preview", async () => {
  const { service } = fixture();
  const list = vi.fn(async () => {
    throw new Error("The active turn message is unavailable.");
  });
  const tool = makeSpriteTools(service, { list, read: vi.fn() })[0]!;
  const result = await Effect.runPromise(
    tool.handler({ operation: "generate", kind: "character", prompt: "fox" }, context),
  );
  expect(result.isError).not.toBe(true);
  expect(service.spriteCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        providerId: "provider",
        model: "model",
        referenceAssetId: null,
      }),
    }),
  );
  for (const operation of ["cancel", "retry", "preview", "status"])
    await Effect.runPromise(tool.handler({ operation, runId: "missing" }, context));
  expect(list).not.toHaveBeenCalled();
  const failed = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  const data = JSON.parse((failed.content[0] as { text: string }).text);
  expect(data.error).toEqual(
    expect.objectContaining({
      phase: "reference",
      code: "SPRITE_REFERENCE_FAILED",
      retryable: true,
      submitted: false,
      message: "The active turn message is unavailable.",
    }),
  );
  expect(JSON.stringify(failed)).not.toContain("Effect.tryPromise");
});

it("prepares a draft and never exposes a confirmation operation to the model", async () => {
  const { tool, service } = fixture();
  const result = await Effect.runPromise(
    tool.handler({ operation: "generate", kind: "character", prompt: "fox" }, context),
  );
  expect(result.isError).not.toBe(true);
  expect(service.spritePropose).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "propose" }),
  );
  expect((await Effect.runPromise(tool.handler({ operation: "confirm" }, context))).isError).toBe(
    true,
  );
  expect(JSON.stringify(tool.definition.inputSchema)).not.toContain('"confirm"');
});
