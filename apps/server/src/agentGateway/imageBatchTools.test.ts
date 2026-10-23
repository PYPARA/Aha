import { it, expect, vi } from "vitest";
import { Effect } from "effect";
import type { ImageBatchState } from "@synara/contracts";
import type { ImageBatchEngine } from "../imageBatches/engine";
import { GatewayToolError, type ToolContext } from "./toolRuntime";
import { makeImageBatchTools } from "./imageBatchTools";
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "s",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: "Batch",
  callerSessionKey: "s",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
function fixture() {
  let state: ImageBatchState = {
    id: "batch",
    name: "Batch",
    version: 4,
    threadId: "thread",
    projectId: null,
    brief: "",
    archived: false,
    removed: false,
    createdAt: "",
    updatedAt: "",
    defaults: { providerId: "provider", model: "model", parameters: { n: 2 } },
    tasks: [],
    sources: [],
    proposals: [],
    executions: [],
  };
  const propose = vi.fn(async (input) => ({
    ...state,
    proposals: [
      {
        ...input,
        id: "proposal",
        createdAt: "",
        threadId: "thread",
        turnId: "turn",
        status: "pending",
      },
    ],
  }));
  const engine = {
    repository: {
      forThread: vi.fn(async () => state),
      result: vi.fn(async () => ({ batchId: "foreign" })),
      results: vi.fn(async () => ({ results: [], total: 0, nextCursor: null })),
    },
    propose,
    captureSources: vi.fn(async (_id, _thread, sources) => {
      state = {
        ...state,
        sources: sources.map(({ data: _data, ...source }: Record<string, unknown>) => ({
          ...source,
          path: "/isolated/batch/source",
        })),
      };
      return state;
    }),
    reportSources: vi.fn(async (_id, _thread, _turn, reports) => {
      state = { ...state, sourceReports: reports };
      return state;
    }),
  };
  const reader = {
    list: vi.fn(async () => [
      {
        id: "attachment:sent",
        name: "brief.any",
        source: "attachment" as const,
        messageId: "message",
      },
      {
        id: "attachment:bad",
        name: "missing.pdf",
        source: "attachment" as const,
        messageId: "bad",
      },
    ]),
    read: vi.fn(async (_thread, _turn, id) => {
      if (id !== "attachment:sent") throw new Error("Read failed: missing.pdf");
      return {
        name: "brief.any",
        bytes: new Uint8Array([1]),
        mimeType: "application/octet-stream",
        messageId: "message",
        attachmentId: "sent",
      };
    }),
  };
  return {
    engine,
    propose,
    reader,
    tool: makeImageBatchTools(engine as unknown as ImageBatchEngine, reader)[0]!,
  };
}
it("snapshots sent documents, reports individual failures, proposes without applying or generating", async () => {
  const f = fixture();
  const result = await Effect.runPromise(f.tool.handler({ operation: "get" }, context));
  expect(JSON.stringify(result)).toContain("brief.any");
  expect(JSON.stringify(result)).toContain("missing.pdf");
  expect(f.engine.captureSources).toHaveBeenCalledWith("batch", "thread", expect.any(Array));
  await Effect.runPromise(
    f.tool.handler(
      {
        operation: "propose",
        baseVersion: 4,
        requestId: "request",
        summary: "one task",
        tasks: [{ id: "one", name: "One", prompt: "Generate", enabled: true }],
      },
      context,
    ),
  );
  expect(f.propose).toHaveBeenCalledWith(
    expect.objectContaining({
      baseVersion: 4,
      tasks: [expect.objectContaining({ references: [], sourceIds: [] })],
      warnings: expect.arrayContaining([
        "Unread source: brief.any",
        expect.stringContaining("Read failed: missing.pdf"),
      ]),
    }),
    "thread",
    "turn",
  );
  expect((await f.engine.repository.forThread()).tasks).toEqual([]);
  for (const operation of ["confirm", "apply-proposal", "cancel", "retry"]) {
    const denied = await Effect.runPromise(f.tool.handler({ operation }, context));
    expect(denied.isError).toBe(true);
  }
});
it("requires an active owned conversation and refuses foreign result previews", async () => {
  const f = fixture();
  f.engine.repository.forThread.mockResolvedValueOnce(null as unknown as ImageBatchState);
  expect((await Effect.runPromise(f.tool.handler({ operation: "get" }, context))).isError).toBe(
    true,
  );
  expect(
    (
      await Effect.runPromise(
        f.tool.handler({ operation: "preview", resultId: "foreign" }, context),
      )
    ).isError,
  ).toBe(true);
  const inactive: ToolContext = {
    ...context,
    assertCallerTurnActive: () => Effect.fail(new GatewayToolError("inactive", "inactive")),
  };
  expect((await Effect.runPromise(f.tool.handler({ operation: "get" }, inactive))).isError).toBe(
    true,
  );
});
it("returns the engine's rejection reason so the model can correct a proposal", async () => {
  const f = fixture();
  f.propose.mockRejectedValueOnce(
    new Error("A batch supports at most 500 planned images across enabled tasks."),
  );
  const result = await Effect.runPromise(
    f.tool.handler(
      {
        operation: "propose",
        baseVersion: 4,
        requestId: "too-many",
        tasks: [{ id: "one", name: "One", prompt: "Generate", enabled: true }],
      },
      context,
    ),
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("at most 500 planned images");
  expect(JSON.stringify(result)).not.toContain("Effect.tryPromise");
});
it("passes proposed batch defaults through and fills missing style reference IDs", async () => {
  const f = fixture();
  await Effect.runPromise(
    f.tool.handler(
      {
        operation: "propose",
        baseVersion: 4,
        requestId: "with-style",
        tasks: [{ id: "one", name: "One", prompt: "Generate", enabled: true }],
        defaults: {
          stylePrompt: "Shared prefix",
          styleReferences: [{ assetId: "a".repeat(64) }],
          parameters: { n: 1, quality: "high" },
        },
      },
      context,
    ),
  );
  expect(f.propose).toHaveBeenCalledWith(
    expect.objectContaining({
      defaults: {
        stylePrompt: "Shared prefix",
        styleReferences: [{ id: "style-reference-0", assetId: "a".repeat(64), documentId: null }],
        parameters: { n: 1, quality: "high" },
      },
    }),
    "thread",
    "turn",
  );
});
