import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS image_batches (id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, version INTEGER NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL, removed INTEGER NOT NULL, active INTEGER NOT NULL, issues INTEGER NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_batches_list ON image_batches(removed, archived, updated_at DESC, id DESC)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_batch_results (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, position INTEGER NOT NULL, asset_id TEXT NOT NULL, created_at TEXT NOT NULL, adopted INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(attempt_id, position))`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_batch_results_page ON image_batch_results(batch_id, created_at DESC, id DESC)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_batch_asset_refs (batch_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(batch_id, asset_id))`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_batch_assets_asset ON image_batch_asset_refs(asset_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_jobs_origin ON image_jobs(json_extract(payload, '$.origin.kind'), created_at DESC, id DESC)`;
});
