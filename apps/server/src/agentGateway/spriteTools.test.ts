import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SpriteContext } from "@synara/contracts";
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
  const state = { context: project, runs: [] };
  const spriteCommand = vi.fn(() => Effect.succeed(state));
  const service = {
    spriteCommand,
    spriteForThread: vi.fn(() => Effect.succeed(bound ? state : null)),
    readAsset: () => Effect.succeed(new Uint8Array()),
  };
  return { service, tool: makeSpriteTools(service)[0]! };
}
it("scopes calls to the bound workbench and exposes no credential fields", async () => {
  const { tool, service } = fixture();
  const result = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  expect(service.spriteForThread).toHaveBeenCalledWith("thread");
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
  };
  await Effect.runPromise(tool.handler(args, context));
  await Effect.runPromise(tool.handler(args, context));
  expect(service.spriteCommand.mock.calls[0]).toEqual(service.spriteCommand.mock.calls[1]);
  expect(
    (await Effect.runPromise(tool.handler({ ...args, frameCount: 999 }, context))).isError,
  ).toBe(true);
  expect(service.spriteCommand).toHaveBeenCalledTimes(2);
});
