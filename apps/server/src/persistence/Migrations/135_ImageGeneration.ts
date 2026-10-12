import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS image_providers (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_provider_models (provider_id TEXT NOT NULL, model_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(provider_id, model_id))`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_jobs (id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_jobs_pagination ON image_jobs(created_at DESC, id DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_jobs_queue ON image_jobs(provider_id, status, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_assets (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_job_assets (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(job_id, role, position))`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_job_assets_asset ON image_job_assets(asset_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_drafts (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_draft_assets (draft_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(draft_id, asset_id))`;
});
