// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntimeError,
  type OpenCodeCliModelDescriptor,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
// The shared guard throws synchronously, so the tagged adapter error can arrive
// as either a typed failure or a defect. Read the tag from the squashed cause.
function failureTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const squashed: unknown = Cause.squash(exit.cause);
  return squashed !== null &&
    typeof squashed === "object" &&
    "_tag" in squashed &&
    typeof (
      squashed as {
        readonly _tag?: unknown;
      }
    )._tag === "string"
    ? (
        squashed as {
          readonly _tag: string;
        }
      )._tag
    : undefined;
}
function createMockOpenCodeRuntime(options?: {
  readonly inventory?: OpenCodeInventory;
  readonly inventoryError?: OpenCodeRuntimeError;
  readonly connectError?: OpenCodeRuntimeError;
  readonly cliModelsError?: OpenCodeRuntimeError;
  readonly cliModels?: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly events?: AsyncIterable<unknown>;
  readonly eventSubscriptions?: ReadonlyArray<AsyncIterable<unknown>>;
  readonly prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly commandList?: () => Promise<{
    data?: ReadonlyArray<{
      name: string;
      description?: string;
    }>;
  }>;
  readonly commandLists?: ReadonlyArray<
    ReadonlyArray<{
      name: string;
      description?: string;
    }>
  >;
  readonly messages?: () => Promise<{
    data: Array<{
      info: Record<string, unknown>;
      parts: Part[];
    }>;
  }>;
  readonly session?: Record<string, unknown>;
  readonly childrenBySessionId?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        id: string;
      }>
    >
  >;
  readonly children?: (input: { sessionID: string }) => Promise<unknown>;
  readonly pendingPermissions?: ReadonlyArray<PermissionRequest>;
  readonly permissionList?: () => Promise<unknown>;
  readonly pendingQuestions?: ReadonlyArray<QuestionRequest>;
  readonly questionList?: () => Promise<unknown>;
  readonly permissionReply?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly mcpAdd?: (
    input: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
    },
  ) => Promise<unknown>;
  readonly serverExit?: Effect.Effect<number>;
  readonly serverPassword?: string;
  readonly sessionCreateError?: Error;
  readonly sessionUpdate?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly scopeCloseDefect?: boolean;
  readonly connectBarrier?: Effect.Effect<void>;
  readonly abortBarrier?: () => Promise<void>;
  readonly onScopeClose?: () => void;
}) {
  const abortCalls: Array<{
    sessionID: string;
  }> = [];
  const cliModelCalls: Array<Parameters<OpenCodeRuntimeShape["listOpenCodeCliModels"]>[0]> = [];
  const connectCalls: Array<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0]> = [];
  const createClientCalls: Array<Parameters<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>[0]> =
    [];
  const createCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const forkCalls: Array<{
    sessionID: string;
  }> = [];
  const permissionReplyCalls: Array<Record<string, unknown>> = [];
  const questionReplyCalls: Array<Record<string, unknown>> = [];
  const questionRejectCalls: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const promptCallKinds: Array<"async" | "sync"> = [];
  const mcpAddCalls: Array<Record<string, unknown>> = [];
  let eventSubscribeCallCount = 0;
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => {
        const subscriptionIndex = eventSubscribeCallCount;
        eventSubscribeCallCount += 1;
        return {
          stream:
            options?.eventSubscriptions?.[subscriptionIndex] ??
            options?.events ??
            emptySubscription,
        };
      },
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        if (options?.sessionCreateError) throw options.sessionCreateError;
        return { data: { id: "opencode-session-1" } };
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return options?.sessionUpdate ? options.sessionUpdate(input) : { data: null };
      },
      promptAsync: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        promptCallKinds.push("async");
        if (options?.promptAsync) {
          return options.promptAsync(promptInput);
        }
        return { data: null };
      },
      prompt: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        promptCallKinds.push("sync");
        if (options?.prompt) {
          return options.prompt(promptInput);
        }
        return { data: null };
      },
      abort: async (input: { sessionID: string }) => {
        abortCalls.push(input);
        if (options?.abortBarrier) {
          await options.abortBarrier();
        }
        return { data: null };
      },
      messages: options?.messages ?? (async () => ({ data: [] })),
      children: async (input: { sessionID: string }) =>
        options?.children
          ? options.children(input)
          : { data: options?.childrenBySessionId?.[input.sessionID] ?? [] },
      get: async () => ({ data: { directory: process.cwd(), ...options?.session } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async (input: { sessionID: string }) => {
        forkCalls.push(input);
        return { data: { id: "forked-session-1" } };
      },
    },
    permission: {
      list: async () =>
        options?.permissionList
          ? options.permissionList()
          : { data: options?.pendingPermissions ?? [] },
      reply: async (input: Record<string, unknown>) => {
        permissionReplyCalls.push(input);
        return options?.permissionReply ? options.permissionReply(input) : { data: null };
      },
    },
    question: {
      list: async () =>
        options?.questionList ? options.questionList() : { data: options?.pendingQuestions ?? [] },
      reply: async (input: Record<string, unknown>) => {
        questionReplyCalls.push(input);
        return { data: true };
      },
      reject: async (input: Record<string, unknown>) => {
        questionRejectCalls.push(input);
        return { data: true };
      },
    },
    command: {
      list: options?.commandList ?? (async () => ({ data: [] })),
    },
    mcp: {
      add: async (
        input: Record<string, unknown>,
        requestOptions?: {
          signal?: AbortSignal;
        },
      ) => {
        mcpAddCalls.push(input);
        return options?.mcpAdd
          ? options.mcpAdd(input, requestOptions)
          : { data: { synara: { status: "connected" } } };
      },
    },
  };
  let createClientCallCount = 0;
  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );
  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) => {
    createClientCalls.push(input);
    const commandList = options?.commandLists?.[createClientCallCount];
    createClientCallCount += 1;
    if (!commandList) {
      return client as unknown as OpencodeClient;
    }
    return {
      ...client,
      command: {
        list: async () => ({ data: commandList }),
      },
    } as unknown as OpencodeClient;
  };
  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (input) =>
      Effect.gen(function* () {
        connectCalls.push(input);
        if (options?.connectError) {
          return yield* options.connectError;
        }
        if (options?.scopeCloseDefect) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.die(new Error("scope close defect")));
        }
        if (options?.onScopeClose) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.sync(options.onScopeClose));
        }
        if (options?.connectBarrier) yield* options.connectBarrier;
        return {
          url: input.serverUrl ?? "http://127.0.0.1:4099",
          exitCode: options?.serverExit ?? null,
          external: Boolean(input.serverUrl),
          ...(options?.serverPassword ? { serverPassword: options.serverPassword } : {}),
        };
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient,
    loadOpenCodeInventory: () =>
      options?.inventoryError
        ? Effect.fail(options.inventoryError)
        : Effect.succeed(
            options?.inventory ?? {
              providerList: { connected: [], all: [], default: {} },
              agents: [],
              consoleState: null,
            },
          ),
    listOpenCodeCliModels: (input) =>
      Effect.gen(function* () {
        cliModelCalls.push(input);
        if (options?.cliModelsError) {
          return yield* options.cliModelsError;
        }
        return options?.cliModels ?? [];
      }),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };
  return {
    abortCalls,
    cliModelCalls,
    connectCalls,
    createClientCalls,
    createCalls,
    updateCalls,
    forkCalls,
    permissionReplyCalls,
    questionReplyCalls,
    questionRejectCalls,
    promptCalls,
    promptCallKinds,
    mcpAddCalls,
    get eventSubscribeCallCount() {
      return eventSubscribeCallCount;
    },
    runtime,
  };
}
function makeOpenCodeAdapterTestLayer(runtime: OpenCodeRuntimeShape) {
  return makeOpenCodeAdapterLive({ runtime }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}
describe("OpenCodeAdapter runtime lifecycle", () => {
  it.each([false, true])(
    "distinguishes an empty CLI catalog from failed discovery (failed: %s)",
    async (failed) => {
      const runtime = createMockOpenCodeRuntime(
        failed
          ? {
              cliModelsError: new OpenCodeRuntimeError({
                operation: "listOpenCodeCliModels",
                detail: "CLI unavailable",
              }),
            }
          : {},
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          return yield* adapter.listModels!({ provider: "opencode", cwd: process.cwd() });
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );
      expect(result.models).toEqual([]);
      expect(result.degraded).toBe(failed);
    },
  );
  it("reports an interrupted stop as inactive and resumes the thread on the next start", async () => {
    const abortBarrier = Deferred.makeUnsafe<void>();
    const closeScope = vi.fn();
    const runtime = createMockOpenCodeRuntime({
      onScopeClose: closeScope,
      abortBarrier: () => Deferred.await(abortBarrier).pipe(Effect.runPromise),
    });
    const threadId = asThreadId("thread-interrupted-stop-recovery");
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.abortCalls).toHaveLength(1)));
        yield* Fiber.interrupt(stopFiber);
        // The interrupted stop leaves a stopped context registered: the probe must
        // report it inactive while the map still owns it.
        yield* Effect.gen(function* () {
          // Recovery must not abandon the old managed server and gateway scope.
          expect(closeScope).toHaveBeenCalledTimes(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect((yield* adapter.listSessions()).some((s) => s.threadId === threadId)).toBe(true);
        }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(abortBarrier, Effect.void))));
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: started.resumeCursor,
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect(closeScope).toHaveBeenCalledTimes(1);
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "recovered turn",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5" },
        });
        expect(turn.threadId).toBe(threadId);
        expect(runtime.createCalls).toHaveLength(1);
        expect(runtime.updateCalls.some((call) => call.sessionID === "opencode-session-1")).toBe(
          true,
        );
        expect(runtime.promptCalls).toHaveLength(1);
        expect(runtime.promptCalls[0]?.sessionID).toBe("opencode-session-1");
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  });
  it("PR1160 TASK-04 keeps the probe and the shared guard in agreement across session states", async () => {
    const abortBarrier = Deferred.makeUnsafe<void>();
    const runtime = createMockOpenCodeRuntime({
      abortBarrier: () => Deferred.await(abortBarrier).pipe(Effect.runPromise),
    });
    const absentThreadId = asThreadId("thread-probe-guard-absent");
    const stoppedThreadId = asThreadId("thread-probe-guard-stopped");
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const guardedOps = (threadId: ThreadId) => [
          {
            name: "sendTurn",
            run: () =>
              adapter.sendTurn({
                threadId,
                input: "probe",
                attachments: [],
                modelSelection: { provider: "opencode", model: "openai/gpt-5" },
              }),
          },
          { name: "interruptTurn", run: () => adapter.interruptTurn(threadId) },
          {
            name: "respondToRequest",
            run: () =>
              adapter.respondToRequest(
                threadId,
                ApprovalRequestId.makeUnsafe("probe-request"),
                "accept",
              ),
          },
          {
            name: "respondToUserInput",
            run: () =>
              adapter.respondToUserInput(threadId, ApprovalRequestId.makeUnsafe("probe-request"), {
                answer: "yes",
              }),
          },
          { name: "readThread", run: () => adapter.readThread(threadId) },
          { name: "rollbackThread", run: () => adapter.rollbackThread(threadId, 1) },
          { name: "compactThread", run: () => adapter.compactThread!(threadId) },
        ];
        // Absent: the probe is false and every guarded operation reports missing.
        expect(yield* adapter.hasSession(absentThreadId)).toBe(false);
        for (const op of guardedOps(absentThreadId)) {
          expect({ op: op.name, tag: failureTag(yield* op.run().pipe(Effect.exit)) }).toEqual({
            op: op.name,
            tag: "ProviderAdapterSessionNotFoundError",
          });
        }
        // Live: the probe is true.
        yield* adapter.startSession({
          provider: "opencode",
          threadId: stoppedThreadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        expect(yield* adapter.hasSession(stoppedThreadId)).toBe(true);
        // Stopped-retained: the probe is false while the map still owns the
        // context, and every guarded operation reports the closed session.
        const stopFiber = yield* adapter.stopSession(stoppedThreadId).pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.abortCalls).toHaveLength(1)));
        yield* Fiber.interrupt(stopFiber);
        yield* Effect.gen(function* () {
          expect(yield* adapter.hasSession(stoppedThreadId)).toBe(false);
          expect((yield* adapter.listSessions()).some((s) => s.threadId === stoppedThreadId)).toBe(
            true,
          );
          for (const op of guardedOps(stoppedThreadId)) {
            expect({ op: op.name, tag: failureTag(yield* op.run().pipe(Effect.exit)) }).toEqual({
              op: op.name,
              tag: "ProviderAdapterSessionClosedError",
            });
          }
        }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(abortBarrier, Effect.void))));
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  });
});
