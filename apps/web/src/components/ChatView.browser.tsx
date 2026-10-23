// Upstream fixtures assert English labels; Aha's production default is Chinese.
// Keep these behavior fixtures in their declared locale; Aha appearance fixtures
// exercise the real provider, skin state and language separately.
vi.mock("../aha/AppearanceProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aha/AppearanceProvider")>()),
  useAhaTranslation: () => (text: string) => text,
}));
// Production CSS is part of the behavior under test because row height depends on it.
import {
  type AutomationCreateInput,
  type AutomationDefinition,
  AutomationId,
  COMPUTER_WS_METHODS,
  CheckpointRef,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  DEVICE_WS_METHODS,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  OrchestrationSessionStatus,
  type ProjectId,
  type ServerConfig,
  SpaceId,
  ThreadId,
  TurnId,
  WS_METHODS,
  type WsWelcomePayload,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import "../index.css";
import { useKanbanUiStore } from "../kanbanUiStore";
import { useLatestProjectStore } from "../latestProjectStore";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { hasActiveComposerSend } from "../lib/composerSendOwnership";
import { dispatchKanbanDraftThread } from "../lib/kanbanDispatch";
import { resetQueuedComposerDrainForTests } from "../lib/queuedComposerDrain";
import { getWorkspaceEditorSession } from "../lib/workspaceEditorSession";
import { readNativeApi } from "../nativeApi";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useRightDockStore } from "../rightDockStore";
import { getRouter } from "../router";
import { useSpacesUiStore } from "../spacesUiStore";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
  createFullscreenTestHost,
} from "../test/browserHarness";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { emitWsTransportState } from "../wsTransportEvents";
import { useThreadDispatchStore } from "./chat/useChatLocalDispatch";
// Pre-transform the compiler-heavy component outside the first case's timeout.
// The router's auto-split route otherwise requests this module on first mount.
import "./ChatView";
const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;
// Each call to the snapshot factory gets a fresh, monotonically increasing sequence.
// The step (1_000_000) is far larger than any single test can bridge: in-test
// increments come only from `recordProjectCreateCommand`, `addThreadToSnapshot`, and
// the per-test snapshot-sync helpers, each +1 per call and bounded by waitFor-driven
// helper invocations (hundreds at most). So a late in-flight shell snapshot from a
// previous test is always strictly below the next test's base sequence and is ignored
// by `isStaleSnapshot`.
let snapshotSequenceFactory = 0;
function nextSnapshotSequence(): number {
  snapshotSequenceFactory += 1000000;
  return snapshotSequenceFactory;
}
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;
let attachmentUploadSequence = 0;
let attachmentUploadBarrier: Promise<void> | null = null;
let attachmentCancelBarrier: Promise<void> | null = null;
interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}
interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  providerStatusesSnapshot: ServerConfig["providers"] | null;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
  projectAgentOverviews: Record<string, unknown>;
}
let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);
interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}
const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1100,
};
interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
}
interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}
interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}
function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1000).toISOString();
}
function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}
function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}
function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}
function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}
function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];
  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;
    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }
  return {
    snapshotSequence: nextSnapshotSequence(),
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId:
            options.sessionStatus === "running"
              ? TurnId.makeUnsafe("turn-browser-fixture-active")
              : null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}
function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });
  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }
  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }
  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };
  return {
    ...snapshot,
    threads,
  };
}
function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    providerStatusesSnapshot: null,
    gitBranchByCwd: {},
    projectAgentOverviews: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}
function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}
function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}
function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopAfterConsecutiveFailures:
      input.stopAfterConsecutiveFailures === undefined
        ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES
        : input.stopAfterConsecutiveFailures,
    consecutiveFailureCount: 0,
    disabledReason: null,
    disabledAt: null,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}
function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}
function withSettledThreadBranch(
  snapshot: OrchestrationReadModel,
  branch: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, branch, settledAt: NOW_ISO } : thread,
    ),
  };
}
function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}
function withActiveHomeChatThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithHomeProject = withHomeChatProject(snapshot);
  return {
    ...snapshotWithHomeProject,
    threads: snapshotWithHomeProject.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, projectId: HOME_PROJECT_ID } : thread,
    ),
  };
}
function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1000),
              startedAt: isoAt(1001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1003),
                }
              : null,
            updatedAt: isoAt(1003),
          }
        : thread,
    ),
  };
}
function createSnapshotWithTallComposerStack(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            checkpoints: [
              {
                turnId: activeTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.makeUnsafe("checkpoint-inline-plan"),
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    kind: "modified",
                    additions: 12,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.browser.tsx",
                    kind: "modified",
                    additions: 36,
                    deletions: 0,
                  },
                ],
                assistantMessageId: null,
                completedAt: isoAt(1004),
              },
            ],
          }
        : thread,
    ),
  };
}
function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }
  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}
function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getInlineVisual) {
    return {
      visualId: body.visualId,
      html: JSON.stringify({
        blocks: [
          {
            type: "choices",
            options: [
              { label: "Visual follow up", message: "Follow up from visual" },
              { label: "Wait" },
            ],
          },
        ],
      }),
    };
  }
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetSettings) {
    return createBrowserTestServerSettings(NOW_ISO);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.providerListModels) {
    // Keep the full-app fixture contract-valid and neutral. Returning the
    // generic `{}` fallback makes real discovery retry malformed responses,
    // which leaks unrelated retry pressure across this file's many mounts.
    return { models: [], source: "unsupported", cached: false };
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  // The sidebar reads to-dos on Beta hosts; the `{}` fallback would fail to decode.
  if (tag === WS_METHODS.todoList) {
    return { todos: [] };
  }
  // The Code review badge shares the inbox list; keep its background read contract-valid.
  if (tag === WS_METHODS.githubInboxList) {
    return {
      viewer: null,
      items: [],
      errors: [],
      repositoryBatches: [],
      rateLimit: null,
      reviewRequestedCount: 0,
      reviewRequestedCountIncomplete: false,
    };
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.gitCreateDetachedWorktree) {
    return {
      worktree: {
        path: "/repo/.codex/worktrees/generated/synara",
        ref: "0123456789abcdef0123456789abcdef01234567",
        branch: typeof body.newBranch === "string" ? body.newBranch : null,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.projectAgentListTasks) return { tasks: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListActivity) return { activity: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListDocuments) return { documents: [] };
  if (tag === WS_METHODS.projectAgentListThreadIndex) return { threads: [] };
  if (tag === WS_METHODS.projectAgentGetOverview) {
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    return fixture.projectAgentOverviews[projectId] ?? {};
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (
    tag === WS_METHODS.shellOpenInEditor ||
    tag === WS_METHODS.terminalWrite ||
    tag === WS_METHODS.terminalClose
  ) {
    return null;
  }
  return {};
}
const turnStartText = (request: (typeof wsRequests)[number]): string | null =>
  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
  typeof request.command === "object" &&
  request.command !== null &&
  "type" in request.command &&
  request.command.type === "thread.turn.start" &&
  "message" in request.command &&
  typeof request.command.message === "object" &&
  request.command.message !== null &&
  "text" in request.command.message &&
  typeof request.command.message.text === "string"
    ? request.command.message.text
    : null;
function installDeterministicSendNativeApi(options?: {
  rejectTurnStart?: boolean;
  beforeWorktreeCreation?: () => Promise<void>;
  beforeTurnStart?: () => Promise<void>;
  projectThreadCommands?: boolean;
}): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      git: {
        ...wsNativeApi.git,
        createDetachedWorktree: async (
          input: Parameters<typeof wsNativeApi.git.createDetachedWorktree>[0],
        ) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateDetachedWorktree,
            ...input,
          };
          wsRequests.push(request);
          await options?.beforeWorktreeCreation?.();
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createDetachedWorktree>
          >;
        },
      },
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          if (command.type === "thread.turn.start") await options?.beforeTurnStart?.();
          if (options?.rejectTurnStart && command.type === "thread.turn.start") {
            throw new Error("Turn start failed for test.");
          }
          if (options?.projectThreadCommands && command.type === "project.create") {
            recordProjectCreateCommand(command);
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          if (options?.projectThreadCommands && command.type === "thread.create") {
            const snapshot = addThreadToSnapshot(fixture.snapshot, command.threadId);
            fixture.snapshot = {
              ...snapshot,
              threads: snapshot.threads.map((thread) =>
                thread.id === command.threadId
                  ? { ...thread, ...command, id: command.threadId, session: null }
                  : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          if (options?.projectThreadCommands && command.type === "thread.meta.update") {
            const patch = Object.fromEntries(
              Object.entries(command).filter(([, value]) => value !== undefined),
            );
            fixture.snapshot = {
              ...fixture.snapshot,
              snapshotSequence: fixture.snapshot.snapshotSequence + 1,
              threads: fixture.snapshot.threads.map((thread) =>
                thread.id === command.threadId ? { ...thread, ...patch } : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });
  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}
function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}
const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;
      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerProviderStatuses) {
        if (fixture.providerStatusesSnapshot) {
          sendEffectRpcChunk(client, parsed.request.id, {
            providers: fixture.providerStatusesSnapshot,
          });
        }
        return;
      }
      if (
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeServerKeepAwake ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        method === WS_METHODS.subscribeTodoEvents ||
        // Left open like the rest: these are infinite subscriptions, and the
        // default below answers with an Exit, which a stream RPC reads as the
        // socket dying and answers with a full reconnect. That loops forever
        // and starves the RPCs these tests are actually asserting on.
        method === DEVICE_WS_METHODS.subscribeEvents ||
        method === COMPUTER_WS_METHODS.subscribeEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    await attachmentUploadBarrier;
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, async () => {
    await attachmentCancelBarrier;
    return HttpResponse.json({ cancelled: true }, { status: 200 });
  }),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);
async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}
async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}
async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4000,
      interval: 16,
    },
  );
}
async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}
async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8000, interval: 16 },
  );
  return pathname;
}
function queryComposerShell(): HTMLElement {
  return document.querySelector<HTMLElement>(
    'form[data-chat-composer-form="true"] .chat-composer-shell',
  )!;
}
async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}
async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}
function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}
async function waitForWorktreeCheckbox(): Promise<HTMLElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>('[data-empty-landing-controls] [data-slot="checkbox"]'),
    "Unable to find the Worktree checkbox.",
  );
}
async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}
async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8000,
      interval: 16,
    },
  );
  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();
  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4000,
      interval: 16,
    },
  );
  return { measuredRowHeightPx, timelineWidthMeasuredPx };
}
async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );
  await waitForLayout();
  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}
