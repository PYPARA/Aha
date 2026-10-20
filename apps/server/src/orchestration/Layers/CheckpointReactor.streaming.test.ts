// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderKind, ProviderRuntimeEvent, ProviderSession } from "@synara/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
} from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  CHECKPOINT_RUNTIME_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { type ProviderServiceError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { makeCheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};
function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
  providerStatus: ProviderSession["status"] = "ready",
  activeTurnId?: TurnId,
  runtimeEventCapacity?: number,
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(
    runtimeEventCapacity === undefined
      ? PubSub.unbounded<ProviderRuntimeEvent>()
      : PubSub.bounded<ProviderRuntimeEvent>(runtimeEventCapacity),
  );
  const rollbackConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }): Effect.Effect<void, ProviderServiceError> => Effect.void,
  );
  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: providerStatus,
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            ...(activeTurnId !== undefined ? { activeTurnId } : {}),
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    forkThread: () => Effect.succeed(null),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getPersistedSessionProfile: () => Effect.succeed(undefined),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation,
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };
  const canonical = (event: LegacyProviderRuntimeEvent | ProviderRuntimeEvent) =>
    ({ ...event, payload: event.payload ?? {} }) as unknown as ProviderRuntimeEvent;
  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, canonical(event)));
  };
  return {
    service,
    rollbackConversation,
    emit,
    publish: (event: LegacyProviderRuntimeEvent | ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, canonical(event)),
  };
}
async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    id: string;
    latestTurn: {
      turnId: string;
    } | null;
    checkpoints: ReadonlyArray<{
      turnId: string;
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{
        path: string;
      }>;
    }>;
    activities: ReadonlyArray<{
      kind: string;
      payload?: unknown;
    }>;
  }) => boolean,
  timeoutOrThread: number | ThreadId = 30000,
  timeoutIfThread = 30000,
) {
  const timeoutMs = typeof timeoutOrThread === "number" ? timeoutOrThread : timeoutIfThread;
  const threadId =
    typeof timeoutOrThread === "number" ? ThreadId.makeUnsafe("thread-1") : timeoutOrThread;
  const deadline = performance.now() + timeoutMs;
  const poll = async (): Promise<{
    id: string;
    latestTurn: {
      turnId: string;
    } | null;
    checkpoints: ReadonlyArray<{
      turnId: string;
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{
        path: string;
      }>;
    }>;
    activities: ReadonlyArray<{
      kind: string;
      payload?: unknown;
    }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}
function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}
function createGitRepository(hasInitialCommit = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  if (hasInitialCommit) {
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["commit", "-m", "Initial"]);
  }
  return cwd;
}
function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}
function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}
async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}
describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore
    | SqlClient.SqlClient
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus
    | TurnCheckpointCoordinator
    | ProviderService
    | ProviderRuntimeEventRepository
    | OrchestrationEventStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderKind;
    readonly providerStatus?: ProviderSession["status"];
    readonly providerActiveTurnId?: TurnId;
    readonly hasInitialCommit?: boolean;
    readonly runtimeEventCapacity?: number;
    readonly sqlStatements?: string[];
    readonly startReactor?: boolean;
    readonly simulateProviderBaseline?: boolean;
    readonly liveTurnDiffThrottleWindowMs?: number;
  }) {
    const cwd = createGitRepository(options?.hasInitialCommit ?? true);
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? "codex",
      options?.providerStatus ?? "ready",
      options?.providerActiveTurnId,
      options?.runtimeEventCapacity,
    );
    // Installed after the harness has seeded its checkpoints, so a test can fail
    // one specific step of the revert saga without disturbing setup.
    const failures: {
      restoreCheckpoint?: (
        input: Parameters<CheckpointStoreShape["restoreCheckpoint"]>[0],
      ) => CheckpointStoreError | null;
      deleteCheckpointRefs?: (
        input: Parameters<CheckpointStoreShape["deleteCheckpointRefs"]>[0],
      ) => CheckpointStoreError | null;
    } = {};
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const checkpointStoreLayer = Layer.effect(
      CheckpointStore,
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return {
          ...store,
          restoreCheckpoint: (input) =>
            Effect.suspend(() => {
              const failure = failures.restoreCheckpoint?.(input) ?? null;
              return failure === null ? store.restoreCheckpoint(input) : Effect.fail(failure);
            }),
          deleteCheckpointRefs: (input) =>
            Effect.suspend(() => {
              const failure = failures.deleteCheckpointRefs?.(input) ?? null;
              return failure === null ? store.deleteCheckpointRefs(input) : Effect.fail(failure);
            }),
        } satisfies CheckpointStoreShape;
      }),
    ).pipe(Layer.provide(CheckpointStoreLive.pipe(Layer.provide(GitCoreLive))));
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-checkpoint-reactor-test-",
    });
    const layer = makeCheckpointReactorLive(
      options?.liveTurnDiffThrottleWindowMs === undefined
        ? undefined
        : { liveTurnDiffThrottleWindowMs: options.liveTurnDiffThrottleWindowMs },
    ).pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(
      options?.sqlStatements === undefined
        ? layer
        : layer.pipe(
            Layer.provide(
              Layer.succeed(Statement.CurrentTransformer, (statement) =>
                Effect.sync(() => {
                  options.sqlStatements!.push(statement.compile()[0]);
                  return statement;
                }),
              ),
            ),
          ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const startReactor = () => Effect.runPromise(reactor.start.pipe(Scope.provide(scope!)));
    if (options?.startReactor !== false) await startReactor();
    const runtimeEvents = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository).pipe(
        Effect.provide(ProviderRuntimeEventRepositoryLive),
      ),
    );
    const drain = () => Effect.runPromise(reactor.drain);
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );
    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        }),
      );
    }
    return {
      sourceEngine: engine,
      // This suite isolates the checkpoint reactor. Model the provider's
      // pre-dispatch owner explicitly instead of relying on a domain backup.
      engine: {
        ...engine,
        dispatch: (command) =>
          command.type === "thread.turn.start" && options?.simulateProviderBaseline !== false
            ? checkpointStore
                .captureCheckpoint({
                  cwd,
                  checkpointRef: checkpointRefForThreadMessageStart(
                    command.threadId,
                    command.message.messageId,
                  ),
                  skipIfExists: true,
                })
                .pipe(Effect.orDie, Effect.andThen(engine.dispatch(command)))
            : engine.dispatch(command),
      } satisfies OrchestrationEngineShape,
      provider,
      checkpointStore,
      cwd,
      drain,
      startReactor,
      start: startReactor,
      reactor,
      runtimeEvents,
      prepareBaseline: (turnId: TurnId) =>
        Effect.runPromise(
          checkpointStore.captureCheckpoint({
            cwd,
            checkpointRef: checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), turnId),
            skipIfExists: true,
          }),
        ),
      failures,
    };
  }
  it("does not wake a checkpoint scan for persisted text deltas", async () => {
    const harness = await createHarness({ startReactor: false, seedFilesystemCheckpoints: false });
    const bus = Effect.runSync(
      PubSub.unbounded<
        import("../../persistence/Services/ProviderRuntimeEvents.ts").PersistedProviderRuntimeEvent
      >(),
    );
    Object.assign(harness.provider.service, { streamPersistedEvents: Stream.fromPubSub(bus) });
    await harness.start();
    await harness.drain();
    // drain leaves its last wake pulse queued; let that scan finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const repository = await runtime!.runPromise(Effect.service(ProviderRuntimeEventRepository));
    // Every scan reads one runtime page; nothing else reads it while no lane is active.
    const scans = vi.spyOn(repository, "readAfter");
    const started = performance.now();
    let lastSequence = 0;
    for (let index = 0; index < 100; index++) {
      const row = await Effect.runPromise(
        harness.runtimeEvents.append({
          type: "content.delta",
          eventId: EventId.makeUnsafe(`stream-no-scan-${index}`),
          provider: "codex",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("stream-no-scan-turn"),
          createdAt: new Date().toISOString(),
          payload: { streamKind: "assistant_text", delta: "x" },
        }),
      );
      lastSequence = row.sequence;
      await Effect.runPromise(PubSub.publish(bus, row));
      // Streamed deltas arrive spaced out, giving a per-row wake time to scan.
      await Effect.runPromise(Effect.sleep("1 millis"));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    // At most the coalesced idle scan (one per second) may have run.
    const elapsedSeconds = Math.floor((performance.now() - started) / 1000);
    expect(scans.mock.calls.length).toBeLessThanOrEqual(elapsedSeconds);
    // The cursor still moves past ignored rows on drain.
    await settleCheckpointWork(harness.reactor.drain);
    expect(
      await Effect.runPromise(harness.runtimeEvents.getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)),
    ).toBe(lastSequence);
  });
  it("recovers a committed native checkpoint while deferred thread detail is unavailable", async () => {
    const harness = await createHarness();
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    vi.spyOn(query, "getThreadDetailById").mockImplementation(() => Effect.succeed(Option.none()));
    vi.spyOn(query, "getThreadShellById").mockImplementation(() => Effect.succeed(Option.none()));
    vi.spyOn(query, "getProjectShellById").mockImplementation(() => Effect.succeed(Option.none()));
    const turnId = asTurnId("checkpoint-deferred-detail");
    await Effect.runPromise(
      harness.provider.publish({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("checkpoint-deferred-detail-event"),
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        createdAt: new Date().toISOString(),
        payload: { state: "completed" },
      }),
    );
    await waitForThread(
      harness.engine,
      (thread) => thread.checkpoints.some((entry) => entry.turnId === turnId),
      ThreadId.makeUnsafe("thread-1"),
      1000,
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
  });
  const settleCheckpointWork = async (effect: Effect.Effect<void>) => {
    expect(
      Option.isSome(await Effect.runPromise(effect.pipe(Effect.timeoutOption("3 seconds")))),
    ).toBe(true);
  };
  // A projection repair deletes every project row and replays them later, while
  // thread and turn rows stay. The checkpoint context joins the project row, so
  // the next turn must still be numbered after the thread's own checkpoints.
  it("numbers a turn after existing checkpoints while project rows are rebuilt", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const firstMessageId = MessageId.makeUnsafe("message-repair-turn-a");
    const secondMessageId = MessageId.makeUnsafe("message-repair-turn-b");
    const firstTurnId = asTurnId("turn-repair-a");
    const secondTurnId = asTurnId("turn-repair-b");
    const runTurnUntilCompletion = async (input: {
      readonly label: string;
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly fileName: string;
      readonly beforeCompletion?: () => Promise<void>;
    }) => {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${input.label}-start`),
          threadId,
          message: {
            messageId: input.messageId,
            role: "user",
            text: `create ${input.fileName}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadMessageStart(threadId, input.messageId),
      );
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.makeUnsafe(`evt-${input.label}-started`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId: input.turnId,
      });
      await waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadTurnStart(threadId, input.turnId),
      );
      fs.writeFileSync(path.join(harness.cwd, input.fileName), `${input.fileName}\n`, "utf8");
      await input.beforeCompletion?.();
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.makeUnsafe(`evt-${input.label}-completed`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId: input.turnId,
        payload: { state: "completed" },
      });
      return waitForThread(harness.engine, (entry) =>
        entry.checkpoints.some(
          (checkpoint) => checkpoint.turnId === input.turnId && checkpoint.status !== "missing",
        ),
      );
    };
    await runTurnUntilCompletion({
      label: "repair-turn-a",
      messageId: firstMessageId,
      turnId: firstTurnId,
      fileName: "a.txt",
    });
    const firstTurnRef = checkpointRefForThreadTurn(threadId, 1);
    const firstTurnCommit = runGit(harness.cwd, ["rev-parse", firstTurnRef]).trim();
    const thread = await runTurnUntilCompletion({
      label: "repair-turn-b",
      messageId: secondMessageId,
      turnId: secondTurnId,
      fileName: "b.txt",
      beforeCompletion: () =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM projection_projects`;
          }),
        ),
    });
    expect(
      thread.checkpoints
        .map((checkpoint) => [checkpoint.turnId, checkpoint.checkpointTurnCount] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      [firstTurnId, 1],
      [secondTurnId, 2],
    ]);
    // Turn 1's ref still holds turn A's tree instead of the tree after turn B.
    expect(runGit(harness.cwd, ["rev-parse", firstTurnRef]).trim()).toBe(firstTurnCommit);
    expect(gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 2), "b.txt")).toBe(
      "b.txt\n",
    );
  });
  it("throttles live turn-diff captures per thread and ends a burst with its last edit", async () => {
    // Advance the throttle clock explicitly: real Git work can outlast this
    // window on a busy machine without changing which edits form this burst.
    const throttleWindowMs = 500;
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
      liveTurnDiffThrottleWindowMs: throttleWindowMs,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-claude-burst");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude-burst"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await harness.prepareBaseline(turnId);
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-burst"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId));
    const liveRef = checkpointRefForThreadTurnLive(threadId, turnId);
    let throttleNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => throttleNow);
    const captures = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const liveCaptures = () =>
      captures.mock.calls.filter(([input]) => input.checkpointRef === liveRef).length;
    const emitFileChange = (index: number) => {
      fs.writeFileSync(path.join(harness.cwd, `burst-${index}.txt`), `edit ${index}\n`, "utf8");
      harness.provider.emit({
        type: "item.completed",
        eventId: EventId.makeUnsafe(`evt-item-file-change-burst-${index}`),
        provider: "claudeAgent",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        itemId: `item-file-change-burst-${index}`,
        payload: { itemType: "file_change", status: "completed" },
      });
    };
    // Each edit is processed on its own (no newer journaled edit supersedes it),
    // so only the throttle keeps this burst from capturing once per edit.
    for (let index = 1; index <= 5; index++) {
      emitFileChange(index);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await harness.drain();
    }
    expect(liveCaptures()).toBe(1);
    throttleNow += throttleWindowMs;
    const burstFiles = [1, 2, 3, 4, 5].map((index) => `burst-${index}.txt`);
    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.status === "missing" &&
          burstFiles.every((file) => checkpoint.files?.some((entry) => entry.path === file)),
      ),
    );
    expect(liveCaptures()).toBe(2);
    expect(gitRefExists(harness.cwd, liveRef)).toBe(false);
    // An edit inside the next window stays pending; turn completion drops it.
    emitFileChange(6);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await harness.drain();
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-burst"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.status === "ready",
      ),
    );
    throttleNow += throttleWindowMs;
    await new Promise((resolve) => setTimeout(resolve, throttleWindowMs + 200));
    await harness.drain();
    expect(liveCaptures()).toBe(2);
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.checkpoints).toHaveLength(1);
    expect(thread?.checkpoints[0]?.status).toBe("ready");
    expect(thread?.checkpoints[0]?.files?.map((file) => file.path).toSorted()).toEqual([
      ...burstFiles,
      "burst-6.txt",
    ]);
  });
});
