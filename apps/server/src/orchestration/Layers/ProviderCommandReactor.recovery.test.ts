// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: ProviderCommandReactor.test.ts
// Purpose: Verifies provider intent orchestration, queueing, rollback, and transcript bootstrap flows.
// Layer: Orchestration integration tests
// Depends on: ProviderCommandReactorLive with in-memory provider and persistence services.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  ProviderForkThreadResult,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ServerSettings,
} from "@synara/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ChatAttachment,
} from "@synara/contracts";
import type { DeepPartial } from "@synara/shared/Struct";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  PubSub,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "../../agentGateway/Services/AgentGatewayOperationRepository.ts";
import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionRegistryShape,
} from "../../agentGateway/Services/AgentGatewaySessionRegistry.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import {
  checkpointRefForThreadTurn,
  isManagedCheckpointRefForThread,
} from "../../checkpointing/Utils.ts";
import {
  ComputerService,
  type ComputerServiceShape,
} from "../../computer/Services/ComputerService.ts";
import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { GitCommandError, TextGenerationError } from "../../git/Errors.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import {
  ProviderHealth,
  type ProviderHealthShape,
} from "../../provider/Services/ProviderHealth.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type OrchestrationDispatchError } from "../Errors.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}
describe("ProviderCommandReactor", () => {
  const runtimes = new Set<{
    dispose: () => Promise<void>;
  }>();
  const scopes = new Set<Scope.Closeable>();
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const activeScope of scopes) {
      await Effect.runPromise(Scope.close(activeScope, Exit.void));
    }
    scopes.clear();
    for (const runtime of runtimes) {
      await runtime.dispose();
    }
    runtimes.clear();
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });
  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly conversationRollback?: "native" | "restart-session";
    readonly checkpointStore?: Partial<CheckpointStoreShape>;
    readonly hubOutputReactor?: Partial<HubOutputReactorShape>;
    readonly forkThreadResult?: ProviderForkThreadResult | null;
    readonly startReactor?: boolean;
    readonly interruptTurn?: ProviderServiceShape["interruptTurn"];
    readonly commandEventTimeout?: Duration.Duration;
    readonly preTurnBaselineTimeout?: Duration.Duration;
    readonly cacheResponseTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionWaitTimeout?: Duration.Duration;
    readonly gatewayOperationCompletionNegativeCacheTtl?: Duration.Duration;
    readonly logMessages?: string[];
    readonly gatewayOperationId?: string;
    readonly gitWritingModelSelection?: ModelSelection;
    readonly omitStopRuntimeSession?: boolean;
    readonly serverSettings?: DeepPartial<ServerSettings>;
    readonly confirmNativeResume?: (resumeCursor: unknown) => boolean;
    readonly generateThreadTitle?: TextGenerationShape["generateThreadTitle"];
    readonly computerService?: ComputerServiceShape;
    readonly gatewaySessions?: AgentGatewaySessionRegistryShape;
    readonly getClaudeCacheObservation?: NonNullable<
      ProviderServiceShape["getClaudeCacheObservation"]
    >;
    readonly startClaudeCompaction?: NonNullable<ProviderServiceShape["startClaudeCompaction"]>;
    readonly coordinatorThreadIds?: readonly string[];
    readonly coordinatorConfigState?:
      | {
          readonly enabled?: boolean;
          readonly pausedAt?: string | null;
          readonly archivedAt?: string | null;
        }
      | undefined;
    readonly formatContextPacket?: string;
    readonly projectAdditionalFolders?: readonly string[];
    readonly getPersistedSessionProfile?: ProviderServiceShape["getPersistedSessionProfile"];
    readonly ingestRuntimeEvents?: boolean;
    readonly cancelClaudeCompactionDiscovery?: NonNullable<
      ProviderServiceShape["cancelClaudeCompactionDiscovery"]
    >;
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const persistedResumeCursors = new Map<ThreadId, unknown>();
    // The provider that minted each persisted cursor: a cursor can only
    // natively resume a session on its own provider, so a cross-provider
    // restart that drops the input cursor must not pick it back up here.
    const persistedResumeCursorProviders = new Map<ThreadId, ProviderSession["provider"]>();
    const pendingPriorTranscriptBootstraps = new Set<ThreadId>();
    const listSessions = vi.fn<ProviderServiceShape["listSessions"]>(() =>
      Effect.succeed(runtimeSessions),
    );
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn<ProviderServiceShape["startSession"]>((_, input) => {
      const sessionIndex = nextSessionIndex++;
      const sessionModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? ((
              input as {
                modelSelection?: ModelSelection;
              }
            ).modelSelection ?? modelSelection)
          : modelSelection;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: sessionModelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(sessionModelSelection.model !== undefined
          ? { model: sessionModelSelection.model }
          : {}),
        threadId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const startSessionWithOutcome = vi.fn<
      NonNullable<ProviderServiceShape["startSessionWithOutcome"]>
    >((threadId, sessionInput, outcomeOptions) => {
      const persistedCursor =
        persistedResumeCursorProviders.get(threadId) === sessionInput.provider
          ? persistedResumeCursors.get(threadId)
          : undefined;
      const effectiveResumeCursor = sessionInput.resumeCursor ?? persistedCursor;
      const nativeResumeAttempted =
        effectiveResumeCursor !== undefined && effectiveResumeCursor !== null;
      const nativeResumeSucceeded =
        nativeResumeAttempted && (input?.confirmNativeResume?.(effectiveResumeCursor) ?? true);
      if (
        (outcomeOptions?.registerPriorTranscriptBootstrapOnFreshStart === true ||
          ((sessionInput.provider === "devin" || sessionInput.provider === "grok") &&
            nativeResumeAttempted)) &&
        !nativeResumeSucceeded
      ) {
        pendingPriorTranscriptBootstraps.add(threadId);
      }
      return startSession(threadId, sessionInput).pipe(
        Effect.map((session) => {
          const resolvedSession = nativeResumeSucceeded
            ? { ...session, resumeCursor: effectiveResumeCursor }
            : session;
          const runtimeIndex = runtimeSessions.findIndex(
            (candidate) => candidate.threadId === threadId,
          );
          if (runtimeIndex >= 0) {
            runtimeSessions[runtimeIndex] = resolvedSession;
          }
          persistedResumeCursors.set(threadId, resolvedSession.resumeCursor);
          persistedResumeCursorProviders.set(threadId, resolvedSession.provider);
          return {
            session: resolvedSession,
            nativeResumeAttempted,
            nativeResumeSucceeded,
            priorTranscriptBootstrapPending: pendingPriorTranscriptBootstraps.has(threadId),
          };
        }),
      );
    });
    const completePriorTranscriptBootstrap = vi.fn<
      NonNullable<ProviderServiceShape["completePriorTranscriptBootstrap"]>
    >(({ threadId }) =>
      Effect.sync(() => {
        pendingPriorTranscriptBootstraps.delete(threadId);
      }),
    );
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    // Mirrors adapter behavior: the reactor consults live provider sessions
    // (status + activeTurnId) to decide whether a turn is genuinely running.
    const setRuntimeSessionTurnState = (input: {
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly runtimeMode?: ProviderSession["runtimeMode"];
      readonly activeTurnId?: TurnId;
    }) => {
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      const base: ProviderSession = runtimeSessions[index] ?? {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        resumeCursor: { opaque: "resume-synthetic" },
        cwd: "/tmp/provider-project",
        createdAt: now,
        updatedAt: now,
      };
      const next: ProviderSession = {
        ...base,
        status: input.status,
        runtimeMode: input.runtimeMode ?? base.runtimeMode,
        ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
      };
      if (input.activeTurnId === undefined) {
        delete (
          next as {
            activeTurnId?: TurnId;
          }
        ).activeTurnId;
      }
      if (index >= 0) {
        runtimeSessions[index] = next;
      } else {
        runtimeSessions.push(next);
      }
    };
    const steerTurn = vi.fn<ProviderServiceShape["steerTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const startReview = vi.fn<ProviderServiceShape["startReview"]>((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId("turn-review-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>((forkInput) =>
      Effect.sync(() => {
        const result = input?.forkThreadResult ?? null;
        const forkModelSelection = forkInput.modelSelection ?? modelSelection;
        if (result && !runtimeSessions.some((session) => session.threadId === forkInput.threadId)) {
          runtimeSessions.push({
            provider: forkModelSelection.provider,
            status: "ready",
            runtimeMode: forkInput.runtimeMode,
            ...(forkModelSelection.model !== undefined ? { model: forkModelSelection.model } : {}),
            threadId: forkInput.threadId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        return result;
      }),
    );
    const interruptTurn = vi.fn(input?.interruptTurn ?? ((_: unknown) => Effect.void));
    const stopTask = vi.fn<ProviderServiceShape["stopTask"]>(() => Effect.void);
    const backgroundTask = vi.fn<ProviderServiceShape["backgroundTask"]>(() => Effect.void);
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(false),
    );
    const steerSubagent = vi.fn<ProviderServiceShape["steerSubagent"]>(() => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
      () => Effect.void,
    );
    const restoreCheckpoint = vi.fn<CheckpointStoreShape["restoreCheckpoint"]>(() =>
      Effect.succeed(true),
    );
    const isGitRepository = vi.fn<CheckpointStoreShape["isGitRepository"]>(() =>
      Effect.succeed(false),
    );
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void);
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
      ...input?.checkpointStore,
    };
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (
                input as {
                  threadId?: ThreadId;
                }
              ).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
        persistedResumeCursors.delete(threadId);
        persistedResumeCursorProviders.delete(threadId);
        pendingPriorTranscriptBootstraps.delete(threadId);
      }),
    );
    const stopRuntimeSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (
                input as {
                  threadId?: ThreadId;
                }
              ).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const clearSessionResumeCursor = vi.fn<
      NonNullable<ProviderServiceShape["clearSessionResumeCursor"]>
    >((input) =>
      Effect.sync(() => {
        const preserveActiveRuntime =
          typeof input === "object" &&
          input !== null &&
          "preserveActiveRuntime" in input &&
          (
            input as {
              preserveActiveRuntime?: boolean;
            }
          ).preserveActiveRuntime === true;
        if (preserveActiveRuntime) {
          return;
        }
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (
                input as {
                  threadId?: ThreadId;
                }
              ).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        persistedResumeCursors.set(threadId, null);
        persistedResumeCursorProviders.delete(threadId);
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const publishBranch = vi.fn<GitCoreShape["publishBranch"]>(() => Effect.void);
    const mutationLock = await Effect.runPromise(Semaphore.make(1));
    const withMutation: GitCoreShape["withMutation"] = (_cwd, effect) =>
      mutationLock.withPermit(effect);
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(
      input?.generateThreadTitle ??
        (() =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "disabled in test harness",
            }),
          )),
    );
    const captureStudioOutputBaseline = vi.fn<HubOutputReactorShape["captureBaselineBeforeTurn"]>(
      input?.hubOutputReactor?.captureBaselineBeforeTurn ??
        (() => Effect.succeed({ status: "completed" as const })),
    );
    const cancelPendingStudioOutputBaseline = vi.fn<
      HubOutputReactorShape["cancelPendingTurnBaseline"]
    >(input?.hubOutputReactor?.cancelPendingTurnBaseline ?? (() => Effect.void));
    const hubOutputReactor: HubOutputReactorShape = {
      captureBaselineBeforeTurn: captureStudioOutputBaseline,
      cancelPendingTurnBaseline: cancelPendingStudioOutputBaseline,
      start: input?.hubOutputReactor?.start ?? Effect.void,
      drain: input?.hubOutputReactor?.drain ?? Effect.void,
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview,
      forkThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      ...(input?.omitStopRuntimeSession
        ? {}
        : {
            stopRuntimeSession: stopRuntimeSession as NonNullable<
              ProviderServiceShape["stopRuntimeSession"]
            >,
          }),
      clearSessionResumeCursor,
      listSessions,
      getPersistedSessionProfile:
        input?.getPersistedSessionProfile ?? (() => Effect.succeed(undefined)),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          ...(input?.conversationRollback
            ? { conversationRollback: input.conversationRollback }
            : {}),
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      ...(input?.getClaudeCacheObservation
        ? { getClaudeCacheObservation: input.getClaudeCacheObservation }
        : {}),
      ...(input?.startClaudeCompaction
        ? { startClaudeCompaction: input.startClaudeCompaction }
        : {}),
      ...(input?.cancelClaudeCompactionDiscovery
        ? { cancelClaudeCompactionDiscovery: input.cancelClaudeCompactionDiscovery }
        : {}),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const projectAgentLayer = Layer.succeed(ProjectAgentService, {
      formatContextPacketForTurn: () => Effect.succeed(input?.formatContextPacket ?? ""),
    } as unknown as (typeof ProjectAgentService)["Service"]);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      // Turn dispatch runs on the engine's fibers: the packet lookup reads
      // this environment, mirroring projectAgentServiceLayer provideMerge'd
      // into the reactor in serverLayers.ts.
      Layer.provideMerge(projectAgentLayer),
    );
    const projectAgentRepositoryLayer = Layer.succeed(ProjectAgentRepository, {
      getConfigByCoordinatorThread: (threadId: ThreadId) =>
        Effect.succeed(
          (input?.coordinatorThreadIds ?? []).includes(threadId)
            ? Option.some({
                projectId: asProjectId("project-1"),
                enabled: input?.coordinatorConfigState?.enabled ?? true,
                pausedAt: input?.coordinatorConfigState?.pausedAt ?? null,
                archivedAt: input?.coordinatorConfigState?.archivedAt ?? null,
              })
            : Option.none(),
        ),
    } as unknown as (typeof ProjectAgentRepository)["Service"]);
    const reactorLayer = makeProviderCommandReactorLive(input);
    const layer = Layer.mergeAll(reactorLayer, ProviderRuntimeIngestionLive).pipe(
      Layer.provideMerge(projectAgentLayer),
      Layer.provideMerge(projectAgentRepositoryLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        input?.computerService
          ? Layer.succeed(ComputerService, input.computerService)
          : Layer.empty,
      ),
      Layer.provideMerge(
        input?.gatewaySessions
          ? Layer.succeed(AgentGatewaySessionRegistry, input.gatewaySessions)
          : Layer.empty,
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderHealth, {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([]),
          updateProvider: () => Effect.die("updateProvider unsupported in test"),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape),
      ),
      Layer.provideMerge(Layer.succeed(HubOutputReactor, hubOutputReactor)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          renameBranch,
          publishBranch,
          withMutation,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          ...input?.serverSettings,
          // The resume review is off by default. Harnesses that feed cache
          // observations exercise it, so they turn it on unless a test sets it.
          ...(input?.getClaudeCacheObservation &&
          input.serverSettings?.providers?.claudeAgent?.confirmColdCacheResume === undefined
            ? {
                providers: {
                  ...input.serverSettings?.providers,
                  claudeAgent: {
                    ...input.serverSettings?.providers?.claudeAgent,
                    confirmColdCacheResume: true,
                  },
                },
              }
            : {}),
          ...(input?.gitWritingModelSelection
            ? { textGenerationModelSelection: input.gitWritingModelSelection }
            : {}),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(AgentGatewayOperationRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.add(runtime);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid));
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    // Fault injection for command admission. The reactor resolves
    // `dispatch` off the shared engine service on every call, so swapping the
    // property here is observed by the reactor without rebuilding the layer.
    const engineDispatchTarget = engine as {
      dispatch: OrchestrationEngineShape["dispatch"];
    };
    const passthroughDispatch = engineDispatchTarget.dispatch;
    const interceptEngineDispatch = (
      interceptor: (command: OrchestrationCommand) =>
        | Effect.Effect<
            {
              sequence: number;
            },
            OrchestrationDispatchError
          >
        | undefined,
    ) => {
      engineDispatchTarget.dispatch = (command, context) =>
        interceptor(command) ?? passthroughDispatch(command, context);
    };
    const projectionSnapshotQuery = await runtime.runPromise(
      Effect.service(ProjectionSnapshotQuery),
    );
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const checkpointCoordinator = await runtime.runPromise(
      Effect.service(TurnCheckpointCoordinator),
    );
    const serverSettings = await runtime.runPromise(Effect.service(ServerSettingsService));
    const deliveryRepository = await runtime.runPromise(
      Effect.service(OrchestrationEventDeliveryRepository),
    );
    const queuedTurnPromotionRepository = await runtime.runPromise(
      Effect.service(QueuedTurnPromotionRepository),
    );
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const managedAttachments = await runtime.runPromise(
      Effect.service(ManagedAttachmentRepository),
    );
    const pendingInteractionRepository = await runtime.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );
    const runtimeEventRepository = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository),
    );
    const gatewayOperations = await runtime.runPromise(
      Effect.service(AgentGatewayOperationRepository),
    );
    const harnessScope = await Effect.runPromise(Scope.make("sequential"));
    scopes.add(harnessScope);
    if (input?.ingestRuntimeEvents) {
      const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(harnessScope)));
    }
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      const start = reactor.start.pipe(Scope.provide(harnessScope));
      await Effect.runPromise(
        input?.logMessages
          ? start.pipe(
              Effect.provide(
                Logger.layer(
                  [Logger.make(({ message }) => input.logMessages!.push(String(message)))],
                  { mergeWithExisting: false },
                ),
              ),
            )
          : start,
      );
      reactorStarted = true;
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);
    const restartReactor = async () => {
      await Effect.runPromise(Scope.close(harnessScope, Exit.void));
      const freshScope = await Effect.runPromise(Scope.make("sequential"));
      scopes.add(freshScope);
      const services = await Effect.runPromise(
        Layer.buildWithScope(
          Layer.fresh(reactorLayer).pipe(
            Layer.provide(Layer.succeedServices(await runtime.services())),
          ),
          freshScope,
        ),
      );
      const fresh = ServiceMap.get(services, ProviderCommandReactor);
      return {
        reactor: fresh,
        start: () => Effect.runPromise(fresh.start.pipe(Scope.provide(freshScope))),
      };
    };
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        ...(input?.projectAdditionalFolders
          ? { additionalFolders: input.projectAdditionalFolders }
          : {}),
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        ...(input?.gatewayOperationId
          ? {
              creationSource: "synara_mcp" as const,
              gatewayOperationId: input.gatewayOperationId,
              gatewayOperationIndex: 0,
            }
          : {}),
        createdAt: now,
      }),
    );
    return {
      engine,
      projectionSnapshotQuery,
      seedCompletion: () =>
        runtime!.runPromise(sql`
        INSERT INTO agent_gateway_completions
          (child_thread_id, creator_thread_id, initial_message_id, result_json, delivery_state, created_at)
        VALUES ('delegated-child', 'thread-1', 'delegated-initial', '{"summary":"delegated result","childThreadId":"delegated-child"}', 'delivered', ${new Date().toISOString()})
      `),
      completionState: () =>
        runtime!.runPromise(sql<{
          context_consumed: number;
          context_event_sequence: number | null;
        }>`
        SELECT context_consumed, context_event_sequence FROM agent_gateway_completions WHERE child_thread_id = 'delegated-child'
      `),
      reactor,
      checkpointCoordinator,
      serverSettings,
      startSession,
      startSessionWithOutcome,
      completePriorTranscriptBootstrap,
      pendingPriorTranscriptBootstraps,
      listSessions,
      sendTurn,
      steerTurn,
      startReview,
      forkThread,
      interruptTurn,
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      withMutation,
      generateBranchName,
      generateThreadTitle,
      captureStudioOutputBaseline,
      cancelPendingStudioOutputBaseline,
      stateDir,
      stageAttachment: async (
        attachment: {
          readonly type: "image" | "file";
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        },
        ownerThreadId = "thread-1",
      ) => {
        const flatRelativePath = attachmentRelativePath(attachment);
        const relativePath = attachment.id.startsWith("att_v2_")
          ? `objects/${attachment.id.slice(7, 9)}/${flatRelativePath}`
          : flatRelativePath;
        const attachmentPath = path.join(stateDir, "attachments", relativePath);
        fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
        if (!fs.existsSync(attachmentPath)) {
          fs.writeFileSync(attachmentPath, Buffer.alloc(attachment.sizeBytes));
        }
        const stagedAt = new Date().toISOString();
        await runtime.runPromise(
          managedAttachments
            .reserve({
              attachmentId: attachment.id,
              ownerThreadId,
              ownerKind: "local-loopback",
              ownerId: "local-loopback",
              kind: attachment.type,
              originalName: attachment.name,
              mimeType: attachment.mimeType,
              reservedBytes: attachment.sizeBytes,
              relativePath,
              now: stagedAt,
            })
            .pipe(
              Effect.andThen(
                managedAttachments.finalizeStaged({
                  attachmentId: attachment.id,
                  ownerThreadId,
                  ownerKind: "local-loopback",
                  ownerId: "local-loopback",
                  sizeBytes: attachment.sizeBytes,
                  sha256: "0".repeat(64),
                  stagingExpiresAt: new Date(Date.now() + 60000).toISOString(),
                  now: stagedAt,
                }),
              ),
            ),
        );
        return attachmentPath;
      },
      drain,
      emitRuntimeEvent,
      setRuntimeSessionTurnState,
      startReactor,
      restartReactor,
      deliveryRepository,
      sql,
      pendingInteractionRepository,
      runtimeEventRepository,
      reserveGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.reserve({
            operationId,
            callerThreadId: "caller-thread",
            callerTurnId: "caller-turn",
            operationKind: "create_threads",
            requestId: `request-${operationId}`,
            fingerprint: `fingerprint-${operationId}`,
            requestedCount: 1,
            planJson: "[]",
            now,
          }),
        ),
      markGatewayOperationDispatching: (operationId: string) =>
        runtime.runPromise(gatewayOperations.markDispatching({ operationId, now })),
      completeGatewayOperation: (operationId: string) =>
        runtime.runPromise(
          gatewayOperations.complete({
            operationId,
            resultJson: "{}",
            now: new Date().toISOString(),
          }),
        ),
      persistWithoutLivePublication: async (
        events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
      ) => {
        const persisted: OrchestrationEvent[] = [];
        for (const event of events) {
          const versions = await runtime.runPromise(sql<{
            readonly version: number;
          }>`
            SELECT COALESCE(MAX(stream_version), -1) + 1 AS version
            FROM orchestration_events
            WHERE aggregate_kind = ${event.aggregateKind}
              AND stream_id = ${event.aggregateId}
          `);
          const inserted = await runtime.runPromise(sql<{
            readonly sequence: number;
          }>`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${event.eventId}, ${event.aggregateKind}, ${event.aggregateId},
              ${versions[0]!.version}, ${event.type},
              ${event.occurredAt}, ${event.commandId}, ${event.causationEventId},
              ${event.correlationId}, 'user', ${JSON.stringify(event.payload)},
              ${JSON.stringify(event.metadata)}
            )
            RETURNING sequence
          `);
          const saved = { ...event, sequence: inserted[0]!.sequence } as OrchestrationEvent;
          persisted.push(saved);
          if (saved.type === "thread.message-sent") {
            await runtime.runPromise(sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, is_streaming,
                created_at, updated_at, source, sequence, dispatch_mode
              ) VALUES (
                ${saved.payload.messageId}, ${saved.payload.threadId}, ${saved.payload.turnId},
                ${saved.payload.role}, ${saved.payload.text},
                ${saved.payload.streaming ? 1 : 0}, ${saved.payload.createdAt},
                ${saved.payload.updatedAt}, ${saved.payload.source}, ${saved.sequence},
                ${saved.payload.dispatchMode ?? null}
              )
            `);
          }
        }
        return persisted;
      },
      persistSessionWithoutLivePublication: async (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly updatedAt: string;
      }) =>
        runtime.runPromise(sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, runtime_mode,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${input.threadId}, 'running', 'codex', 'approval-required',
            ${input.turnId}, NULL, ${input.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            status = excluded.status,
            provider_name = excluded.provider_name,
            runtime_mode = excluded.runtime_mode,
            active_turn_id = excluded.active_turn_id,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `),
      queuedTurnPromotionRepository,
      interceptEngineDispatch,
    };
  }
  async function seedRollbackTarget(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`cmd-import-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: input.messageId,
            role: "user",
            text: "rollback target",
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        createdAt: input.createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe(`cmd-assistant-complete-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe(`assistant-${input.messageId}`),
        turnId: input.turnId,
        createdAt: input.createdAt,
      }),
    );
  }
  async function readHarnessThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId = ThreadId.makeUnsafe("thread-1"),
  ) {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    return readModel.threads.find((thread) => thread.id === threadId);
  }
  async function dispatchHarnessUserTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: string;
      readonly text: string;
      readonly createdAt: string;
      readonly threadId?: ThreadId;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly dispatchOrigin?: "user" | "automation" | "agent";
    },
  ) {
    return Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`cmd-${input.messageId}`),
        threadId: input.threadId ?? ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId(input.messageId),
          role: "user",
          text: input.text,
          attachments: input.attachments ?? [],
        },
        ...(input.dispatchOrigin !== undefined ? { dispatchOrigin: input.dispatchOrigin } : {}),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: input.createdAt,
      }),
    );
  }
  async function emitHarnessTurnTerminal(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly eventId: string;
      readonly provider: ProviderKind;
      readonly type: "completed" | "aborted" | "failed" | "cancelled";
      readonly threadId?: ThreadId;
      readonly turnId?: TurnId;
    },
  ) {
    const eventBase = {
      eventId: asEventId(input.eventId),
      provider: input.provider,
      threadId: input.threadId ?? ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: input.turnId ?? asTurnId("turn-1"),
      providerRefs: {},
    } as const;
    await harness.emitRuntimeEvent(
      input.type !== "aborted"
        ? ({
            ...eventBase,
            type: "turn.completed",
            payload: { state: input.type },
          } as ProviderRuntimeEvent)
        : ({
            ...eventBase,
            type: "turn.aborted",
            payload: { reason: "prompt rejected after asynchronous submission" },
          } as ProviderRuntimeEvent),
    );
  }
  // #1900: a full thread detail read (every message plus the whole activity
  // timeline) once ran 18+ times per turn and took seconds on long threads.
  // Drive one scripted turn through command dispatch and runtime ingestion and
  // count the detail reads, so the next hot-path caller that regresses fails here.
  it("drives a scripted turn without full thread detail reads", async () => {
    const harness = await createHarness({ ingestRuntimeEvents: true });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const detailReads = vi.spyOn(harness.projectionSnapshotQuery, "getThreadDetailById");
    const activityFreeDetailReads = vi.spyOn(
      harness.projectionSnapshotQuery,
      "getThreadDetailWithoutActivitiesById",
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "scripted-turn-message",
      text: "Refactor the session store",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    const turnId = asTurnId("scripted-turn");
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: turnId,
    });
    const eventBase = (eventId: string) =>
      ({
        eventId: asEventId(`scripted-turn-${eventId}`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        providerRefs: {},
      }) as const;
    await harness.emitRuntimeEvent({ ...eventBase("started"), type: "turn.started", payload: {} });
    const assistantItems = 5;
    for (let index = 0; index < assistantItems; index += 1) {
      const itemId = RuntimeItemId.makeUnsafe(`scripted-assistant-${index}`);
      await harness.emitRuntimeEvent({
        ...eventBase(`assistant-delta-${index}`),
        type: "content.delta",
        itemId,
        payload: { streamKind: "assistant_text", delta: `Step ${index}.` },
      });
      await harness.emitRuntimeEvent({
        ...eventBase(`assistant-completed-${index}`),
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      });
    }
    // Codex emits a turn diff after every patch, so each file change gets one.
    // Several diff events keep a diff-path regression above the bound below.
    for (let index = 0; index < 3; index += 1) {
      await harness.emitRuntimeEvent({
        ...eventBase(`file-change-${index}`),
        type: "item.completed",
        itemId: RuntimeItemId.makeUnsafe(`scripted-file-change-${index}`),
        payload: {
          itemType: "file_change",
          status: "completed",
          title: "Edited file",
          detail: `src/file-${index}.ts`,
          data: { changes: [{ path: `src/file-${index}.ts`, kind: "update" }] },
        },
      });
      await harness.emitRuntimeEvent({
        ...eventBase(`diff-${index}`),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: [
            `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
            `--- a/src/file-${index}.ts`,
            `+++ b/src/file-${index}.ts`,
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
          ].join("\n"),
        },
      });
    }
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      ...eventBase("completed"),
      type: "turn.completed",
      payload: { state: "completed" },
    });
    await waitFor(
      async () => (await readHarnessThread(harness))?.latestTurn?.state === "completed",
    );
    await harness.drain();
    expect(detailReads).not.toHaveBeenCalled();
    // Turn dispatch builds its bootstrap from messages (1); ingestion reads
    // messages for each assistant completion (K) and the terminal event (1).
    // No slack: one more read per diff event or file change must fail here.
    expect(activityFreeDetailReads.mock.calls.length).toBeGreaterThan(0);
    expect(activityFreeDetailReads.mock.calls.length).toBeLessThanOrEqual(assistantItems + 2);
  });
  it.each([
    { name: "reloads its native session", nativeResume: true, bootstraps: false },
    { name: "cannot reload its native session", nativeResume: false, bootstraps: true },
  ])("bootstraps a Droid model switch only when it $name", async ({ nativeResume, bootstraps }) => {
    const harness = await createHarness({
      threadModelSelection: { provider: "droid", model: "model-a" },
      sessionModelSwitch: "restart-session",
      confirmNativeResume: () => nativeResume,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-droid-model-switch"),
        threadId,
        messages: [
          {
            messageId: asMessageId("droid-switch-earlier-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("droid-switch-earlier-assistant"),
            role: "assistant",
            text: "Earlier answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    for (const [index, model] of ["model-a", "model-b"].entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-droid-model-switch-${index}`),
          threadId,
          message: {
            messageId: asMessageId(`droid-model-switch-user-${index}`),
            role: "user",
            text: `turn on ${model}`,
            attachments: [],
          },
          modelSelection: { provider: "droid", model },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
    }
    expect(harness.startSessionWithOutcome.mock.calls).toHaveLength(2);
    expect(harness.startSessionWithOutcome.mock.calls[1]?.[1]).toMatchObject({
      modelSelection: { provider: "droid", model: "model-b" },
    });
    const switched = harness.sendTurn.mock.calls[1]?.[0] as
      | {
          input?: string;
        }
      | undefined;
    expect(switched?.input?.includes("<thread_context>")).toBe(bootstraps);
    expect(switched?.input).toContain("turn on model-b");
  });
  it.each(["success", "capture-failed", "rollback-failed", "restore-failed"] as const)(
    "preserves edit replay recovery when %s",
    async (mode) => {
      const deletedRefs = vi.fn<CheckpointStoreShape["deleteCheckpointRefs"]>(() => Effect.void);
      const harness = await createHarness({
        checkpointStore: { deleteCheckpointRefs: deletedRefs },
      });
      const operations: string[] = [];
      const gitFailure = () =>
        new GitCommandError({
          operation: "test.edit-recovery",
          cwd: "/tmp/provider-project",
          command: "git",
          detail: mode,
        });
      harness.captureCheckpoint.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("capture");
          return mode === "capture-failed" ? Effect.fail(gitFailure()) : Effect.void;
        }),
      );
      harness.rollbackConversation.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("rollback");
          return mode === "rollback-failed"
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread/rollback",
                  detail: mode,
                }),
              )
            : Effect.void;
        }),
      );
      harness.restoreCheckpoint.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("restore");
          return mode === "restore-failed" ? Effect.fail(gitFailure()) : Effect.succeed(true);
        }),
      );
      const now = new Date().toISOString();
      harness.isGitRepository.mockImplementationOnce(() => Effect.succeed(true));
      await seedRollbackTarget(harness, {
        messageId: asMessageId("user-message-checkpoint-edit"),
        turnId: asTurnId("turn-checkpoint-edit"),
        createdAt: now,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe("cmd-checkpoint-edit-complete"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("turn-checkpoint-edit"),
          completedAt: now,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
          status: "ready",
          files: [],
          assistantMessageId: asMessageId("assistant-user-message-checkpoint-edit"),
          checkpointTurnCount: 1,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.edit-and-resend",
          commandId: CommandId.makeUnsafe("cmd-edit-checkpoint-resend"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: asMessageId("user-message-checkpoint-edit"),
          text: "edited checkpoint prompt",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      if (mode === "success") {
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.restoreCheckpoint).toHaveBeenCalledWith({
          cwd: "/tmp/provider-project",
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
          fallbackToHead: true,
        });
        expect(operations).toEqual(["capture", "rollback", "restore"]);
      } else {
        await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (mode === "capture-failed") {
          expect(harness.rollbackConversation).not.toHaveBeenCalled();
          expect(harness.restoreCheckpoint).not.toHaveBeenCalled();
        }
        expect((await readHarnessThread(harness))?.session?.lastError).toContain(mode);
      }
      expect(deletedRefs).not.toHaveBeenCalled();
      const rescueRef = harness.captureCheckpoint.mock.calls[0]?.[0].checkpointRef;
      expect(rescueRef).toContain("/revert-rescue/");
      expect((await readHarnessThread(harness))?.activities).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "checkpoint.edit-replay.snapshot" }),
        ]),
      );
    },
  );
  it("retains a discoverable file recovery snapshot across edit replay and store restart", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-edit-replay-recovery-"));
    createdBaseDirs.add(cwd);
    const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "baseline\n");
    git(["add", "."]);
    git(["commit", "-m", "Initial"]);
    const storeLayer = CheckpointStoreLive.pipe(
      Layer.provide(
        GitCoreLive.pipe(
          Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-edit-replay-recovery-" })),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    const firstRuntime = ManagedRuntime.make(storeLayer);
    runtimes.add(firstRuntime);
    const store = await firstRuntime.runPromise(Effect.service(CheckpointStore));
    const harness = await createHarness({ checkpointStore: store });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("edit-recovery-real-project"),
        projectId: asProjectId("project-1"),
        workspaceRoot: cwd,
      }),
    );
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-edit-recovery-real"),
      turnId: asTurnId("turn-edit-recovery-real"),
      createdAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("edit-recovery-real-checkpoint"),
        threadId,
        turnId: asTurnId("turn-edit-recovery-real"),
        completedAt: now,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [],
        assistantMessageId: asMessageId("assistant-user-edit-recovery-real"),
        checkpointTurnCount: 1,
        createdAt: now,
      }),
    );
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "user changed this after the turn\n");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "unsaved elsewhere\n");
    let refsBeforeRollback = "";
    harness.rollbackConversation.mockImplementation(() =>
      Effect.sync(() => {
        refsBeforeRollback = git([
          "for-each-ref",
          "--format=%(refname)",
          "refs/synara/checkpoints",
        ]);
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("edit-recovery-real-resend"),
        threadId,
        messageId: asMessageId("user-edit-recovery-real"),
        text: "edited checkpoint prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // Provider history can be trimmed only after durable file recovery exists.
    expect(refsBeforeRollback).toContain("/revert-rescue/");
    expect(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8")).toBe("baseline\n");
    expect(fs.existsSync(path.join(cwd, "untracked.txt"))).toBe(false);
    const rescueRefs = git(["for-each-ref", "--format=%(refname)", "refs/synara/checkpoints"])
      .trim()
      .split("\n")
      .filter(
        (ref) => ref.includes("/revert-rescue/") && isManagedCheckpointRefForThread(ref, threadId),
      );
    expect(rescueRefs).toHaveLength(1);
    await firstRuntime.dispose();
    runtimes.delete(firstRuntime);
    const reopenedRuntime = ManagedRuntime.make(storeLayer);
    runtimes.add(reopenedRuntime);
    await reopenedRuntime.runPromise(
      Effect.gen(function* () {
        const reopenedStore = yield* CheckpointStore;
        expect(
          yield* reopenedStore.restoreCheckpoint({
            cwd,
            checkpointRef: CheckpointRef.makeUnsafe(rescueRefs[0]!),
          }),
        ).toBe(true);
      }),
    );
    expect(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8")).toBe(
      "user changed this after the turn\n",
    );
    expect(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8")).toBe("unsaved elsewhere\n");
    expect((await readHarnessThread(harness))?.activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "checkpoint.edit-replay.snapshot" }),
      ]),
    );
  });
  for (const interveningEvent of [false, true]) {
    it(`restores only its own optimistic state after a busy Claude rejection (concurrent event: ${interveningEvent})`, async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      const send = (
        id: string,
        options?: {
          autoCompactWindow: string;
        },
      ) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text: "continue", attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
          ...(options
            ? {
                modelSelection: {
                  provider: "claudeAgent" as const,
                  model: "claude-fable-5-1",
                  options,
                },
              }
            : {}),
        });
      await Effect.runPromise(send("bootstrap-busy"));
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const prior = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!.session!;
      harness.sendTurn.mockClear();
      harness.startSession.mockImplementationOnce(() =>
        Effect.gen(function* () {
          if (interveningEvent) {
            yield* harness.engine
              .dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe("late-runtime-event"),
                threadId,
                session: {
                  ...prior,
                  status: "running",
                  activeTurnId: asTurnId("late-turn"),
                  updatedAt: "2099-01-01T00:00:00.000Z",
                },
                createdAt: "2099-01-01T00:00:00.000Z",
              })
              .pipe(Effect.orDie);
          }
          return yield* new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "session/reconfigure",
            issue: "Background work is active",
          });
        }),
      );
      await Effect.runPromise(send("rejected-busy", { autoCompactWindow: "200k" }));
      await harness.drain();
      const after = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!.session!;
      expect(after).toMatchObject(
        interveningEvent
          ? { status: "running", activeTurnId: "late-turn" }
          : {
              status: "ready",
              activeTurnId: null,
              runtimeMode: prior.runtimeMode,
              lastError: "Your message was not sent. Background work is active",
            },
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
    });
  }
  describe("same-thread provider handoff", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    async function runFirstGrokTurn(harness: Awaited<ReturnType<typeof createHarness>>) {
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-handoff-turn-1"),
          threadId,
          message: {
            messageId: asMessageId("user-message-handoff-1"),
            role: "user",
            text: "first turn on grok",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-handoff-session-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "grok",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    }
    const dispatchHandoff = (harness: Awaited<ReturnType<typeof createHarness>>) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-handoff-to-claude"),
          threadId,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          providerHandoff: true,
        }),
      );
    const sendSecondTurn = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      enableComputerControl?: boolean,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-handoff-turn-2"),
          threadId,
          message: {
            messageId: asMessageId("user-message-handoff-2"),
            role: "user",
            text: "continue after the handoff",
            attachments: [],
          },
          ...(enableComputerControl !== undefined ? { enableComputerControl } : {}),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
    it.each(["successful", "timed-out"] as const)(
      "settles a %s handoff after its durable write exceeds the provider deadline",
      async (result) => {
        const harness = await createHarness({
          threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
          commandEventTimeout: Duration.millis(300),
        });
        await runFirstGrokTurn(harness);
        if (result === "timed-out") {
          harness.startSession.mockImplementationOnce(() => Effect.never);
        }
        const settlementEntered = Deferred.makeUnsafe<void>();
        const releaseSettlement = Deferred.makeUnsafe<void>();
        const dispatch = harness.engine.dispatch;
        const settlementCommandId =
          result === "successful"
            ? "server:provider-handoff-meta:cmd-handoff-to-claude"
            : "server:provider-handoff-revert:cmd-handoff-to-claude";
        harness.interceptEngineDispatch((command) => {
          if (command.commandId !== settlementCommandId) return undefined;
          // Hold the real engine write after the bounded native phase. The
          // claim cannot be acknowledged or quarantined while this known
          // handoff outcome is still waiting for durable settlement.
          return Deferred.succeed(settlementEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSettlement)),
            Effect.andThen(Effect.suspend(() => dispatch(command))),
          );
        });
        const handoff = await dispatchHandoff(harness);
        const deliveryKey = {
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: handoff.sequence,
        };
        try {
          await waitFor(() => Effect.runPromise(Deferred.isDone(settlementEntered)));
          // Cross the configured 300ms provider deadline after the settlement
          // has begun; this does not grant more time to provider startup.
          await new Promise((resolve) => setTimeout(resolve, 350));
          const pending = Option.getOrThrow(
            await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
          );
          expect(pending).toMatchObject({ state: "inflight", attemptCount: 1 });
          const cursor = Option.getOrThrow(
            await Effect.runPromise(
              harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
            ),
          );
          expect(cursor.lastAckedSequence).toBeLessThan(handoff.sequence);
        } finally {
          await Effect.runPromise(Deferred.succeed(releaseSettlement, undefined));
        }
        await waitFor(async () => {
          const delivery = Option.getOrThrow(
            await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
          );
          return delivery.state === "succeeded";
        });
        const thread = await readHarnessThread(harness);
        const expectedProvider = result === "successful" ? "claudeAgent" : "grok";
        expect(thread?.modelSelection.provider).toBe(expectedProvider);
        expect(
          thread?.activities.filter((activity) => activity.kind.startsWith("provider.handoff")),
        ).toMatchObject([
          {
            kind: result === "successful" ? "provider.handoff" : "provider.handoff.failed",
          },
        ]);
        await sendSecondTurn(harness);
        await waitFor(() => harness.sendTurn.mock.calls.length === 2);
        expect(harness.sendTurn.mock.calls[1]?.[0].modelSelection?.provider).toBe(expectedProvider);
        expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");
      },
    );
    it("does not replay a handoff when its durable outcome cannot be persisted", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      let settlementAttempts = 0;
      harness.interceptEngineDispatch((command) => {
        if (command.commandId !== "server:provider-handoff-meta:cmd-handoff-to-claude") {
          return undefined;
        }
        settlementAttempts += 1;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "provider-handoff-outcome",
            detail: "Injected durable outcome write failure.",
          }),
        );
      });
      const handoff = await dispatchHandoff(harness);
      const deliveryKey = {
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: handoff.sequence,
      };
      await waitFor(async () => {
        const delivery = Option.getOrUndefined(
          await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
        );
        return (
          delivery?.state === "uncertain" ||
          delivery?.state === "dead" ||
          delivery?.state === "succeeded"
        );
      });
      await harness.drain();
      expect(
        Option.getOrThrow(
          await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
        ),
      ).toMatchObject({ state: "uncertain", attemptCount: 1 });
      expect(settlementAttempts).toBe(1);
      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.clearSessionResumeCursor).toHaveBeenCalledTimes(1);
      expect(
        (await readHarnessThread(harness))?.activities.some((activity) =>
          activity.kind.startsWith("provider.handoff"),
        ),
      ).toBe(false);
    });
  });
  it.each(["opencode", "devin", "grok"] as const)(
    "injects transcript context when %s rejects the persisted resume cursor",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
        confirmNativeResume: () => false,
      });
      const now = new Date().toISOString();
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-rejected-resume-seed`,
        text: "The retained codename is heliotrope.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(
        harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-rejected-resume-follow-up`,
        text: "What is the retained codename?",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const followUpInput = harness.sendTurn.mock.calls[1]?.[0] as {
        readonly input?: string;
      };
      expect(followUpInput.input).toContain("<thread_context>");
      expect(followUpInput.input).toContain("The retained codename is heliotrope.");
      expect(followUpInput.input?.match(/What is the retained codename\?/g)).toHaveLength(1);
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);
      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-rejected-resume-bootstrap-completed`,
        provider,
        type: "completed",
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        payload: {
          provider,
          nativeHistory: "unavailable",
          sessionRestarted: true,
          restartReason: "native-resume-failed",
          recapInjected: true,
        },
      });
    },
  );
});