async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );
  await vi.waitFor(
    () => {
      expect(
        options.host.querySelector("[data-chat-composer-form='true']"),
        "Chat composer did not mount.",
      ).toBeTruthy();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig),
        "Browser RPC configuration did not load.",
      ).toBe(true);
      if (!expectedThread) return;
      const state = useStore.getState();
      expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
      const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
      expect(
        expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
        "Active thread detail did not hydrate.",
      ).toBe(true);
    },
    { timeout: 20000, interval: 16 },
  );
  await waitForLayout();
}
async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
  onRender?: ProfilerOnRenderCallback;
  strictMode?: boolean;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();
  const host = createFullscreenTestHost();
  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;
  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );
  const content = options.onRender ? (
    <Profiler id="issue-550-root" onRender={options.onRender}>
      <RouterProvider router={router} />
    </Profiler>
  ) : (
    <RouterProvider router={router} />
  );
  const screen = await render(
    options.strictMode ? <React.StrictMode>{content}</React.StrictMode> : content,
    {
      container: host,
    },
  );
  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
    // React Query retries and background refetches outlive the unmounted tree.
    // A leftover provider-discovery retry can recreate the websocket API inside
    // the next test's beforeEach reset window, before that test configures its
    // fixture; the transport then caches the neutral fixture's welcome, which
    // onServerWelcome replays, so the next mount never receives its workspace
    // paths. Cancel and drop this mount's queries so nothing outlives the test.
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
  };
  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}
