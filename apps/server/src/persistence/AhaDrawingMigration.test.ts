import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { inspectMigrationBackupPlan } from "./MigrationBackup.ts";
import { migrationEntries, planMigrationLineageAliasRepairs, runMigrations } from "./Migrations.ts";
import ImageGenerationMigration from "./Migrations/135_ImageGeneration.ts";
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
      assert.deepStrictEqual(backup, { sourceVersion: "v132", targetVersion: 135 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [132, 133, 134, 135],
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
    assert.deepStrictEqual(yield* runMigrations(), [[135, "ImageGeneration"]]);
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
