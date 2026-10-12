/* eslint-disable oxc/no-map-spread -- test cases must leave their shared seed model immutable. */
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "../orchestration/decider";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector";
import { relocateRuntimePaths } from "./runtimePaths";
const now = "2026-10-12T00:00:00.000Z",
  projectId = ProjectId.makeUnsafe("managed-project"),
  threadId = ThreadId.makeUnsafe("existing-chat");
const source = "/Users/test/Documents/Synara/day/chat",
  target = "/Users/test/Documents/Aha/Chats/day/chat";
async function seed(kind: "chat" | "studio" | "group" = "chat") {
  const project: OrchestrationEvent = {
    sequence: 1,
    eventId: EventId.makeUnsafe("create-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.makeUnsafe("create-project"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      kind,
      title: "Chat",
      workspaceRoot: source,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  };
  const thread: OrchestrationEvent = {
    sequence: 2,
    eventId: EventId.makeUnsafe("create-thread"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.makeUnsafe("create-thread"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Existing conversation",
      modelSelection: { provider: "codex", model: "test" },
      interactionMode: "default",
      runtimeMode: "full-access",
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: source + "/nested",
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      forkSourceThreadId: null,
      sidechatSourceThreadId: null,
      handoff: null,
      createdAt: now,
      updatedAt: now,
    },
  };
  let model = createEmptyReadModel(now);
  for (const event of [project, thread])
    model = await Effect.runPromise(projectEvent(model, event));
  return { model, history: [project, thread] };
}
async function decide(model: OrchestrationReadModel) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("migrate"),
        projectId,
        workspaceRoot: target,
      },
      readModel: model,
      workspacePaths: {
        homeDir: "/Users/test",
        chatWorkspaceRoot: "/Users/test/Documents/Aha/Chats",
      },
      managedWorkspaceMigration: { source, target },
    }),
  );
  return Array.isArray(result) ? result : [result];
}
describe("managed relocation event compatibility", () => {
  it.each(["chat", "studio", "group"] as const)(
    "relocates %s and its thread in a single event batch, surviving replay",
    async (kind) => {
      const { model, history } = await seed(kind);
      const events = await decide(model);
      expect(events.map((e) => e.type)).toEqual(["project.meta-updated", "thread.meta-updated"]);
      let replayed = createEmptyReadModel(now);
      for (const [index, event] of [...history, ...events].entries())
        replayed = await Effect.runPromise(
          projectEvent(replayed, { ...event, sequence: index + 1 } as OrchestrationEvent),
        );
      expect(replayed.projects[0]?.workspaceRoot).toBe(target);
      expect(replayed.threads[0]?.workingDirectory).toBe(target + "/nested");
      expect(replayed.threads[0]?.id).toBe(threadId);
      expect(replayed.threads[0]?.title).toBe("Existing conversation");
    },
  );
  it("rejects stale source claims and active turns before any event can be committed", async () => {
    const { model } = await seed();
    await expect(
      decide({
        ...model,
        projects: model.projects.map((p) => ({ ...p, workspaceRoot: "/changed" })),
      }),
    ).rejects.toThrow("no longer matches");
    const active = {
      ...model,
      threads: model.threads.map((t) => ({
        ...t,
        session: {
          threadId,
          providerName: "codex",
          status: "running" as const,
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      })),
    };
    await expect(decide(active)).rejects.toThrow("active turns");
  });
  it("keeps the ordinary Home relocation prohibition intact", async () => {
    const { model } = await seed();
    const oldRoot = "/Users/test/Documents/Synara";
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("ordinary"),
            projectId,
            workspaceRoot: target,
          },
          readModel: {
            ...model,
            projects: model.projects.map((p) => ({
              ...p,
              kind: "chat" as const,
              title: "Home",
              workspaceRoot: oldRoot,
            })),
          },
          workspacePaths: {
            homeDir: "/Users/test",
            chatWorkspaceRoot: "/Users/test/Documents/Aha/Chats",
          },
        }),
      ),
    ).rejects.toThrow("cannot be changed");
  });
  it("preserves native resume IDs and unrelated paths", () => {
    const value = {
      cwd: source,
      additionalDirectories: [source + "/data", "/outside"],
      codexThreadId: "native-id",
      opaque: { note: source },
      token: "unchanged",
    };
    expect(JSON.parse(relocateRuntimePaths(JSON.stringify(value), source, target)!)).toEqual({
      ...value,
      cwd: target,
      additionalDirectories: [target + "/data", "/outside"],
    });
  });
});
