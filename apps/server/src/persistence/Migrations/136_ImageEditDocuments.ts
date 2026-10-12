import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS image_edit_documents (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_edit_document_assets (document_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(document_id, asset_id))`;
  yield* sql`CREATE INDEX IF NOT EXISTS image_edit_document_assets_asset ON image_edit_document_assets(asset_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_job_documents (job_id TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(job_id, document_id))`;
  yield* sql`CREATE TABLE IF NOT EXISTS image_draft_documents (draft_id TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(draft_id, document_id))`;
});
