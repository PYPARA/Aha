import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { inspectMigrationBackupPlan } from "./MigrationBackup.ts";
import { migrationEntries, planMigrationLineageAliasRepairs, runMigrations } from "./Migrations.ts";
import ImageGenerationMigration from "./Migrations/135_ImageGeneration.ts";
import ActivityIndexMigration from "./Migrations/137_ProjectionMessageTurnActivityIndex.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const expectedTracker = migrationEntries.map(([id, name]) => ({ migration_id: id, name }));
const readTracker = (sql: SqlClient.SqlClient) =>
  sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;

it.effect(
  "upgrades legacy Aha drawing 132 without skipping upstream migrations or losing data",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 131 });
      // Reproduce the schema and tracker written by the committed Aha v1.0.1 build.
      yield* ImageGenerationMigration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (132, 'ImageGeneration')`;
      yield* sql`INSERT INTO image_providers VALUES ('provider', '{"name":"Preserved provider"}')`;
      yield* sql`INSERT INTO image_provider_models VALUES ('provider', 'model', 0, '{"source":"manual"}')`;
      yield* sql`INSERT INTO image_jobs VALUES ('job', 'request', 'provider', 'completed', '2026-10-12', '{"prompt":"Preserved job"}')`;
      yield* sql`INSERT INTO image_assets VALUES ('asset', 'hash', '2026-10-12', '{"path":"drawing/assets/original.png"}')`;
      yield* sql`INSERT INTO image_job_assets VALUES ('job', 'asset', 'output', 0)`;
      yield* sql`INSERT INTO image_drafts VALUES ('draft', '2026-10-12', '{"prompt":"Preserved draft"}')`;
      yield* sql`INSERT INTO image_draft_assets VALUES ('draft', 'asset')`;
      const tables = [
        "image_providers",
        "image_provider_models",
        "image_jobs",
        "image_assets",
        "image_job_assets",
        "image_drafts",
        "image_draft_assets",
      ];
      const readDrawing = () => Effect.forEach(tables, (table) => sql`SELECT * FROM ${sql(table)}`);
      const before = yield* readDrawing();
      const prefixBefore = (yield* readTracker(sql)).filter((row) => row.migration_id <= 131);
      const backup = yield* inspectMigrationBackupPlan;
      assert.deepStrictEqual(backup, { sourceVersion: "v132", targetVersion: 137 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [132, 133, 134, 135, 136, 137],
      );
      assert.deepStrictEqual(yield* readDrawing(), before);
      const tracker = yield* readTracker(sql);
      assert.deepStrictEqual(tracker, expectedTracker);
      assert.deepStrictEqual(
        tracker.filter((row) => row.migration_id <= 131),
        prefixBefore,
      );
      // Verify schema effects, beyond tracker rows alone.
      const turnColumns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('projection_turns')`;
      assert.include(
        turnColumns.map((row) => row.name),
        "started_without_git_workspace",
      );
      const threadColumns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('projection_threads')`;
      assert.include(
        threadColumns.map((row) => row.name),
        "fork_source_message_id",
      );
      const view = yield* sql<{
        sql: string;
      }>`SELECT sql FROM sqlite_master WHERE name = 'external_mcp_active_capacity_claims'`;
      assert.include(view[0]!.sql, "pending_turns");
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readDrawing(), before);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("adds drawing to a native Synara 1.0.3 database and supports a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 134 });
    const before = yield* sql`SELECT name FROM sqlite_master WHERE name = 'image_jobs'`;
    assert.lengthOf(before, 0);
    assert.deepStrictEqual(yield* runMigrations(), [
      [135, "ImageGeneration"],
      [136, "ImageEditDocuments"],
      [137, "ProjectionMessageTurnActivityIndex"],
    ]);
    assert.deepStrictEqual(yield* readTracker(sql), expectedTracker);
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('image_jobs', 'image_drafts', 'image_assets')`;
    assert.lengthOf(tables, 3);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("does not classify an unrelated or mixed lineage as the known Aha drawing alias", () =>
  Effect.sync(() => {
    const prefix = new Map(
      migrationEntries.filter(([id]) => id <= 131).map(([id, name]) => [id, name]),
    );
    const known = new Map<number, string>(prefix);
    known.set(132, "ImageGeneration");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(known), [
      { kind: "remove", migrationId: 132 },
    ]);
    known.set(130, "UnrecognizedMigration");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(known), []);
    const unrelated = new Map<number, string>(prefix);
    unrelated.set(132, "UnrecognizedMigration");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(unrelated), []);
  }),
);

