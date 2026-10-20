// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { derivePendingThreadRequestIds } from "@synara/shared/threadSummary";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  ),
);
projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect(
    "keeps unresolved requests and the newest task snapshots beyond the window without per-row thread scans",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = asThreadId("thread-history-requests");
        const now = "2026-10-15T10:00:00.000Z";
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('history-requests-project', 'History', '/tmp/history-requests', '[]', ${now}, ${now})`;
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, created_at, updated_at)
          VALUES (${threadId}, 'history-requests-project', 'History', '{"provider":"codex","model":"gpt-5"}', ${now}, ${now})`;
        // Old rows that every window has already dropped; each one decides on its own
        // resolution, not on its rank.
        const oldRows: ReadonlyArray<readonly [string, string, unknown, number]> = [
          ["open-approval", "approval.requested", { requestId: "open" }, 1],
          ["resolved-approval", "approval.requested", { requestId: "done" }, 2],
          ["resolved-approval-row", "approval.resolved", { requestId: "done" }, 3],
          ["stale-approval", "approval.requested", { requestId: "stale" }, 4],
          [
            "stale-approval-failure",
            "provider.approval.respond.failed",
            { requestId: "stale", detail: "Stale pending approval request: gone" },
            5,
          ],
          ["failed-approval", "approval.requested", { requestId: "network" }, 6],
          [
            "failed-approval-failure",
            "provider.approval.respond.failed",
            { requestId: "network", detail: "network error" },
            7,
          ],
          ["numeric-approval", "approval.requested", { requestId: 7 }, 8],
          ["numeric-approval-row", "approval.resolved", { requestId: 7 }, 9],
          ["early-resolution", "approval.resolved", { requestId: "again" }, 10],
          ["reopened-approval", "approval.requested", { requestId: "again" }, 11],
          ["open-input", "user-input.requested", { requestId: "input-open" }, 12],
          ["answered-input", "user-input.requested", { requestId: "input-done" }, 13],
          ["answered-input-row", "user-input.resolved", { requestId: "input-done" }, 14],
          ["older-task-list", "turn.tasks.updated", { tasks: [1] }, 15],
          ["newest-task-list", "turn.tasks.updated", { tasks: [2] }, 16],
          [
            "older-background",
            "runtime.warning",
            { nativeEventType: "background_tasks_changed" },
            17,
          ],
          [
            "newest-background",
            "runtime.warning",
            { nativeEventType: "background_tasks_changed" },
            18,
          ],
        ];
        for (const [activityId, kind, payload, sequence] of oldRows) {
          yield* sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES (${activityId}, ${threadId}, 'approval', ${kind}, 'Old', ${JSON.stringify(payload)}, ${sequence}, ${now})`;
        }
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
          WITH RECURSIVE filler(position) AS (
            SELECT 1 UNION ALL SELECT position + 1 FROM filler WHERE position < 2000
          )
          SELECT 'filler-' || position, ${threadId}, 'tool', 'tool.completed', 'Tool', '{}',
            1000 + position, ${now}
          FROM filler`;
        // Each request used to rescan every activity of the thread, which grew
        // quadratically with history (#1900). Resolutions are now read once.
        let checkedActivityQueries = 0;
        const verifyNoThreadRescan: Statement.Transformer = (statement) =>
          Effect.gen(function* () {
            const [query, parameters] = statement.compile();
            if (!query.includes("'approval.requested'")) return statement;
            checkedActivityQueries += 1;
            const plan = yield* sql
              .unsafe<{
                detail: string;
              }>(`EXPLAIN QUERY PLAN ${query}`, parameters)
              .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
            const rescans = plan.filter(
              (row) =>
                row.detail.includes("later_ranked") ||
                /\blater USING (COVERING )?INDEX idx_projection_thread_activities/.test(row.detail),
            );
            assert.deepEqual(rescans, []);
            return statement;
          });
        const keptOldIds = (
          activities: ReadonlyArray<{
            readonly id: string;
          }>,
        ) =>
          activities
            .map((activity) => activity.id)
            .filter((id) => oldRows.some(([activityId]) => activityId === id));
        const detail = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.provideService(Statement.CurrentTransformer, verifyNoThreadRescan));
        assert.isTrue(Option.isSome(detail));
        assert.deepEqual(keptOldIds(Option.isSome(detail) ? detail.value.activities : []), [
          "open-approval",
          "failed-approval",
          "reopened-approval",
          "open-input",
          "newest-task-list",
          "newest-background",
        ]);
        const snapshot = yield* snapshotQuery
          .getSnapshot()
          .pipe(Effect.provideService(Statement.CurrentTransformer, verifyNoThreadRescan));
        const snapshotThread = snapshot.threads.find((thread) => thread.id === threadId);
        assert.deepEqual(keptOldIds(snapshotThread?.activities ?? []), [
          "open-approval",
          "failed-approval",
          "reopened-approval",
          "open-input",
        ]);
        assert.equal(checkedActivityQueries, 2);
      }),
  );
  it.effect("pages stale candidates past timestamp ties and a removed cursor row", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const older = "2026-07-20T00:00:00.000Z";
      const later = "2026-07-21T00:00:00.000Z";
      const updatedBefore = "2026-07-22T00:00:00.000Z";
      const fresh = "2026-07-23T00:00:00.000Z";
      const ids = ["page-a", "page-b", "page-c", "page-d", "page-fresh"].map(asThreadId);
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM provider_session_runtime`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('page-project', 'Paging', '/tmp/page-project', '[]', ${older}, ${older})
      `;
      for (const [index, threadId] of ids.entries()) {
        const observedAt = index < 2 ? older : index < 4 ? later : fresh;
        yield* sql`
          INSERT INTO projection_threads
            (thread_id, project_id, title, model_selection_json, created_at, updated_at)
          VALUES (
            ${threadId}, 'page-project', 'Paging',
            '{"provider":"codex","model":"gpt-5-codex"}', ${observedAt}, ${observedAt}
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            runtime_mode, active_turn_id, last_error, updated_at
          ) VALUES (
            ${threadId}, 'running', 'codex', NULL, NULL,
            'full-access', NULL, NULL, ${observedAt}
          )
        `;
      }
      assert.deepEqual(
        yield* query.listStaleInFlightThreadIds({ updatedBefore, limit: 5 }),
        ids.slice(0, 4),
      );
      const first = yield* query.listStaleInFlightThreadPage({ updatedBefore, limit: 1 });
      assert.deepEqual(first, {
        threadIds: [asThreadId("page-a")],
        nextCursor: { observedAt: older, threadId: asThreadId("page-a") },
      });
      assert.isNotNull(first.nextCursor);
      if (first.nextCursor === null) return;
      const tied = yield* query.listStaleInFlightThreadPage({
        updatedBefore,
        limit: 1,
        after: first.nextCursor,
      });
      assert.deepEqual(tied, {
        threadIds: [asThreadId("page-b")],
        nextCursor: { observedAt: older, threadId: asThreadId("page-b") },
      });
      // Both earlier candidates leave the result set. Offset paging would now
      // skip later work; the retained tuple must not need a live cursor row.
      yield* sql`UPDATE projection_threads SET updated_at = ${fresh} WHERE thread_id = 'page-a'`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = 'page-b'`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'page-b'`;
      assert.isNotNull(tied.nextCursor);
      if (tied.nextCursor === null) return;
      const afterDeletion = yield* query.listStaleInFlightThreadPage({
        updatedBefore,
        limit: 1,
        after: tied.nextCursor,
      });
      assert.deepEqual(afterDeletion, {
        threadIds: [asThreadId("page-c")],
        nextCursor: { observedAt: later, threadId: asThreadId("page-c") },
      });
      assert.isNotNull(afterDeletion.nextCursor);
      if (afterDeletion.nextCursor === null) return;
      const last = yield* query.listStaleInFlightThreadPage({
        updatedBefore,
        limit: 2,
        after: afterDeletion.nextCursor,
      });
      assert.deepEqual(last, {
        threadIds: [asThreadId("page-d")],
        nextCursor: { observedAt: later, threadId: asThreadId("page-d") },
      });
      assert.isNotNull(last.nextCursor);
      if (last.nextCursor === null) return;
      assert.deepEqual(
        yield* query.listStaleInFlightThreadPage({
          updatedBefore,
          limit: 2,
          after: last.nextCursor,
        }),
        { threadIds: [], nextCursor: null },
      );
    }),
  );
  it.effect(
    "reads thread detail without activities but otherwise identical to the full detail",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = asThreadId("thread-detail-without-activities");
        yield* sql`DELETE FROM projection_pending_interactions`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-without-activities', 'Without activities', '/tmp/without-activities',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch, worktree_path,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES
          (
            'thread-detail-without-activities', 'project-without-activities', 'Live',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL, 'turn-1',
            '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:09.000Z', NULL
          ),
          (
            'thread-detail-without-activities-deleted', 'project-without-activities', 'Deleted',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL, NULL,
            '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:02.000Z',
            '2026-10-01T00:00:03.000Z'
          )
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          (
            'message-user', 'thread-detail-without-activities', 'turn-1', 'user', 'ship it', 0,
            '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:02.000Z'
          ),
          (
            'message-assistant', 'thread-detail-without-activities', 'turn-1', 'assistant',
            'done', 0, '2026-10-01T00:00:03.000Z', '2026-10-01T00:00:04.000Z'
          )
      `;
        yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        ) VALUES (
          'plan-1', 'thread-detail-without-activities', 'turn-1', '# Plan', NULL, NULL,
          '2026-10-01T00:00:05.000Z', '2026-10-01T00:00:05.000Z'
        )
      `;
        // The approval is still open in the settlement projection while the
        // user-input request only exists as an activity: the summary flags must
        // come from pending interactions alone, so skipping activities cannot
        // change them.
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence,
          created_at
        ) VALUES
          (
            'activity-approval', 'thread-detail-without-activities', 'turn-1', 'approval',
            'approval.requested', 'Command approval requested',
            '{"requestId":"approval-open","requestKind":"command"}', 10,
            '2026-10-01T00:00:06.000Z'
          ),
          (
            'activity-user-input', 'thread-detail-without-activities', 'turn-1', 'info',
            'user-input.requested', 'User input requested',
            '{"requestId":"input-activity-only","questions":[{"id":"q1","header":"Scope","question":"Which scope?","options":[{"label":"All","description":"Every file"}]}]}',
            11, '2026-10-01T00:00:06.500Z'
          )
      `;
        yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, turn_id, lifecycle_generation, status,
          decision, response_command_id, response_requested_at, created_at, resolved_at
        ) VALUES (
          'approval', 'approval-open', 'thread-detail-without-activities', 'turn-1', NULL,
          'pending', NULL, NULL, NULL, '2026-10-01T00:00:06.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-detail-without-activities', 'running', 'codex', 'session-1', 'provider-1',
          'approval-required', 'turn-1', NULL, '2026-10-01T00:00:07.000Z'
        )
      `;
        yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
          source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
          completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
          checkpoint_files_json
        ) VALUES (
          'thread-detail-without-activities', 'turn-1', NULL, NULL, NULL, 'message-assistant',
          'completed', '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:02.000Z',
          '2026-10-01T00:00:08.000Z', 1, 'checkpoint-1', 'ready',
          '[{"path":"README.md","kind":"modified","additions":1,"deletions":0}]'
        )
      `;
        const full = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(threadId));
        const withoutActivities = Option.getOrThrow(
          yield* snapshotQuery.getThreadDetailWithoutActivitiesById(threadId),
        );
        assert.lengthOf(full.activities, 2);
        // Activity replay alone would open the user-input request, so the
        // `hasPendingUserInput` check below proves the flags ignore activities.
        assert.deepEqual(
          derivePendingThreadRequestIds({ activities: full.activities }).userInputRequestIds,
          ["input-activity-only"],
        );
        assert.isFalse("activities" in withoutActivities);
        const { activities: _activities, ...fullWithoutActivities } = full;
        assert.deepEqual(withoutActivities, fullWithoutActivities);
        // Spell out the fields server callers rely on, so a fixture regression
        // cannot make the deep-equal above vacuous.
        assert.lengthOf(withoutActivities.messages, 2);
        assert.lengthOf(withoutActivities.proposedPlans, 1);
        assert.lengthOf(withoutActivities.checkpoints, 1);
        assert.deepEqual(
          withoutActivities.pendingInteractions?.map((interaction) => interaction.requestId),
          ["approval-open"],
        );
        assert.isTrue(withoutActivities.hasPendingApprovals);
        assert.isFalse(withoutActivities.hasPendingUserInput);
        assert.isTrue(withoutActivities.hasActionableProposedPlan);
        assert.equal(withoutActivities.session?.activeTurnId, asTurnId("turn-1"));
        assert.equal(
          withoutActivities.latestTurn?.assistantMessageId,
          asMessageId("message-assistant"),
        );
        // Missing and soft-deleted threads read as none, exactly like the full detail.
        for (const absentId of [
          asThreadId("thread-detail-without-activities-missing"),
          asThreadId("thread-detail-without-activities-deleted"),
        ]) {
          assert.isTrue(Option.isNone(yield* snapshotQuery.getThreadDetailById(absentId)));
          assert.isTrue(
            Option.isNone(yield* snapshotQuery.getThreadDetailWithoutActivitiesById(absentId)),
          );
        }
        // The activity query must not run at all: an activity row that cannot be
        // decoded fails the full detail but leaves this read untouched.
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence,
          created_at
        ) VALUES (
          'activity-undecodable', 'thread-detail-without-activities', 'turn-1', 'info',
          'tool.completed', 'Undecodable payload', '{not json', 12, '2026-10-01T00:00:06.750Z'
        )
      `;
        const fullError = yield* Effect.flip(snapshotQuery.getThreadDetailById(threadId));
        assert.equal(fullError._tag, "PersistenceDecodeError");
        assert.deepEqual(
          Option.getOrThrow(yield* snapshotQuery.getThreadDetailWithoutActivitiesById(threadId)),
          withoutActivities,
        );
        yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'activity-undecodable'`;
      }),
  );
});
