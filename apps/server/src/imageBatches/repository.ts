import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ImageBatchResult,
  ImageBatchState,
  imageBatchPlanCounts,
  type ImageBatchSummary,
  type ImageBatchListInput,
  type ImageBatchResultsInput,
} from "@synara/contracts";

export const batchActive = (s: ImageBatchState) => s.executions.some((e) => !e.finishedAt);
export const batchIssues = (s: ImageBatchState) =>
  s.executions
    .at(-1)
    ?.attempts.filter((a) => ["partial", "failed", "interrupted", "uncertain"].includes(a.status))
    .length ?? 0;
const decodeState = (text: string) => Schema.decodeUnknownSync(ImageBatchState)(JSON.parse(text));
const decodeResult = (text: string) => Schema.decodeUnknownSync(ImageBatchResult)(JSON.parse(text));

export class ImageBatchRepository {
  constructor(private sql: SqlClient.SqlClient) {}
  async get(id: string) {
    const rows = await Effect.runPromise(
      this.sql<{ payload: string }>`SELECT payload FROM image_batches WHERE id=${id}`,
    );
    return rows[0] ? decodeState(rows[0].payload) : null;
  }
  async forThread(threadId: string) {
    const rows = await Effect.runPromise(
      this.sql<{
        payload: string;
      }>`SELECT payload FROM image_batches WHERE thread_id=${threadId} AND removed=0`,
    );
    return rows[0] ? decodeState(rows[0].payload) : null;
  }
  async states(activeOnly = false) {
    const sql = this.sql;
    const rows = await Effect.runPromise(
      sql<{
        payload: string;
      }>`SELECT payload FROM image_batches ${activeOnly ? sql`WHERE active=1` : sql``}`,
    );
    return rows.map((r) => decodeState(r.payload));
  }
  async list(input: typeof ImageBatchListInput.Type) {
    const sql = this.sql;
    const cursor = input.cursor ? (JSON.parse(input.cursor) as { at: string; id: string }) : null;
    if (cursor && (typeof cursor.at !== "string" || typeof cursor.id !== "string"))
      throw new Error("Invalid batch cursor.");
    const where = input.filter === "archived" ? sql`AND archived=1` : sql`AND archived=0`;
    const state =
      input.filter === "active"
        ? sql`AND active=1`
        : input.filter === "issues"
          ? sql`AND issues>0`
          : input.filter === "draft"
            ? sql`AND json_array_length(json_extract(payload, '$.executions'))=0`
            : sql``;
    const query = input.query?.trim()
      ? sql`AND instr(lower(json_extract(payload, '$.name')),lower(${input.query.trim()}))>0`
      : sql``;
    const page = cursor
      ? sql`AND (updated_at<${cursor.at} OR (updated_at=${cursor.at} AND id<${cursor.id}))`
      : sql``;
    const rows = await Effect.runPromise(
      sql<{
        payload: string;
      }>`SELECT payload FROM image_batches WHERE removed=0 ${where} ${state} ${query} ${page} ORDER BY updated_at DESC,id DESC LIMIT 31`,
    );
    const states = rows.slice(0, 30).map((r) => decodeState(r.payload));
    const batches: ImageBatchSummary[] = [];
    for (const s of states) {
      const counts = imageBatchPlanCounts(s.tasks, s.defaults);
      const count = await Effect.runPromise(
        sql<{ n: number }>`SELECT count(*) AS n FROM image_batch_results WHERE batch_id=${s.id}`,
      );
      batches.push({
        id: s.id,
        name: s.name,
        updatedAt: s.updatedAt,
        archived: s.archived,
        tasks: s.tasks.length,
        enabled: counts.tasks,
        planned: counts.images,
        generated: Number(count[0]?.n ?? 0),
        issues: batchIssues(s),
        active: batchActive(s),
      });
    }
    const last = states.at(-1);
    return {
      batches,
      nextCursor:
        rows.length > 30 && last ? JSON.stringify({ at: last.updatedAt, id: last.id }) : null,
    };
  }
  async save(state: ImageBatchState, results: readonly ImageBatchResult[] = []) {
    const sql = this.sql;
    const refs = new Set([
      ...state.sources.flatMap((s) => (s.asset ? [s.asset.id] : [])),
      ...state.tasks.flatMap((t) => t.references.map((r) => r.assetId)),
      // Removed tasks can be restored, so their references stay protected until cleared.
      ...(state.removedTasks ?? []).flatMap((r) => r.task.references.map((ref) => ref.assetId)),
      ...(state.defaults.styleReferences ?? []).map((r) => r.assetId),
      ...state.proposals
        .filter((p) => p.status === "pending")
        .flatMap((p) =>
          p.tasks
            .flatMap((t) => t.references)
            .concat(p.defaults?.styleReferences ?? [])
            .map((r) => r.assetId),
        ),
      ...state.executions.flatMap((e) =>
        e.attempts.flatMap((a) => a.references.map((r) => r.assetId)),
      ),
    ]);
    await Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO image_batches (id,thread_id,version,updated_at,archived,removed,active,issues,payload)
        VALUES (${state.id},${state.threadId},${state.version},${state.updatedAt},${state.archived ? 1 : 0},${state.removed ? 1 : 0},${batchActive(state) ? 1 : 0},${batchIssues(state)},${JSON.stringify(state)})
        ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,version=excluded.version,updated_at=excluded.updated_at,
          archived=excluded.archived,removed=excluded.removed,active=excluded.active,issues=excluded.issues,payload=excluded.payload`;
          yield* sql`DELETE FROM image_batch_asset_refs WHERE batch_id=${state.id}`;
          for (const id of refs)
            yield* sql`INSERT INTO image_batch_asset_refs VALUES (${state.id},${id})`;
          for (const result of results)
            yield* sql`INSERT INTO image_batch_results (id,batch_id,task_id,attempt_id,position,asset_id,created_at,adopted,payload)
        VALUES (${result.id},${result.batchId},${result.taskId},${result.attemptId},${result.position},${result.asset.id},${result.createdAt},${result.adopted ? 1 : 0},${JSON.stringify(result)})
        ON CONFLICT(id) DO NOTHING`;
        }),
      ),
    );
  }
  async results(input: typeof ImageBatchResultsInput.Type) {
    const sql = this.sql;
    const cursor = input.cursor ? (JSON.parse(input.cursor) as { at: string; id: string }) : null;
    if (cursor && (typeof cursor.at !== "string" || typeof cursor.id !== "string"))
      throw new Error("Invalid result cursor.");
    const filter =
      input.filter === "adopted"
        ? sql`AND adopted=1`
        : input.filter === "unadopted"
          ? sql`AND adopted=0`
          : input.filter === "uncollected"
            ? sql`AND json_extract(payload,'$.collection') IS NULL`
            : sql``;
    const task = input.taskId ? sql`AND task_id=${input.taskId}` : sql``;
    const page = cursor
      ? sql`AND (created_at<${cursor.at} OR (created_at=${cursor.at} AND id<${cursor.id}))`
      : sql``;
    const count = await Effect.runPromise(
      sql<{
        n: number;
      }>`SELECT count(*) AS n FROM image_batch_results WHERE batch_id=${input.batchId} ${filter} ${task}`,
    );
    const rows = await Effect.runPromise(
      sql<{
        payload: string;
      }>`SELECT payload FROM image_batch_results WHERE batch_id=${input.batchId} ${filter} ${task} ${page} ORDER BY created_at DESC,id DESC LIMIT 101`,
    );
    const results = rows.slice(0, 100).map((r) => decodeResult(r.payload));
    const last = results.at(-1);
    return {
      results,
      total: Number(count[0]?.n ?? 0),
      nextCursor:
        rows.length > 100 && last ? JSON.stringify({ at: last.createdAt, id: last.id }) : null,
    };
  }
  /** Asset IDs among `assetIds` that are saved results of this batch. */
  async resultAssets(batchId: string, assetIds: readonly string[]) {
    if (!assetIds.length) return new Set<string>();
    const rows = await Effect.runPromise(
      this.sql<{
        assetId: string;
      }>`SELECT DISTINCT asset_id AS assetId FROM image_batch_results WHERE batch_id=${batchId} AND asset_id IN ${this.sql.in([...assetIds])}`,
    );
    return new Set(rows.map((row) => row.assetId));
  }
  async result(id: string) {
    const rows = await Effect.runPromise(
      this.sql<{ payload: string }>`SELECT payload FROM image_batch_results WHERE id=${id}`,
    );
    if (!rows[0]) throw new Error("Image result not found.");
    return decodeResult(rows[0].payload);
  }
  async updateResults(results: ImageBatchResult[]) {
    const sql = this.sql;
    await Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const r of results)
            yield* sql`UPDATE image_batch_results SET adopted=${r.adopted ? 1 : 0},payload=${JSON.stringify(r)} WHERE id=${r.id}`;
        }),
      ),
    );
  }
  async clearResults(batchId: string) {
    await Effect.runPromise(this.sql`DELETE FROM image_batch_results WHERE batch_id=${batchId}`);
  }
}
