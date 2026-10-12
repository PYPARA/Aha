import { TerminalManager } from "../terminal/Services/Manager";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CommandId, ProjectId } from "@synara/contracts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProviderService } from "../provider/Services/ProviderService";
import { ProviderSessionRuntimeRepository } from "../persistence/Services/ProviderSessionRuntime";
import { threadHasInFlightTurn } from "../orchestration/commandInvariants";
import { WorkspaceMigrationCoordinator, registerWorkspaceMigration } from "./coordinator";
import { within } from "./copyWorkspace";
/** Installed after stale-turn reconciliation and before provider/automation restoration. */
export const installWorkspaceMigration = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const provider = yield* ProviderService;
  const runtimes = yield* ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;
  const terminal = yield* Effect.serviceOption(TerminalManager);
  const owner = {
    projects: async () => {
      const model = await Effect.runPromise(engine.getReadModel());
      return model.projects.map((p) => ({
        id: p.id,
        kind: p.kind ?? "project",
        title: p.title,
        root: p.workspaceRoot,
        deleted: p.deletedAt !== null,
      }));
    },
    checkIdle: async (projectId: string) => {
      const model = await Effect.runPromise(engine.getReadModel());
      const project = model.projects.find((p) => p.id === projectId);
      if (!project) throw new Error("Project no longer exists.");
      const threads = model.threads.filter(
        (t) => t.projectId === projectId && t.deletedAt === null,
      );
      const live = await Effect.runPromise(provider.listSessions());
      for (const thread of threads) {
        if (threadHasInFlightTurn(thread))
          throw new Error("Project has an active conversation. Retry after it finishes.");
        if (thread.envMode === "worktree")
          throw new Error("Git worktree conversations require manual workspace migration.");
        for (const worktree of [thread.worktreePath, thread.associatedWorktreePath])
          if (worktree && within(worktree, project.workspaceRoot))
            throw new Error("Linked Git worktree requires manual repair before migration.");
        const runtime = await Effect.runPromise(runtimes.getByThreadId({ threadId: thread.id }));
        // Codex and Claude relocation preserve native cursors through the existing provider restart path.
        if (
          Option.isSome(runtime) &&
          runtime.value.resumeCursor != null &&
          !["codex", "claudeAgent"].includes(runtime.value.providerName)
        )
          throw new Error(
            `Provider ${runtime.value.providerName} has a saved native session; its directory cannot be changed safely. Existing conversation and context were preserved.`,
          );
        if (live.some((s) => s.threadId === thread.id)) {
          if (
            !provider.stopRuntimeSession ||
            (provider.hasLiveRuntimeTasks &&
              (await Effect.runPromise(provider.hasLiveRuntimeTasks({ threadId: thread.id }))))
          )
            throw new Error(
              "Background provider work is active. Restart Aha after it finishes to migrate this project.",
            );
          await Effect.runPromise(provider.stopRuntimeSession({ threadId: thread.id }));
        }
      }
    },
    backup: async () => {
      const dir = path.join(config.stateDir, "workspace-migration-backups");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `before-aha-directories-${randomUUID()}.sqlite`),
        temp = file + ".partial";
      try {
        await Effect.runPromise(sql`VACUUM INTO ${temp}`);
        await fs.chmod(temp, 0o600);
        await fs.rename(temp, file);
        return file;
      } finally {
        await fs.rm(temp, { force: true });
      }
    },
    relocate: async (project: { id: string; root: string }, target: string) => {
      const model = await Effect.runPromise(engine.getReadModel());
      if (Option.isSome(terminal))
        for (const thread of model.threads.filter((t) => t.projectId === project.id))
          await Effect.runPromise(
            terminal.value.close({ threadId: thread.id, deleteHistory: false }),
          );
      await Effect.runPromise(
        engine.dispatch(
          {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe(randomUUID()),
            projectId: ProjectId.makeUnsafe(project.id),
            workspaceRoot: target,
          },
          { managedWorkspaceMigration: { source: project.root, target } },
        ),
      );
    },
  };
  const coordinator = new WorkspaceMigrationCoordinator(
    config.stateDir,
    owner,
    config.homeDir,
    process.env.AHA_DOCUMENTS_DIR,
  );
  const dispose = registerWorkspaceMigration(config.stateDir, coordinator);
  yield* Effect.addFinalizer(() => Effect.sync(dispose));
  return coordinator;
});