const unhandledBrowserErrors: string[] = [];
const captureBrowserError = (event: ErrorEvent) => {
  if (event.message) unhandledBrowserErrors.push(event.message);
};
describe("ChatView transcript geometry (full app)", () => {
  beforeAll(async () => {
    window.addEventListener("error", captureBrowserError);
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });
  afterAll(async () => {
    window.removeEventListener("error", captureBrowserError);
    await resetWsNativeApiForTest();
    await worker.stop();
  });
  beforeEach(async () => {
    unhandledBrowserErrors.length = 0;
    // Reset the shared fixture snapshot to a neutral, low-sequence shell before
    // disposing the old transport. Any in-flight getShellSnapshot that resolves
    // after this point will then return sequence 0, which the next test's real
    // snapshot will supersede.
    fixture = buildFixture({
      ...fixture.snapshot,
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [],
      updatedAt: NOW_ISO,
    });
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    resetQueuedComposerDrainForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    attachmentResponseDelayMs = 0;
    attachmentUploadSequence = 0;
    attachmentUploadBarrier = null;
    attachmentCancelBarrier = null;
    localStorage.clear();
    acknowledgeStartupAnnouncementsForTest(createBaseServerConfig());
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    useRightDockStore.setState({ dockStateByThreadId: {} });
    useOpenThreadTabsStore.setState({ threadIds: [] });
    useThreadDispatchStore.setState({ threads: {} });
    useLatestProjectStore.setState({ latestProjectId: null });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      groupsWorkspaceRoot: null,
    });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailSyncById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });
  afterEach(async () => {
    await resetHomeChatProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
    expect(unhandledBrowserErrors).toEqual([]);
  });
  it.each([false, true])(
    "flushes editor changes before sending and preserves the prompt on failure=%s",
    async (failSave) => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithLongAssistantResponse(),
      });
      let unsubscribe = () => {};
      try {
        let finish!: () => void;
        const writeFile = vi.fn(
          () =>
            new Promise<{
              relativePath: string;
              version: string;
            }>((resolve, reject) => {
              finish = () =>
                failSave
                  ? reject(new Error("Editor write failed"))
                  : resolve({ relativePath: "file.ts", version: "sha256:saved" });
            }),
        );
        const api = readNativeApi()!;
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: { ...api, projects: { ...api.projects, writeFile } },
        });
        const session = getWorkspaceEditorSession(
          mounted.router.options.context.queryClient,
          "/repo/project",
          "file.ts",
        );
        unsubscribe = session.subscribe(() => undefined);
        session.load({
          relativePath: "file.ts",
          contents: "original",
          version: "sha256:initial",
          encoding: "utf8",
          lineEnding: "lf",
          truncated: false,
        });
        session.change("editor draft");
        const prompt = "use the saved editor changes";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        const turnStarts = () =>
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (
                request.command as
                  | {
                      type?: string;
                    }
                  | undefined
              )?.type === "thread.turn.start",
          );
        const before = turnStarts().length;
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
        expect(turnStarts()).toHaveLength(before);
        finish();
        if (failSave) {
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain("Could not save editor changes"),
          );
          expect(turnStarts()).toHaveLength(before);
          expect(session.getSnapshot().value).toBe("editor draft");
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);
        } else {
          await vi.waitFor(() => expect(turnStarts()).toHaveLength(before + 1));
          expect(session.dirty).toBe(false);
        }
      } finally {
        unsubscribe();
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );
  it("restores a settled thread branch when turn start fails", async () => {
    // Metadata acknowledgements must project into the fixture too, otherwise
    // background shell refreshes can overwrite the rollback with stale state.
    const restoreNativeApi = installDeterministicSendNativeApi({
      rejectTurnStart: true,
      projectThreadCommands: true,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSettledThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-settled-branch-failed-send" as MessageId,
          targetText: "settled branch failed send",
        }),
        "feature/finished",
      ),
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });
    try {
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "retry after failed turn start");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8000,
        interval: 16,
      });
      wsRequests.length = 0;
      sendButton.click();
      await vi.waitFor(
        () => {
          const branchUpdates = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.meta.update" && "branch" in command)
            .map((command) => command?.branch);
          expect(branchUpdates).toEqual(["feature/current", "feature/finished"]);
          expect(useStore.getState().threadShellById?.[THREAD_ID]?.branch).toBe("feature/finished");
        },
        { timeout: 8000, interval: 16 },
      );
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "retry after failed turn start",
      );
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });
  it("keeps a started thread's composer on one row until the draft needs more", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-single-row-composer"),
        targetText: "Single row composer",
      }),
    });
    try {
      const editor = await waitForComposerEditor();
      const shell = queryComposerShell;
      await vi.waitFor(() => expect(shell().dataset.composerLayout).toBe("row"));
      // Permission, model and context sit in the row under the composer, not in the pill.
      const statusRow = document.querySelector<HTMLElement>("[data-chat-composer-status-row]");
      expect(statusRow).not.toBeNull();
      expect(shell().contains(statusRow)).toBe(false);
      await userEvent.click(editor);
      // Short enough to fit the row's editor slot at any column width.
      await userEvent.keyboard("ok");
      expect(shell().dataset.composerLayout).toBe("row");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}Second line");
      await vi.waitFor(() => expect(shell().dataset.composerLayout).toBeUndefined());
      expect(document.activeElement).toBe(editor);
      await userEvent.clear(editor);
      await userEvent.keyboard("ok");
      await vi.waitFor(() => expect(shell().dataset.composerLayout).toBe("row"));
      expect(document.activeElement).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps long branch controls separate from the model in a narrow editor chat", async () => {
    const longBranch =
      "feature/verify-the-composer-in-a-very-narrow-editor-sidebar-with-a-long-branch-name";
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-narrow-composer-branch"),
      targetText: "Narrow editor composer",
    });
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 720 },
      strictMode: true,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            options: { effort: "high" },
          },
          session: { ...thread.session!, providerName: "claudeAgent" },
        })),
      },
      initialEntry: `/${THREAD_ID}?view=editor`,
      configureFixture: (state) => {
        state.gitBranchByCwd["/repo/project"] = longBranch;
      },
    });
    try {
      await waitForComposerEditor();
      const row = document.querySelector<HTMLElement>("[data-chat-composer-status-row]")!;
      const branch = row.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!;
      const model = page
        .getByRole("button", { name: "Change model and reasoning", exact: true })
        .element();
      await vi.waitFor(() => expect(branch.textContent).toContain(longBranch));
      const branchRect = branch.getBoundingClientRect();
      const modelRect = model.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      expect(branchRect.width).toBeGreaterThan(48);
      expect(branch.scrollWidth).toBeLessThanOrEqual(branch.clientWidth + 1);
      expect(branchRect.left).toBeGreaterThanOrEqual(rowRect.left);
      expect(branchRect.right).toBeLessThanOrEqual(rowRect.right);
      expect(modelRect.right).toBeLessThanOrEqual(rowRect.right);
      expect(branchRect.right <= modelRect.left || branchRect.bottom <= modelRect.top).toBe(true);
      await userEvent.fill(page.getByTestId("composer-editor"), "Bozza breve");
      await page.getByRole("button", { name: "Composer extras", exact: true }).click();
      await expect
        .element(page.getByRole("option", { name: "Files and folders", exact: true }))
        .toBeVisible();
      await page.getByRole("option", { name: "Plan mode Turn plan mode on", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps the row under the composer aligned while the Environment card is docked", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1400 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-status-row-inset"),
        targetText: "Status row inset",
      }),
    });
    try {
      await waitForComposerEditor();
      const shell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      )!;
      const statusRow = document.querySelector<HTMLElement>("[data-chat-composer-status-row]")!;
      const expectRowUnderComposer = () => {
        const shellRect = shell.getBoundingClientRect();
        const rowRect = statusRow.getBoundingClientRect();
        expect(Math.abs(rowRect.left - shellRect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(rowRect.right - shellRect.right)).toBeLessThanOrEqual(1);
      };
      expectRowUnderComposer();
      const shellRightBefore = shell.getBoundingClientRect().right;
      // Toggling docks or undocks the card (its open state may carry over from earlier
      // tests); either way one of the two states carries the inset, and the row must
      // match the composer in both.
      await page.getByRole("button", { name: "Toggle environment panel", exact: true }).click();
      await vi.waitFor(
        () => {
          expect(Math.abs(shell.getBoundingClientRect().right - shellRightBefore)).toBeGreaterThan(
            20,
          );
          expectRowUnderComposer();
        },
        { timeout: 4000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps queued follow-ups when you switch threads and come back", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
          expect(document.body.textContent).toContain("Steer");
          expect(document.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
        },
        { timeout: 8000, interval: 16 },
      );
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8000, interval: 16 },
      );
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("editing a queued follow-up removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-edit-queue" as MessageId,
        targetText: "running edit queue target",
        sessionStatus: "running",
      }),
    });
    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8000, interval: 16 },
      );
      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      await page.getByRole("button", { name: "Steer", exact: true }).first().hover();
      await expect
        .element(page.getByText("Send this follow-up now to redirect the current work."))
        .toHaveTextContent(
          "Send this follow-up now to redirect the current work. If native steering is unavailable, stop the current turn and start a new one.",
        );
      expect(
        document.querySelectorAll('button[aria-label="Delete queued follow-up"]'),
      ).toHaveLength(2);
      actionButtons[0]?.click();
      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued follow-up",
          ) ?? null,
        "Unable to find edit queued follow-up menu item.",
      );
      expect(document.querySelectorAll('[data-slot="menu-item"]')).toHaveLength(1);
      editMenuItem.click();
      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });
    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // Queue drained...
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
          // ...but the in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
  it("auto-dispatches only the queue head until the previous turn is live", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const firstQueuedPrompt = "queued follow-up A stays the only dispatch";
    const secondQueuedPrompt = "queued follow-up B must wait for the live turn";
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-queued-gap-target" as MessageId,
      targetText: "queued gap target",
      sessionStatus: "running",
    });
    const enqueueQueuedChatTurn = (id: string, prompt: string) => {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id,
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: prompt,
        prompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
    };
    const turnStartCommands = () =>
      wsRequests.flatMap((request) => {
        if (request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return [];
        }
        const command = request.command;
        if (
          typeof command !== "object" ||
          command === null ||
          !("type" in command) ||
          command.type !== "thread.turn.start"
        ) {
          return [];
        }
        return [
          command as {
            threadId?: unknown;
            message?: {
              messageId?: unknown;
              text?: unknown;
            };
          },
        ];
      });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });
    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };
    try {
      enqueueQueuedChatTurn("queued-turn-gap-a", firstQueuedPrompt);
      enqueueQueuedChatTurn("queued-turn-gap-b", secondQueuedPrompt);
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8000, interval: 16 },
      );
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1200),
            }
          : null,
        updatedAt: isoAt(1200),
      }));
      const firstCommand = await vi.waitFor(
        () => {
          const match = turnStartCommands().find((command) =>
            String(command.message?.text ?? "").includes(firstQueuedPrompt),
          );
          expect(match, "first queued turn should auto-dispatch").toBeTruthy();
          return match!;
        },
        { timeout: 8000, interval: 16 },
      );
      const sentMessageId = String(firstCommand.message?.messageId ?? "");
      expect(sentMessageId, "dispatched user message id").not.toBe("");
      const requestedTurnId = TurnId.makeUnsafe("turn-queued-gap");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: firstQueuedPrompt,
            turnId: requestedTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1300),
            updatedAt: isoAt(1300),
          },
        ],
        latestTurn: {
          turnId: requestedTurnId,
          state: "running",
          requestedAt: isoAt(1300),
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1300),
            }
          : null,
        updatedAt: isoAt(1300),
      }));
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 500);
      });
      expect(turnStartCommands()).toHaveLength(1);
      expect(String(turnStartCommands()[0]?.message?.text ?? "")).toContain(firstQueuedPrompt);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: thread.latestTurn
          ? {
              ...thread.latestTurn,
              startedAt: isoAt(1301),
            }
          : thread.latestTurn,
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: requestedTurnId,
              updatedAt: isoAt(1301),
            }
          : null,
        updatedAt: isoAt(1301),
      }));
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 400);
      });
      expect(turnStartCommands()).toHaveLength(1);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
  it("keeps a failed selection send queued without a stale optimistic message", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({ rejectTurnStart: true });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-selection-composer-failed-send" as MessageId,
      targetText: "Selection composer failed send test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep the source draft");
      await waitForLayout();
      const source = page.getByText("assistant filler 21", { exact: true });
      await expect.element(source).toBeVisible();
      await source.click();
      const sourceNode = source.element();
      const range = document.createRange();
      range.selectNodeContents(sourceNode);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      const rect = range.getBoundingClientRect();
      sourceNode.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          clientX: rect.right,
          clientY: rect.bottom,
        }),
      );
      await page.getByRole("button", { name: "Add to new Chat", exact: true }).click();
      const prompt = "Retry this selected passage";
      await page.getByRole("textbox", { name: "Message for new chat" }).fill(prompt);
      wsRequests.length = 0;
      await page.getByRole("button", { name: "Send to new chat", exact: true }).click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A failed selection send should remain on its fresh draft.",
      );
      const newThreadId = ThreadId.makeUnsafe(newThreadPath.slice(1));
      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[newThreadId];
          expect(draft?.queuedTurns).toHaveLength(1);
          expect(draft?.queuedTurns[0]).toMatchObject({
            kind: "chat",
            prompt,
            assistantSelections: [{ text: "assistant filler 21" }],
          });
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "Keep the source draft",
          );
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .filter((command) => command?.type === "thread.turn.start"),
          ).toHaveLength(1);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          const staleOptimisticRows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
          ).filter((row) => row.textContent?.includes(prompt));
          expect(staleOptimisticRows).toHaveLength(0);
        },
        { timeout: 8000, interval: 16 },
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      expect(
        wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.turn.start"),
      ).toHaveLength(1);
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
  it("rolls back the provisional Space when project creation fails", async () => {
    const currentSpaceId = SpaceId.makeUnsafe("space-current");
    const destinationSpaceId = SpaceId.makeUnsafe("space-destination");
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-create-project-space-rollback" as MessageId,
      targetText: "create project space rollback",
    });
    useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        spaces: [
          {
            id: currentSpaceId,
            name: "Current",
            icon: "bag",
            sortOrder: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
          {
            id: destinationSpaceId,
            name: "Destination",
            icon: "target",
            sortOrder: 1,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
        ],
        projects: baseSnapshot.projects.map((project) => ({
          ...project,
          spaceId: currentSpaceId,
        })),
      },
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async () => {
            throw new Error("Project creation failed for test.");
          }),
        },
      },
    });
    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await page.getByLabelText("Project folder path").fill("/repo/failing-project");
      const spaceTrigger = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-slot="dialog-popup"] [data-slot="select-trigger"]',
          ),
        "Unable to find the Create Project Space selector.",
      );
      spaceTrigger.click();
      const destinationOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find(
            (item) => item.textContent?.trim() === "Destination",
          ) ?? null,
        "Unable to find the destination Space option.",
      );
      destinationOption.click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project creation failed for test.");
      expect(useSpacesUiStore.getState().activeSpaceId).toBe(currentSpaceId);
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();
    } finally {
      useSpacesUiStore.getState().setActiveSpaceId(null);
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });
  it.each(["board", "chat"] as const)(
    "dispatches a draft once when %s owns the send before the other surface",
    async (firstOwner) => {
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        projectThreadCommands: true,
        beforeTurnStart: () => turnGate,
      });
      useKanbanUiStore.setState({ optimisticDispatchByThreadId: {} });
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
      });
      let boardSend: ReturnType<typeof dispatchKanbanDraftThread> | undefined;
      const turnCommands = () =>
        wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.turn.start");
      const sendFromBoard = () =>
        dispatchKanbanDraftThread({
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          thread: null,
          defaultProvider: "codex",
          assistantDeliveryMode: "buffered",
        });
      try {
        const prompt = "Send this shared draft once";
        const newerPrompt = "Keep this newer edit for my next turn";
        await page.getByTestId("composer-editor").fill(prompt);
        const sendButton = await waitForSendButton();
        await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
        if (firstOwner === "board") boardSend = sendFromBoard();
        else sendButton.click();
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));
        if (firstOwner === "board") {
          sendButton.click();
          // The actual chat send must have entered its pending UI before releasing the board RPC.
          await vi.waitFor(() =>
            expect(
              useThreadDispatchStore.getState().threads[THREAD_ID]?.localDispatch,
            ).toBeTruthy(),
          );
        } else {
          boardSend = sendFromBoard();
          expect(await boardSend).toMatchObject({ kind: "dispatched", deferred: true });
          expect(
            useKanbanUiStore.getState().optimisticDispatchByThreadId[THREAD_ID],
          ).toBeUndefined();
        }
        await page.getByTestId("composer-editor").fill(newerPrompt);
        releaseTurn();
        expect(await boardSend).toMatchObject({ kind: "dispatched" });
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));
        const command = turnCommands()[0]!;
        const message = command.message as {
          messageId: MessageId;
          text: string;
        };
        expect(message.text).toBe(prompt);
        const created = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
        const startedThread = {
          ...created.threads.find((thread) => thread.id === THREAD_ID)!,
          messages: [
            createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
          ],
          session: {
            ...createSnapshotForTargetUser({
              targetMessageId: message.messageId,
              targetText: prompt,
            }).threads[0]!.session!,
            threadId: THREAD_ID,
            status: "ready" as const,
            activeTurnId: null,
          },
          latestTurn: {
            turnId: TurnId.makeUnsafe("board-chat-race-turn"),
            state: "completed" as const,
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: NOW_ISO,
            assistantMessageId: null,
          },
        };
        fixture.snapshot = {
          ...created,
          threads: [startedThread],
          snapshotSequence: created.snapshotSequence + 1,
        };
        useStore.getState().syncServerReadModel(fixture.snapshot);
        useStore.getState().syncServerThreadDetailHotPath(startedThread);
        await vi.waitFor(() => {
          expect(useThreadDispatchStore.getState().threads[THREAD_ID]?.localDispatch).toBeFalsy();
          expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
          expect(page.getByTestId("composer-editor").element().textContent).toContain(newerPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            newerPrompt,
          );
        });
        // Real board reconciliation consumes the runtime acknowledgement and drops its optimistic move.
        await mounted.router.navigate({
          to: "/kanban/$projectId",
          params: { projectId: PROJECT_ID },
        });
        await vi.waitFor(() =>
          expect(
            useKanbanUiStore.getState().optimisticDispatchByThreadId[THREAD_ID],
          ).toBeUndefined(),
        );
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            newerPrompt,
          );
          expect(page.getByTestId("composer-editor").element().textContent).toContain(newerPrompt);
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
              ?.disabled,
          ).toBe(false);
        });
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(2));
        expect(
          (
            turnCommands()[1]!.message as {
              text: string;
            }
          ).text,
        ).toBe(newerPrompt);
      } finally {
        releaseTurn();
        await boardSend;
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );
  it("keeps the first sent message visible throughout draft promotion", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    try {
      const prompt = "Keep the first message on screen";
      const draftCreatedAt = useComposerDraftStore.getState().getDraftThread(THREAD_ID)?.createdAt;
      expect(draftCreatedAt).toBeDefined();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      const startCommand = await vi.waitFor(() => {
        const command = wsRequests
          .map(readDispatchedCommand)
          .find((candidate) => candidate?.type === "thread.turn.start");
        expect(command).toBeDefined();
        return command!;
      });
      const createCommand = wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === "thread.create");
      expect(createCommand?.createdAt).toBe(startCommand.createdAt);
      expect(createCommand?.createdAt).not.toBe(draftCreatedAt);
      const message = startCommand.message as {
        messageId: MessageId;
        text: string;
      };
      const messageSelector = `[data-message-id="${message.messageId}"][data-message-role="user"]`;
      const expectTranscript = async () => {
        await waitForLayout();
        expect(document.querySelectorAll(messageSelector)).toHaveLength(1);
        expect(document.querySelector(messageSelector)?.textContent).toContain(prompt);
        expect(document.querySelector('[data-empty-landing-composer-block="true"]')).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      };
      await expectTranscript();
      const createdSnapshot = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
      const createdThread = { ...createdSnapshot.threads[0]!, session: null };
      fixture.snapshot = { ...createdSnapshot, threads: [createdThread] };
      useStore
        .getState()
        .syncServerShellSnapshot(createShellSnapshotFromReadModel(fixture.snapshot));
      await expectTranscript();
      useStore.getState().syncServerThreadDetailHotPath(createdThread);
      await expectTranscript();
      const startedThread = {
        ...createdThread,
        messages: [
          {
            ...createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
            createdAt: startCommand.createdAt as string,
            updatedAt: startCommand.createdAt as string,
          },
        ],
      };
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [startedThread],
      };
      useStore.getState().syncServerThreadDetailHotPath(startedThread);
      useComposerDraftStore.getState().finalizePromotedDraftThread(THREAD_ID);
      await expectTranscript();
      // A creation snapshot can finish after the first message echo.
      useStore.getState().syncServerThreadDetailHotPath(createdThread);
      await expectTranscript();
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
  it("keeps a sent draft prompt out of the composer once the server recorded it", async () => {
    const turnStartCommand = () =>
      wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === "thread.turn.start");
    // The server records the first message, then the acknowledgement fails.
    const restoreNativeApi = installDeterministicSendNativeApi({
      rejectTurnStart: true,
      beforeTurnStart: async () => {
        const command = turnStartCommand()!;
        const message = command.message as {
          messageId: MessageId;
          text: string;
        };
        const createdSnapshot = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
        const startedThread = {
          ...createdSnapshot.threads[0]!,
          session: null,
          messages: [
            {
              ...createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
              createdAt: command.createdAt as string,
              updatedAt: command.createdAt as string,
            },
          ],
        };
        fixture.snapshot = { ...createdSnapshot, threads: [startedThread] };
        useStore
          .getState()
          .syncServerShellSnapshot(createShellSnapshotFromReadModel(fixture.snapshot));
        useStore.getState().syncServerThreadDetailHotPath(startedThread);
      },
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Send this only once");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();
      await vi.waitFor(() => expect(turnStartCommand()).toBeDefined());
      await vi.waitFor(() => expect(hasActiveComposerSend(THREAD_ID)).toBe(false), {
        timeout: 8000,
        interval: 16,
      });
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
      expect(
        wsRequests.map(readDispatchedCommand).some((command) => command?.type === "thread.delete"),
      ).toBe(false);
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });
  it("keeps composer edits made while New thread reopens a stored draft", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("stored-draft-reopen"),
        targetText: "Stored draft reopen",
      }),
    });
    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Older stored draft");
      const newThreadButton = page.getByLabelText("Create new thread in Project").element();
      (newThreadButton as HTMLElement).click();
      // Type into the reopened draft as soon as its route is active, while the
      // New thread navigation is still settling.
      await new Promise<void>((resolve) => {
        let microtaskChecks = 0;
        const editWhenRouted = () => {
          if (mounted.router.state.location.pathname === `/${OTHER_THREAD_ID}`) {
            useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Newer typed text");
            resolve();
            return;
          }
          microtaskChecks += 1;
          if (microtaskChecks < 10000) queueMicrotask(editWhenRouted);
          else window.setTimeout(editWhenRouted, 0);
        };
        editWhenRouted();
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).not.toBeNull(),
      );
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
        "Newer typed text",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("explains a second send instead of ignoring it while the first is in flight", async () => {
    let releaseTurnStart!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    const restoreNativeApi = installDeterministicSendNativeApi({
      beforeTurnStart: () => turnGate,
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    const turnCommands = () =>
      wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command?.type === "thread.turn.start");
    try {
      await page.getByTestId("composer-editor").fill("First message");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();
      await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));
      await page.getByTestId("composer-editor").fill("Second message");
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("Still sending your last message")).toBeInTheDocument();
      expect(turnCommands()).toHaveLength(1);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "Second message",
      );
    } finally {
      releaseTurnStart();
      restoreNativeApi();
      await mounted.cleanup();
    }
  });
  it.each([
    { kind: "forked", envMode: "local", started: false },
    { kind: "forked", envMode: "worktree", started: false },
    { kind: "forked", envMode: "local", started: true },
    { kind: "forked", envMode: "worktree", started: true },
    { kind: "standalone", envMode: "local", started: false },
    { kind: "standalone", envMode: "local", started: true },
  ] as const)(
    "keeps $kind sidechat composer free of workspace controls ($envMode, started=$started)",
    async ({ kind, envMode, started }) => {
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const sidechat = {
        ...snapshot.threads[0]!,
        session: null,
        envMode,
        worktreePath: envMode === "worktree" ? "/repo-sidechat-worktree" : null,
        workingDirectory: "/repo-sidechat-worktree/packages",
        ...(kind === "forked"
          ? { sidechatSourceThreadId: OTHER_THREAD_ID }
          : {
              sidechatContext: {
                kind: "github-item" as const,
                itemKind: "pullRequest" as const,
                repository: "acme/widgets",
                number: 1368,
                url: "https://github.com/acme/widgets/pull/1368",
              },
            }),
        messages: started
          ? [
              createUserMessage({
                id: MessageId.makeUnsafe("sidechat-follow-up"),
                text: "Keep discussing this context",
                offsetSeconds: 0,
              }),
            ]
          : [],
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [sidechat] },
      });
      try {
        const editor = await waitForComposerEditor();
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
        expect(document.querySelector('[data-empty-landing-controls="true"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Import your Claude Code");
        expect(document.body.textContent).not.toContain("Let's build");
        await expect
          .element(page.getByRole("button", { name: "Local", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Temporary chat", exact: true }))
          .not.toBeInTheDocument();
        if (kind === "standalone" && !started) {
          expect(editor.getAttribute("aria-placeholder")).toBe("Ask about this pull request");
        }
        if (started) {
          await expect
            .element(page.getByText("Keep discussing this context", { exact: true }))
            .toBeVisible();
        }
        await page.getByRole("button", { name: "Toggle environment panel" }).click();
        await expect
          .element(page.getByRole("button", { name: "Local", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("combobox", { name: "main", exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    },
  );
  it("disables the ASCII landing decoration from Appearance and releases it on the terminal tab", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [{ ...snapshot.threads[0]!, session: null }] },
    });
    const background = () => document.querySelector("canvas.font-mono");
    try {
      await expect.poll(background).not.toBeNull();
      await waitForLayout();
      const field = background()!.getBoundingClientRect();
      const content = page.getByTestId("empty-landing-content").element().getBoundingClientRect();
      const composer = document
        .querySelector('[data-chat-composer-form="true"]')!
        .getBoundingClientRect();
      expect(field.bottom).toBeLessThanOrEqual(composer.top + 1);
      expect(field.top).toBeGreaterThanOrEqual(content.top - 1);
      expect(field.height).toBeLessThanOrEqual(content.height + 1);
      await mounted.router.navigate({ to: "/settings", search: { section: "appearance" } });
      const toggle = page.getByRole("switch", { name: "ASCII background", exact: true });
      await expect.element(toggle).toBeChecked();
      await toggle.click();
      await expect
        .poll(
          () =>
            JSON.parse(localStorage.getItem("synara:app-settings:v1") ?? "{}").showAsciiBackground,
        )
        .toBe(false);
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await expect.element(page.getByTestId("empty-landing-heading")).toBeVisible();
      expect(background()).toBeNull();
      await mounted.router.navigate({ to: "/settings", search: { section: "appearance" } });
      await expect.element(toggle).not.toBeChecked();
      await page.getByRole("button", { name: "Reset ASCII background to default" }).click();
      await expect.element(toggle).toBeChecked();
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await expect.poll(background).not.toBeNull();
      useTerminalStateStore.getState().openTerminalThreadPage(THREAD_ID, { terminalOnly: false });
      await expect.poll(background).toBeNull();
      useTerminalStateStore.getState().setTerminalWorkspaceTab(THREAD_ID, "chat");
      await expect.poll(background).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps worktree setup resolvable while attachments upload", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let releaseAttachmentUpload = () => {};
    let releaseAttachmentCancel = () => {};
    attachmentUploadBarrier = new Promise<void>((resolve) => {
      releaseAttachmentUpload = resolve;
    });
    attachmentCancelBarrier = new Promise<void>((resolve) => {
      releaseAttachmentCancel = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-cancel-upload-test" as MessageId,
        targetText: "new worktree cancel upload test",
      }),
    });
    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      const worktreeCheckbox = await waitForWorktreeCheckbox();
      worktreeCheckbox.click();
      await vi.waitFor(() => {
        expect(worktreeCheckbox.getAttribute("aria-checked")).toBe("true");
      });
      useComposerDraftStore.getState().setPrompt(newThreadId, "Cancel before upload finishes");
      useComposerDraftStore.getState().addImage(
        newThreadId,
        createComposerImage({
          id: "new-worktree-cancel-upload-image",
          previewUrl: "blob:new-worktree-cancel-upload-image",
        }),
      );
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>('[data-timeline-row-kind="worktree-setup"]')
              ?.textContent,
        )
        .toContain("Linking thread workspace");
      const cancelButton = page.getByRole("button", { name: "Cancel" });
      await expect.element(cancelButton).toBeInTheDocument();
      expect(
        wsRequests.some(
          (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
        ),
      ).toBe(false);
      await cancelButton.click();
      releaseAttachmentCancel();
      attachmentCancelBarrier = null;
      releaseAttachmentUpload();
      attachmentUploadBarrier = null;
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
            ),
          ).toBe(false);
          expect(
            wsRequests.some(
              (candidate) =>
                candidate._tag === WS_METHODS.gitRemoveWorktree &&
                candidate.path === "/repo/.codex/worktrees/generated/synara" &&
                candidate.force === true &&
                candidate.reclaimTemporaryBranch === true,
            ),
          ).toBe(true);
          expect(document.querySelector('[data-timeline-row-kind="worktree-setup"]')).toBeNull();
        },
        { timeout: 8000, interval: 16 },
      );
    } finally {
      releaseAttachmentCancel();
      attachmentCancelBarrier = null;
      releaseAttachmentUpload();
      attachmentUploadBarrier = null;
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
  it("preserves a new-chat draft when switching to another thread and back via New chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-home-draft-switch" as MessageId,
            targetText: "home draft switch target",
          }),
          OTHER_THREAD_ID,
        ),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
      },
    });
    try {
      // Start a brand-new home chat (draft thread)
      const newChatButton = page.getByLabelText("Open new chat home");
      await expect.element(newChatButton).toBeInTheDocument();
      await newChatButton.click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      // Type a draft in the new chat
      const prompt = "draft typed in a brand-new home chat";
      useComposerDraftStore.getState().setPrompt(newThreadId, prompt);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain(prompt);
        },
        { timeout: 8000, interval: 16 },
      );
      // Switch to another thread to check on it
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        },
        { timeout: 8000, interval: 16 },
      );
      // Come back via "New chat" — must return to the SAME draft thread with the draft intact
      const newChatButtonAgain = page.getByLabelText("Open new chat home");
      await expect.element(newChatButtonAgain).toBeInTheDocument();
      await newChatButtonAgain.click();
      const returnedPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a draft thread UUID.",
      );
      await vi.waitFor(
        () => {
          expect(returnedPath).toBe(newThreadPath);
        },
        { timeout: 8000, interval: 16 },
      );
      const composerEditorAfter = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditorAfter.textContent ?? "").toContain(prompt);
        },
        { timeout: 8000, interval: 16 },
      );
      // The original draft thread must still be registered with its content
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(prompt);
    } finally {
      await mounted.cleanup();
    }
  });
  it("applies the selected chat width to the transcript column", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ chatWidth: "wide" }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-width-test" as MessageId,
        targetText: "chat width test",
      }),
    });
    try {
      // The hook must surface the preset as a root CSS variable.
      await vi.waitFor(
        () => {
          expect(document.documentElement.style.getPropertyValue("--app-chat-max-width")).toBe(
            "72rem",
          );
        },
        { timeout: 8000, interval: 16 },
      );
      // The transcript column frame must pick up the wider max width.
      await vi.waitFor(
        () => {
          const row = document.querySelector(
            "[data-timeline-row-kind='message'][data-message-role='assistant']",
          ) as HTMLElement | null;
          expect(row).not.toBeNull();
          expect(row?.className ?? "").toContain("max-w-[var(--app-chat-max-width,46rem)]");
          expect(getComputedStyle(row!).maxWidth).toBe("1152px"); // 72rem at 16px root
        },
        { timeout: 8000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps close-button pointer travel from starting a horizontal tab drag", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("drag-close"),
        targetText: "Close a tab",
      }),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(2),
      );
      const button = document.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Open threads"] button[aria-label^="Close "]',
      )[0]!;
      await userEvent.hover(button);
      await userEvent.dragAndDrop(button, button, {
        sourcePosition: { x: 12, y: 12 },
        targetPosition: { x: 19, y: 12 },
      });
      await vi.waitFor(
        () => expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID),
        {
          timeout: 2000,
        },
      );
      expect(useOpenThreadTabsStore.getState().threadIds).toEqual([OTHER_THREAD_ID]);
    } finally {
      await mounted.cleanup();
    }
  });
  it("keeps the final transcript row clear of the composer capsules", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithTallComposerStack(),
    });
    const maxFixedClearancePx = 128;
    try {
      const changesCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-live-changes"]'),
        "Unable to find the live changes capsule.",
      );
      const taskCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-capsule"]'),
        "Unable to find the task-list capsule.",
      );
      expect(changesCapsule.title).toContain("2 files changed");
      expect(taskCapsule.textContent).toContain("1/3 tasks");
      // Activity collapses into capsules in one capsule row instead of a stack of panels.
      const capsuleRow = taskCapsule.closest("[data-composer-capsule-row]");
      expect(capsuleRow).not.toBeNull();
      expect(changesCapsule.closest("[data-composer-capsule-row]")).toBe(capsuleRow);
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      const readCapsuleLayout = () => {
        const renderedRows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"),
        );
        const finalTranscriptRow = renderedRows.reduce<HTMLElement | null>((latest, row) => {
          if (!latest) return row;
          return row.getBoundingClientRect().bottom > latest.getBoundingClientRect().bottom
            ? row
            : latest;
        }, null);
        const capsuleRow = taskCapsule.closest<HTMLElement>("[data-composer-capsule-row]");
        expect(
          finalTranscriptRow,
          "Unable to find the final rendered transcript row.",
        ).toBeTruthy();
        expect(capsuleRow, "Unable to find the composer capsule row.").toBeTruthy();
        return {
          gapPx:
            capsuleRow!.getBoundingClientRect().top -
            finalTranscriptRow!.getBoundingClientRect().bottom,
          distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
        };
      };
      const waitForBoundedGap = async (phase: string) => {
        let measured = readCapsuleLayout();
        await vi.waitFor(
          () => {
            measured = readCapsuleLayout();
            expect(
              measured.distanceFromBottomPx,
              `${phase}: transcript must stay at the end`,
            ).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
            expect(
              measured.gapPx,
              `${phase}: final row must not be obscured`,
            ).toBeGreaterThanOrEqual(-1);
            expect(
              measured.gapPx,
              `${phase}: gap must stay within fixed clearance`,
            ).toBeLessThanOrEqual(maxFixedClearancePx);
          },
          { timeout: 4000, interval: 16 },
        );
        return measured;
      };
      const closed = await waitForBoundedGap("capsules");
      const scrollTopBeforeOpen = scrollContainer.scrollTop;
      // The full task list opens in a popover over the transcript, so it never moves the reader.
      taskCapsule.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-card"]'),
        "Unable to find the task-list popover.",
      );
      expect(document.body.textContent).toContain("1 out of 3 tasks completed");
      const opened = await waitForBoundedGap("task list open");
      expect(Math.abs(opened.gapPx - closed.gapPx)).toBeLessThanOrEqual(1);
      expect(Math.abs(scrollContainer.scrollTop - scrollTopBeforeOpen)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });
  it("shows active turn plans as a task capsule that opens the full list", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });
    try {
      const taskCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-capsule"]'),
        "Unable to find the task-list capsule.",
      );
      expect(taskCapsule.textContent).toContain("1/3 tasks");
      const composerShell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      );
      expect(composerShell).not.toBeNull();
      // A compact capsule floating above the input, not a w-14/15 rail fused onto it.
      const taskRect = taskCapsule.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(taskRect.bottom).toBeLessThanOrEqual(composerRect.top);
      expect(taskRect.width).toBeLessThan(composerRect.width);
      taskCapsule.click();
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
          expect(document.body.textContent).toContain("Inspecting ChatView boundaries");
          expect(document.body.textContent).toContain("Patch the shared checklist receiver");
          expect(document.body.textContent).toContain("1 background agent");
        },
        { timeout: 8000, interval: 16 },
      );
      const openPlanButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Open tasks sidebar"]'),
        "Unable to find the task popover sidebar button.",
      );
      openPlanButton.click();
      await expect.element(page.getByLabelText("Close plan sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
  it("sprite project library reuses the normal composer and retries first-message initialization", async () => {
    const { SpriteProjectDataSchema } = await import("@synara/contracts/spriteLibrarySchema");
    type Data = import("@synara/contracts/spriteLibrary").SpriteProjectData;
    const projects = new Map<string, Data>();
    const imageFiles = new Map<string, Uint8Array>();
    let failAssociation = false;
    const previousBridge = window.desktopBridge;
    const spriteBridge: import("@synara/contracts/spriteLibrary").SpriteLibraryBridge = {
      request: async <T,>(
        command: import("@synara/contracts/spriteLibrary").SpriteLibraryCommand,
      ): Promise<T> => {
        let result: unknown;
        switch (command.op) {
          case "list":
            result = {
              root: "/Documents/Aha/Sprite",
              projects: [...projects.values()].map((p) => ({
                id: p.id,
                name: p.name,
                updatedAt: p.updatedAt,
                actionCount: p.actions.length,
                deleting: false,
              })),
            };
            break;
          case "save":
            if (failAssociation && command.project.threadIds.length === 3) {
              failAssociation = false;
              throw new Error("Project association save failed");
            }
            for (const image of command.images)
              imageFiles.set(`${command.project.id}/${image.file}`, image.bytes);
            if (command.thumbnail)
              imageFiles.set(`${command.project.id}/thumbnail.png`, command.thumbnail);
            projects.set(command.project.id, SpriteProjectDataSchema.parse(command.project));
            break;
          case "get":
            result = projects.get(command.id);
            break;
          case "readImage":
            result = imageFiles.get(`${command.id}/${command.file}`);
            if (!result) throw new Error("No image");
            break;
          case "rename": {
            const p = projects.get(command.id)!;
            projects.set(command.id, { ...p, name: command.name });
            break;
          }
          case "finishDelete":
            projects.delete(command.id);
            break;
        }
        return result as T;
      },
    };
    const mounted = await mountChatView({
      viewport: { name: "sprite", width: 1440, height: 960 },
      configureFixture: (next) => {
        next.welcome = {
          ...next.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("sprite-seed"),
          targetText: "hello",
        }),
      ),
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { ...previousBridge, spriteLibrary: spriteBridge, setTheme: async () => {} },
    });
    const restoreSendApi = installDeterministicSendNativeApi({ projectThreadCommands: true });
    const baseApi = readNativeApi()!;
    let failInitialization = false;
    const syncEvents: string[] = [];
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...baseApi,
        orchestration: {
          ...baseApi.orchestration,
          getShellSnapshot: async () => createShellSnapshotFromReadModel(fixture.snapshot),
          getThreadDetailSnapshot: async ({ threadId }: { threadId: ThreadId }) => {
            if (failInitialization) {
              failInitialization = false;
              throw new Error("Sprite initialization failed for test.");
            }
            const thread = fixture.snapshot.threads.find((t) => t.id === threadId);
            return thread ? { snapshotSequence: fixture.snapshot.snapshotSequence, thread } : null;
          },
        },
        imageGeneration: {
          ...baseApi.imageGeneration,
          listProviders: async () => [],
          onEvent: () => () => {},
          spriteCommand: async (command: import("@synara/contracts").SpriteCommand) => {
            if (
              command.operation === "sync" &&
              command.context?.threadId &&
              fixture.snapshot.threads.some((t) => t.id === command.context?.threadId)
            ) {
              syncEvents.push(command.context.threadId);
            }
            return { context: command.context ?? null, runs: [] };
          },
        },
      },
    });
    try {
      await mounted.router.navigate({ to: "/sprite-animation", search: {} });
      await expect.element(page.getByTestId("sprite-library")).toBeVisible();
      expect(projects.size).toBe(0);
      await expect
        .element(
          page.getByText("No sprite projects yet. Create a project or import a project package."),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "New sprite project", exact: true }).click();
      await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Fox knight");
      await page.getByRole("button", { name: "Create sprite project", exact: true }).click();
      await expect.element(page.getByTestId("sprite-workbench")).toBeVisible();
      const openSpriteAssistant = async () => {
        if (document.querySelector('button[aria-label="Open inspector"]'))
          await page.getByRole("button", { name: "Open inspector", exact: true }).click();
        await page.getByRole("button", { name: "AI assistant", exact: true }).click();
      };
      await openSpriteAssistant();
      await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
      await waitForComposerEditor();
      const sprite = [...projects.values()][0]!;
      await vi.waitFor(() => expect(projects.get(sprite.id)?.activeThreadId).toBeTruthy());
      const threadId = ThreadId.makeUnsafe(projects.get(sprite.id)!.activeThreadId!);
      await expect
        .element(page.getByRole("button", { name: "Change model and reasoning", exact: true }))
        .toBeVisible();
      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.3-codex",
        instanceId: "codex",
      });
      await page.getByTestId("composer-editor").fill("Create a fox knight");
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      canvas.getContext("2d")!.fillRect(2, 2, 10, 10);
      const imageBlob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      await userEvent.upload(
        document.querySelector<HTMLInputElement>(
          'input[accept="image/png,image/jpeg,image/webp"]',
        )!,
        new File([imageBlob], "fox.png", { type: "image/png" }),
      );
      if (document.querySelector('button[aria-label="Actions list"]'))
        await page.getByRole("button", { name: "Actions list", exact: true }).click();
      await page.getByRole("button", { name: "Image sources", exact: true }).click();
      await page.getByRole("button", { name: "Add to conversation: fox.png", exact: true }).click();
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(1),
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
        "Create a fox knight",
      );
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await vi
        .waitFor(() => expect(projects.get(sprite.id)?.threadIds).toHaveLength(2), {
          timeout: 8000,
        })
        .catch((error) => {
          console.log("SPRITE_NEW_CHAT_FAILURE", {
            projects: [...projects.values()].map((p) => ({
              threads: p.threadIds,
              active: p.activeThreadId,
            })),
            alerts: [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent),
            drafts: Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId),
          });
          throw error;
        });
      const secondId = ThreadId.makeUnsafe(projects.get(sprite.id)!.activeThreadId!);
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("Independent second draft");
      expect(
        useComposerDraftStore.getState().draftsByThreadId[secondId]?.images ?? [],
      ).toHaveLength(0);
      await page.getByRole("combobox", { name: "Sprite conversations", exact: true }).click();
      await page.getByTestId(`sprite-chat-option-${threadId}`).click();
      await waitForComposerEditor();
      await expect
        .element(page.getByTestId("composer-editor"))
        .toHaveTextContent("Create a fox knight");
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(1);
      failInitialization = true;
      const commands = (type: string) =>
        wsRequests
          .map(readDispatchedCommand)
          .filter((c) => c?.type === type && c.threadId === threadId);
      const send = await waitForSendButton();
      await vi.waitFor(() => expect(send.disabled).toBe(false));
      send.click();
      await vi.waitFor(() => expect(commands("thread.create")).toHaveLength(1));
      await vi.waitFor(() => expect(failInitialization).toBe(false));
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="composer-editor"]')?.textContent).toContain(
          "Create a fox knight",
        ),
      );
      expect(commands("thread.turn.start")).toHaveLength(0);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(1);
      const retrySend = await waitForSendButton();
      await vi.waitFor(() => expect(retrySend.disabled).toBe(false));
      retrySend.click();
      await vi.waitFor(() => expect(commands("thread.turn.start")).toHaveLength(1));
      expect(commands("thread.create")).toHaveLength(1);
      expect(commands("thread.create")[0]?.modelSelection).toMatchObject({
        provider: "codex",
        model: "gpt-5.3-codex",
        instanceId: "codex",
      });
      expect(syncEvents).toContain(threadId);
      expect(fixture.snapshot.threads.find((t) => t.id === threadId)?.notes ?? "").not.toContain(
        "sprite_animation",
      );
      await page.getByRole("combobox", { name: "Sprite conversations", exact: true }).click();
      await page.getByTestId(`sprite-chat-option-${secondId}`).click();
      await waitForComposerEditor();
      await expect
        .element(page.getByTestId("composer-editor"))
        .toHaveTextContent("Independent second draft");
      failAssociation = true;
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project association save failed");
      const draftsAfterFailure = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      );
      expect(projects.get(sprite.id)?.threadIds).toHaveLength(2);
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await vi.waitFor(() => expect(projects.get(sprite.id)?.threadIds).toHaveLength(3), {
        timeout: 8000,
      });
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toEqual(
        draftsAfterFailure,
      );
      await page.getByRole("combobox", { name: "Sprite conversations", exact: true }).click();
      await page.getByTestId(`sprite-chat-option-${secondId}`).click();
      await page.getByRole("button", { name: "Project options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Back to projects", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Open project: Fox knight", exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "Project options: Fox knight", exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Knight idle");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await page
        .getByRole("searchbox", { name: "Search sprite projects", exact: true })
        .fill("missing");
      await expect
        .element(page.getByRole("button", { name: "Open project: Knight idle", exact: true }))
        .not.toBeInTheDocument();
      await page
        .getByRole("searchbox", { name: "Search sprite projects", exact: true })
        .fill("Knight");
      emitWsTransportState("open");
      await waitForLayout();
      await page.screenshot({
        path: "../../../../output/playwright/sprite-library.png",
        element: page.getByTestId("sprite-library"),
      });
      await page.getByRole("button", { name: "Open project: Knight idle", exact: true }).click();
      await expect.element(page.getByTestId("sprite-workbench")).toBeVisible();
      expect(mounted.router.state.location.search).toMatchObject({ projectId: sprite.id });
      expect(projects.get(sprite.id)?.activeThreadId).toBe(secondId);
      await openSpriteAssistant();
      await waitForComposerEditor();
      emitWsTransportState("open");
      await waitForLayout();
      await page.screenshot({
        path: "../../../../output/playwright/sprite-workbench.png",
        element: page.getByTestId("sprite-workbench"),
      });
      {
        await page.getByRole("button", { name: "Project options", exact: true }).click();
        await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
        // Deleting asks through the shared confirmation dialog, which names the project.
        const confirmation = page.getByRole("alertdialog");
        await expect.element(confirmation).toHaveTextContent("Delete sprite project");
        await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
        await expect.element(page.getByTestId("sprite-library")).toBeVisible();
        expect(projects.size).toBe(0);
        expect(fixture.snapshot.threads.some((t) => t.id === threadId)).toBe(true);
        await expect
          .element(
            page.getByText("No sprite projects yet. Create a project or import a project package."),
          )
          .toBeVisible();
      }
    } finally {
      restoreSendApi();
      await mounted.cleanup();
      Object.defineProperty(window, "desktopBridge", { configurable: true, value: previousBridge });
    }
  });
  describe("inline visual choice draft ownership", () => {
    it.each(["attachment", "empty"] as const)(
      "keeps %s composer ownership when selecting a follow-up",
      async (mode) => {
        const base = createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("visual-user"),
          targetText: "Show a visual",
        });
        const visualId = `vis_${(mode === "attachment" ? "a" : "b").repeat(32)}`;
        const turnId = TurnId.makeUnsafe("visual-choice-turn");
        const snapshot = {
          ...base,
          threads: base.threads.map((thread) => ({
            ...thread,
            latestTurn: {
              turnId,
              state: "completed" as const,
              requestedAt: isoAt(150),
              startedAt: isoAt(150),
              completedAt: isoAt(153),
              assistantMessageId: MessageId.makeUnsafe("visual-answer"),
            },
            messages: [
              {
                ...createUserMessage({
                  id: MessageId.makeUnsafe("visual-user"),
                  text: "Show a visual",
                  offsetSeconds: 150,
                }),
                turnId,
              },
              {
                ...createAssistantMessage({
                  id: MessageId.makeUnsafe("visual-answer"),
                  text: `\`\`\`synara-visual\n${visualId}\n\`\`\``,
                  offsetSeconds: 152,
                }),
                turnId,
              },
            ],
            activities: [
              {
                id: EventId.makeUnsafe("visual-choice-activity"),
                kind: "visual.shown" as const,
                tone: "info" as const,
                summary: "Visual",
                createdAt: isoAt(151),
                turnId,
                payload: {
                  visualId,
                  format: "components",
                  title: "Follow up",
                  height: 200,
                  byteLength: 50,
                  sha256: "a".repeat(64),
                },
              },
            ],
          })),
        };
        const restoreNativeApi = installDeterministicSendNativeApi();
        const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
        try {
          if (mode === "attachment") {
            useComposerDraftStore.getState().addImages(THREAD_ID, [
              createComposerImage({
                id: "private-draft-image",
                name: "private.png",
                previewUrl: "blob:private-draft-image",
              }),
            ]);
          }
          await expect
            .element(page.getByRole("button", { name: /Visual follow up/ }))
            .toBeVisible();
          const before = wsRequests.filter((request) =>
            turnStartText(request)?.includes("Follow up from visual"),
          ).length;
          await page.getByRole("button", { name: /Visual follow up/ }).click();
          if (mode === "attachment") {
            await vi.waitFor(() =>
              expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
                "Follow up from visual",
              ),
            );
            await waitForLayout();
            expect(
              wsRequests.filter((request) =>
                turnStartText(request)?.includes("Follow up from visual"),
              ),
            ).toHaveLength(before);
            expect(
              useComposerDraftStore
                .getState()
                .draftsByThreadId[THREAD_ID]?.images.map((image) => image.id),
            ).toEqual(["private-draft-image"]);
          } else {
            await waitForLayout();
            await vi.waitFor(() =>
              expect(
                wsRequests.filter((request) =>
                  turnStartText(request)?.includes("Follow up from visual"),
                ),
              ).toHaveLength(before + 1),
            );
          }
        } finally {
          await mounted.cleanup();
          restoreNativeApi();
        }
      },
    );
  });
});
