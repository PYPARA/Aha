import { ImageAsset, ImageDraft, ImageJob, ImageProvider } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ImageGenerationRepository,
  type ImageGenerationRepositoryShape,
} from "../Services/ImageGenerationRepository";

const error = () => new Error("Could not read or write drawing history.");
const decode = <T>(schema: Schema.Codec<T>, rows: readonly { payload: string }[]): T[] =>
  rows.map((r) => Schema.decodeUnknownSync(schema)(JSON.parse(r.payload)));
export const ImageGenerationRepositoryLive = Layer.effect(
  ImageGenerationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const guard = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(error));
    const readJob = (rows: readonly { payload: string }[]) => decode(ImageJob, rows)[0] ?? null;
    const api: ImageGenerationRepositoryShape = {
      listProviders: () =>
        guard(
          sql<{ payload: string }>`SELECT payload FROM image_providers ORDER BY rowid`.pipe(
            Effect.map((rows) => decode(ImageProvider, rows)),
          ),
        ),
      saveProvider: (provider) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO image_providers (id, payload) VALUES (${provider.id}, ${JSON.stringify(provider)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`;
              yield* sql`DELETE FROM image_provider_models WHERE provider_id=${provider.id}`;
              for (const [position, model] of provider.models.entries())
                yield* sql`INSERT INTO image_provider_models (provider_id, model_id, position, payload) VALUES (${provider.id}, ${model.id}, ${position}, ${JSON.stringify(model)})`;
            }),
          ),
        ),
      deleteProvider: (id) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM image_provider_models WHERE provider_id=${id}`;
              yield* sql`DELETE FROM image_providers WHERE id=${id}`;
            }),
          ),
        ),
      listJobs: (input) =>
        guard(
          Effect.gen(function* () {
            let cursor: { at: string; id: string } | null = null;
            if (input.cursor) {
              try {
                const value = JSON.parse(input.cursor);
                if (!value || typeof value.at !== "string" || typeof value.id !== "string")
                  throw new Error("Invalid cursor");
                cursor = { at: value.at, id: value.id };
              } catch {
                return yield* Effect.fail(new Error("Invalid history cursor."));
              }
            }
            const rows = cursor
              ? yield* sql<{
                  payload: string;
                }>`SELECT payload FROM image_jobs WHERE created_at<${cursor.at} OR (created_at=${cursor.at} AND id<${cursor.id}) ORDER BY created_at DESC, id DESC LIMIT 31`
              : yield* sql<{
                  payload: string;
                }>`SELECT payload FROM image_jobs ORDER BY created_at DESC, id DESC LIMIT 31`;
            const jobs = decode(ImageJob, rows.slice(0, 30));
            const last = jobs.at(-1);
            return {
              jobs,
              nextCursor:
                rows.length > 30 && last
                  ? JSON.stringify({ at: last.createdAt, id: last.id })
                  : null,
            };
          }),
        ),
      activeJobs: () =>
        guard(
          sql<{
            payload: string;
          }>`SELECT payload FROM image_jobs WHERE status IN ('queued','running','saving') ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.map((rows) => decode(ImageJob, rows)),
          ),
        ),
      getJob: (id) =>
        guard(
          sql<{ payload: string }>`SELECT payload FROM image_jobs WHERE id=${id}`.pipe(
            Effect.map(readJob),
          ),
        ),
      getRequest: (id) =>
        guard(
          sql<{
            payload: string;
          }>`SELECT payload FROM image_jobs WHERE client_request_id=${id}`.pipe(
            Effect.map(readJob),
          ),
        ),
      saveJob: (job) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO image_jobs (id, client_request_id, provider_id, status, created_at, payload) VALUES (${job.id}, ${job.clientRequestId}, ${job.providerId}, ${job.status}, ${job.createdAt}, ${JSON.stringify(job)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload`;
              yield* sql`DELETE FROM image_job_assets WHERE job_id=${job.id}`;
              for (const [role, assets] of [
                ["input", job.inputs],
                ["mask", job.mask ? [job.mask] : []],
                ["output", job.outputs],
              ] as const)
                for (const [position, asset] of assets.entries())
                  yield* sql`INSERT INTO image_job_assets (job_id, asset_id, role, position) VALUES (${job.id}, ${asset.id}, ${role}, ${position})`;
            }),
          ),
        ),
      deleteJob: (id) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM image_job_assets WHERE job_id=${id}`;
              yield* sql`DELETE FROM image_jobs WHERE id=${id}`;
            }),
          ),
        ),
      getAsset: (id) =>
        guard(
          sql<{ payload: string }>`SELECT payload FROM image_assets WHERE id=${id}`.pipe(
            Effect.map((rows) => decode(ImageAsset, rows)[0] ?? null),
          ),
        ),
      findAsset: (hash) =>
        guard(
          sql<{ payload: string }>`SELECT payload FROM image_assets WHERE hash=${hash}`.pipe(
            Effect.map((rows) => decode(ImageAsset, rows)[0] ?? null),
          ),
        ),
      saveAsset: (asset, hash) =>
        guard(
          sql`INSERT INTO image_assets (id, hash, created_at, payload) VALUES (${asset.id}, ${hash}, ${asset.createdAt}, ${JSON.stringify(asset)})`.pipe(
            Effect.asVoid,
          ),
        ),
      getDraft: (id) =>
        guard(
          sql<{ payload: string }>`SELECT payload FROM image_drafts WHERE id=${id}`.pipe(
            Effect.map((rows) => decode(ImageDraft, rows)[0] ?? null),
          ),
        ),
      saveDraft: (draft) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO image_drafts (id, updated_at, payload) VALUES (${draft.id}, ${draft.updatedAt}, ${JSON.stringify(draft)}) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload`;
              yield* sql`DELETE FROM image_draft_assets WHERE draft_id=${draft.id}`;
              for (const id of new Set([
                ...draft.inputAssetIds,
                ...(draft.maskAssetId ? [draft.maskAssetId] : []),
              ]))
                yield* sql`INSERT INTO image_draft_assets (draft_id, asset_id) VALUES (${draft.id}, ${id})`;
            }),
          ),
        ),
      deleteDraft: (id) =>
        guard(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM image_draft_assets WHERE draft_id=${id}`;
              yield* sql`DELETE FROM image_drafts WHERE id=${id}`;
            }),
          ),
        ),
      unusedAssets: (before) =>
        guard(
          sql<{
            payload: string;
          }>`SELECT payload FROM image_assets a WHERE created_at<${before} AND NOT EXISTS(SELECT 1 FROM image_job_assets WHERE asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM image_draft_assets WHERE asset_id=a.id)`.pipe(
            Effect.map((rows) => decode(ImageAsset, rows)),
          ),
        ),
      deleteAsset: (id) => guard(sql`DELETE FROM image_assets WHERE id=${id}`.pipe(Effect.asVoid)),
    };
    return api;
  }),
);