for (const priorId of [135, 136] as const) {
  it.effect(`upgrades Aha ${priorId} without renumbering drawing or editing documents`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: priorId });
      yield* sql`INSERT INTO image_jobs VALUES ('preserved-job', 'request', 'provider', 'completed', '2026-10-16', '{"prompt":"Keep"}')`;
      if (priorId === 136) {
        yield* sql`INSERT INTO image_edit_documents VALUES ('document', '2026-10-16', '{"layers":[]}')`;
        yield* sql`INSERT INTO image_edit_document_assets VALUES ('document', 'asset')`;
        yield* sql`INSERT INTO image_job_documents VALUES ('preserved-job', 'document')`;
        yield* sql`INSERT INTO image_draft_documents VALUES ('draft', 'document')`;
      }
      const beforeTracker = yield* readTracker(sql);
      const jobs = yield* sql`SELECT * FROM image_jobs`;
      const documents = priorId === 136 ? yield* sql`SELECT * FROM image_edit_documents` : [];
      assert.deepStrictEqual(yield* inspectMigrationBackupPlan, {
        sourceVersion: `v${priorId}`,
        targetVersion: 137,
      });
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        priorId === 135 ? [136, 137] : [137],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM image_jobs`, jobs);
      if (priorId === 136) {
        assert.deepStrictEqual(yield* sql`SELECT * FROM image_edit_documents`, documents);
        assert.deepStrictEqual(yield* sql`SELECT * FROM image_edit_document_assets`, [
          { document_id: "document", asset_id: "asset" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM image_job_documents`, [
          { job_id: "preserved-job", document_id: "document" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM image_draft_documents`, [
          { draft_id: "draft", document_id: "document" },
        ]);
      }
      assert.deepStrictEqual(
        (yield* readTracker(sql)).filter((row) => row.migration_id <= priorId),
        beforeTracker,
      );
      assert.deepStrictEqual(yield* readTracker(sql), expectedTracker);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect(
  "imports native Synara 135 through the reviewed alias and keeps its existing activity index",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 134 });
      yield* ActivityIndexMigration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (135, 'ProjectionMessageTurnActivityIndex')`;
      const beforeIndex =
        yield* sql`SELECT sql FROM sqlite_master WHERE name = 'idx_projection_thread_messages_turn_activity'`;
      assert.deepStrictEqual(yield* inspectMigrationBackupPlan, {
        sourceVersion: "v135",
        targetVersion: 137,
      });
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        [135, 136, 137],
      );
      assert.deepStrictEqual(yield* readTracker(sql), expectedTracker);
      assert.deepStrictEqual(
        yield* sql`SELECT sql FROM sqlite_master WHERE name = 'idx_projection_thread_messages_turn_activity'`,
        beforeIndex,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("creates the complete fresh lineage and the exact activity-index columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.isNull(yield* inspectMigrationBackupPlan);
    yield* runMigrations();
    assert.deepStrictEqual(yield* readTracker(sql), expectedTracker);
    const columns = yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_index_info('idx_projection_thread_messages_turn_activity')`;
    assert.deepStrictEqual(
      columns.map((row) => row.name),
      ["thread_id", "turn_id", "updated_at"],
    );
    assert.isNull(yield* inspectMigrationBackupPlan);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("does not repair mixed or newer native-index trackers through the new alias", () =>
  Effect.sync(() => {
    const native = new Map<number, string>(
      migrationEntries.filter(([id]) => id <= 134).map(([id, name]) => [id, name]),
    );
    native.set(135, "ProjectionMessageTurnActivityIndex");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(native), [
      { kind: "remove", migrationId: 135 },
    ]);
    for (const [id, name] of [
      [130, "UnexpectedMigration"],
      [136, "FutureSynaraMigration"],
      [138, "FutureAhaMigration"],
    ] as const) {
      const mixed = new Map(native);
      mixed.set(id, name);
      assert.deepStrictEqual(planMigrationLineageAliasRepairs(mixed), []);
    }
  }),
);
