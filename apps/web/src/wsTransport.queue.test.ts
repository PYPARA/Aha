// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { WS_REQUEST_CLASS_LIMITS } from "@synara/shared/wsRequestClass";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcRequestQueue } from "./lib/rpcRequestQueue";
import { WsTransport, type WsThreadStreamFailure } from "./wsTransport";
type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;
const sockets: MockWebSocket[] = [];
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  onSend: ((data: string) => void) | null = null;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();
  constructor(readonly url: string) {
    sockets.push(this);
  }
  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: unknown) {
    this.sent.push(data);
    this.onSend?.(String(data));
  }
  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" } as never);
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }
  failBeforeOpen() {
    this.emit("error", { data: new Error("socket open failure") } as never);
  }
  receive(data: string) {
    this.emit("message", { data });
  }
  // Answers Effect RPC frames so unit tests can complete a feature-socket
  // session: Ping gets a Pong and every request gets a successful void Exit.
  serveVoidRpc() {
    this.onSend = (data) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame._tag === "Ping") {
        this.receive(JSON.stringify({ _tag: "Pong" }));
      } else if (frame._tag === "Request" && typeof frame.id === "string") {
        this.receive(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value: null },
          }),
        );
      }
    };
    this.open();
  }
  private emit(
    type: WsEventType,
    event?: {
      data?: unknown;
    },
  ) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }
}
const originalWebSocket = globalThis.WebSocket;
interface WsTransportInternals {
  readonly streamCleanups: Map<string, () => void>;
  readonly streamSettled: Map<string, Promise<void>>;
  readonly streamCapacityRetries: Map<string, number>;
  readonly streamDuplicateRetries: Map<string, number>;
  readonly streamThreadBootstrapRetries: Map<string, number>;
  readonly streamResnapshotRetries: Map<string, number>;
  readonly projectFileWatchRetries: Map<string, number>;
  readonly streamCapacityRetryTimers: Map<string, number>;
  readonly streamOverflowRetries: Map<string, number>;
  readonly streamCompletionRetries: Map<string, number>;
  readonly streamCompletionRetryTimers: Map<string, number>;
  readonly activeThreadStreamInputs: Map<string, unknown>;
  readonly threadSubscriptions: Map<string, unknown>;
  readonly projectFileSubscriptions: Map<
    string,
    {
      readonly input: {
        cwd: string;
        relativePath: string;
      };
      readonly listeners: Set<unknown>;
    }
  >;
  readonly projectAgentSubscriptions: Map<string, unknown>;
  shellSubscribed: boolean;
  readonly threadStreamFailureListeners: Set<(failure: WsThreadStreamFailure) => void>;
  disposed: boolean;
  sessionVersion: number;
  currentFeatureSession: {
    id: number;
    failed: boolean;
  } | null;
  reconnectPromise: Promise<unknown> | null;
  readonly recovery: {
    phase: "ready" | "scheduled" | "recovering" | "tripped";
    episodeRef: string | null;
    suppressedSessionId: number | null;
    candidateFailedSessionId: number | null;
    firstFailureAt: number | null;
    escalated: boolean;
    countedDefectSessions: Set<number>;
    consecutiveDefects: number;
  };
  noteProtocolFailure(session: unknown, error: unknown): void;
  runScheduledRecovery(episodeRef: string): void;
  reconnect(): Promise<unknown>;
  openReconnectSession(): Promise<unknown>;
  getClient(): Promise<unknown>;
  startStream<T>(
    client: unknown,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: () => void,
  ): void;
  startThreadStream(
    client: unknown,
    threadId: string,
    input: unknown,
    forceRestart?: boolean,
  ): Promise<void>;
  startProjectFileChangeStream(client: unknown, key: string, subscription: unknown): void;
  startProjectAgentEventStream(client: unknown, projectId: string, params: unknown): void;
  stopStream(
    key: string,
    options?: {
      readonly resetCapacityRetry?: boolean;
    },
  ): Promise<void>;
  emitThreadStreamFailure(failure: WsThreadStreamFailure): void;
}
function makeRecoveryState() {
  return {
    phase: "ready" as const,
    episodeRef: null,
    suppressedSessionId: null,
    candidateFailedSessionId: null,
    firstFailureAt: null,
    escalated: false,
    countedDefectSessions: new Set<number>(),
    consecutiveDefects: 0,
  };
}
function makeBareTransport(): {
  readonly transport: WsTransport;
  readonly internals: WsTransportInternals;
} {
  const transport = Object.create(WsTransport.prototype) as WsTransport;
  const internals = transport as unknown as WsTransportInternals;
  Object.assign(internals, {
    streamCleanups: new Map(),
    streamSettled: new Map(),
    streamCapacityRetries: new Map(),
    streamDuplicateRetries: new Map(),
    streamThreadBootstrapRetries: new Map(),
    streamResnapshotRetries: new Map(),
    projectFileWatchRetries: new Map(),
    streamCapacityRetryTimers: new Map(),
    streamOverflowRetries: new Map(),
    streamCompletionRetries: new Map(),
    streamCompletionRetryTimers: new Map(),
    activeThreadStreamInputs: new Map(),
    threadSubscriptions: new Map(),
    projectFileSubscriptions: new Map(),
    projectAgentSubscriptions: new Map(),
    threadStreamFailureListeners: new Set(),
    shellStreamFailureListeners: new Set(),
    disposed: false,
    lifetime: new AbortController(),
    state: "ready",
    stateListeners: new Set(),
    compatibility: null,
    compatibilityResultListeners: new Set(),
    sessionVersion: 1,
    currentFeatureSession: null,
    reconnectPromise: null,
    recovery: makeRecoveryState(),
    recoveryEscalationTimer: null,
    getClientRuntime: () => ({
      runCallback: (
        effect: Effect.Effect<unknown, Error>,
        options: {
          readonly onExit: (exit: Exit.Exit<unknown, Error>) => void;
        },
      ) =>
        Effect.runCallback(effect, {
          onExit: (exit) => {
            void Promise.resolve().then(() => options.onExit(exit));
          },
        }),
    }),
    reconnect: vi.fn(async () => ({})),
    unaryRequestQueue: new RpcRequestQueue(WS_REQUEST_CLASS_LIMITS),
  });
  return { transport, internals };
}
function bindWindowTimersToCurrentGlobals(): void {
  Object.assign(window, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}
const NEGOTIATION_RESULT: WsBootstrapNegotiateResult = {
  protocolEpoch: WS_PROTOCOL_EPOCH,
  negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
  serverBuild: "test-server",
  serverInstanceId: "server-instance-1",
  capabilities: ["transport.http-negotiate"],
};
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");
  // Default to an older server without the HTTP negotiate endpoint so
  // connection tests exercise the legacy bootstrap fallback unless they
  // install their own fetch stub.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("http negotiate unavailable"))),
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("WsTransport", () => {
  it("queues unary requests beyond their class budget instead of sending them", async () => {
    const { transport, internals } = makeBareTransport();
    const pendingResults: Array<(value: unknown) => void> = [];
    const runPromise = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingResults.push(resolve);
        }),
    );
    Object.assign(internals, {
      getClient: vi.fn(async () => ({
        "projects.readFile": () => Effect.succeed({ contents: "ok" }),
      })),
      getClientRuntime: () => ({ runPromise }),
    });
    const reads = [0, 1, 2].map(() =>
      transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null }),
    );
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runPromise).toHaveBeenCalledTimes(2);
    pendingResults[0]!({ contents: "first" });
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(3));
    pendingResults[1]!({ contents: "second" });
    pendingResults[2]!({ contents: "third" });
    await expect(Promise.all(reads)).resolves.toEqual([
      { contents: "first" },
      { contents: "second" },
      { contents: "third" },
    ]);
  });
  it("fails a request that waited out the capacity budget without ever sending it", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { transport, internals } = makeBareTransport();
      const runPromise = vi.fn(() => new Promise(() => undefined));
      Object.assign(internals, {
        state: "open",
        openedAtMs: Number.NEGATIVE_INFINITY,
        getClient: vi.fn(async () => ({
          "projects.readFile": () => Effect.succeed({ contents: "ok" }),
        })),
        getClientRuntime: () => ({ runPromise }),
      });
      void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
      void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
      // No deadline of its own: the queue still bounds the wait.
      const queued = transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
      const rejected = expect(queued).rejects.toMatchObject({
        code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(runPromise).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(runPromise).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not spend the queue budget while the transport is still connecting", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { transport, internals } = makeBareTransport();
      let connect!: (client: unknown) => void;
      const connected = new Promise((resolve) => {
        connect = resolve;
      });
      const runPromise = vi.fn(async () => ({ contents: "ok" }));
      Object.assign(internals, {
        state: "connecting",
        getClient: vi.fn(() => connected),
        getClientRuntime: () => ({ runPromise }),
      });
      const reads = [0, 1, 2, 3].map(() =>
        transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null }),
      );
      // A slow reconnect is not capacity: nothing may fail while it lasts.
      await vi.advanceTimersByTimeAsync(10000);
      expect(runPromise).not.toHaveBeenCalled();
      Object.assign(internals, { state: "open", openedAtMs: Date.now() });
      connect({ "projects.readFile": () => Effect.succeed({ contents: "ok" }) });
      await expect(Promise.all(reads)).resolves.toHaveLength(4);
      expect(runPromise).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a deadline spent in the queue as capacity, not as an uncertain turn", async () => {
    const { transport, internals } = makeBareTransport();
    const runPromise = vi.fn(() => new Promise(() => undefined));
    const settleTurnDispatch = vi.fn();
    Object.assign(internals, {
      compatibility: {
        ...NEGOTIATION_RESULT,
        capabilities: [WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY],
      },
      unaryRequestQueue: new RpcRequestQueue({ ...WS_REQUEST_CLASS_LIMITS, control: 1 }),
      getClient: vi.fn(async () => ({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: () => Effect.succeed({ sequence: 1 }),
      })),
      getClientRuntime: () => ({ runPromise }),
      settleTurnDispatch,
    });
    const turnStart = (commandId: string) => ({
      command: {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(commandId),
        threadId: ThreadId.makeUnsafe("thread-queued"),
        message: {
          messageId: MessageId.makeUnsafe(`message-${commandId}`),
          role: "user",
          text: "hello",
          attachments: [],
        },
        createdAt: "2026-10-15T00:00:00.000Z",
      },
    });
    void transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, turnStart("held"), {
      timeoutMs: null,
    });
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(1));
    await expect(
      transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, turnStart("queued"), {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "RPC_REQUEST_CAPACITY_EXCEEDED", retryable: true });
    expect(runPromise).toHaveBeenCalledTimes(1);
    expect(settleTurnDispatch).not.toHaveBeenCalled();
  });
  it("drops a cancelled queued request and hands its place to the next caller", async () => {
    const { transport, internals } = makeBareTransport();
    const pendingResults: Array<(value: unknown) => void> = [];
    const runPromise = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingResults.push(resolve);
        }),
    );
    Object.assign(internals, {
      getClient: vi.fn(async () => ({
        "projects.readFile": () => Effect.succeed({ contents: "ok" }),
      })),
      getClientRuntime: () => ({ runPromise }),
    });
    void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    const controller = new AbortController();
    const cancelled = transport.request(
      WS_METHODS.projectsReadFile,
      {},
      { timeoutMs: null, signal: controller.signal },
    );
    const next = transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "WS_REQUEST_ABORTED" });
    pendingResults[0]!({ contents: "first" });
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(3));
    pendingResults[2]!({ contents: "next" });
    await expect(next).resolves.toEqual({ contents: "next" });
  });
  it("rejects queued requests when the transport is disposed", async () => {
    const { transport, internals } = makeBareTransport();
    const runPromise = vi.fn(() => new Promise(() => undefined));
    Object.assign(internals, {
      clientPromise: Promise.resolve(),
      takeCurrentRuntime: () => null,
      getClient: vi.fn(async () => ({
        "projects.readFile": () => Effect.succeed({ contents: "ok" }),
      })),
      getClientRuntime: () => ({ runPromise }),
    });
    void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    void transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    const queued = transport.request(WS_METHODS.projectsReadFile, {}, { timeoutMs: null });
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(2));
    await transport.dispose();
    await expect(queued).rejects.toThrow("Transport disposed");
    expect(runPromise).toHaveBeenCalledTimes(2);
  });
  it("does not queue stream-backed actions behind unary traffic", async () => {
    const { transport, internals } = makeBareTransport();
    const runRecoverableGitAction = vi.fn(async () => ({ status: "ok" }));
    Object.assign(internals, {
      unaryRequestQueue: new RpcRequestQueue({ ...WS_REQUEST_CLASS_LIMITS, standard: 1 }),
      getClient: vi.fn(async () => ({
        [WS_METHODS.gitListBranches]: () => Effect.succeed({ branches: [] }),
      })),
      getClientRuntime: () => ({ runPromise: vi.fn(() => new Promise(() => undefined)) }),
      runRecoverableGitAction,
    });
    void transport.request(WS_METHODS.gitListBranches, {}, { timeoutMs: null });
    await expect(
      transport.request(WS_METHODS.gitRunStackedAction, {}, { timeoutMs: null }),
    ).resolves.toEqual({ status: "ok" });
    expect(runRecoverableGitAction).toHaveBeenCalledTimes(1);
  });
});
it("times out a stuck unary request with the default deadline and retry guidance", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const { transport, internals } = makeBareTransport();
  Object.assign(internals, {
    getClient: async () => ({ [WS_METHODS.gitStatus]: () => Effect.never }),
    getClientRuntime: () => ({ runPromise: Effect.runPromise }),
  });
  try {
    const verdict = transport.request(WS_METHODS.gitStatus).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await verdict).toMatchObject({
      code: "WS_REQUEST_TIMEOUT",
      message: expect.stringContaining("Try again when the server responds"),
    });
  } finally {
    vi.useRealTimers();
  }
});
it("lets providerCompactThread outlive the default deadline until its caller cancels", async () => {
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const { transport, internals } = makeBareTransport();
  const caller = new AbortController();
  Object.assign(internals, {
    getClient: async () => ({ [WS_METHODS.providerCompactThread]: () => Effect.never }),
    getClientRuntime: () => ({ runPromise: Effect.runPromise }),
  });
  let settled = false;
  const pending = transport
    .request(WS_METHODS.providerCompactThread, {}, { timeoutMs: null, signal: caller.signal })
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(120000);
    expect(settled).toBe(false);
    caller.abort();
    expect(await pending).toMatchObject({ code: "WS_REQUEST_ABORTED" });
  } finally {
    caller.abort();
    vi.useRealTimers();
  }
});
it("does not poll server runtime status on an open socket that advertises it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          ...NEGOTIATION_RESULT,
          capabilities: [...NEGOTIATION_RESULT.capabilities, WS_SERVER_RUNTIME_STATUS_CAPABILITY],
        }),
      ),
    ),
  );
  vi.useFakeTimers();
  bindWindowTimersToCurrentGlobals();
  const transport = new WsTransport("ws://localhost:3020");
  try {
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.serveVoidRpc();
    await vi.waitFor(() => expect(transport.getState()).toBe("open"));
    await vi.advanceTimersByTimeAsync(30000);
    const requestedTags = socket.sent
      .map(
        (data) =>
          JSON.parse(String(data)) as {
            _tag?: string;
            tag?: string;
          },
      )
      .filter((frame) => frame._tag === "Request")
      .map((frame) => frame.tag);
    expect(requestedTags).not.toContain(WS_METHODS.serverGetRuntimeStatus);
  } finally {
    await transport.dispose();
    vi.useRealTimers();
  }
});
