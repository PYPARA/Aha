import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  SpriteState,
  SpriteRun,
  SpriteGenerationPlan,
  SpriteCanonicalReference,
  SpriteContext,
  ImageAsset,
  type SpriteCommand,
} from "@synara/contracts";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function spriteImportOrigin(
  projectId: string,
  sourceAssetId: string,
  command: Pick<SpriteCommand, "configuration" | "context" | "importBranchId">,
) {
  const targetActionIds = (
    command.configuration?.actions.filter((a) => a.enabled).map((a) => a.id) ??
    (command.context?.selection?.actionId ? [command.context.selection.actionId] : [])
  ).toSorted();
  const branchId = command.importBranchId ?? "main";
  const requestId = `import-${createHash("sha256")
    .update(JSON.stringify([projectId, sourceAssetId, targetActionIds, branchId]))
    .digest("hex")}`;
  return { requestId, origin: { version: 1 as const, sourceAssetId, targetActionIds, branchId } };
}

/** Decode the container first; a broken sibling never hides valid tasks or references. */
export function recoverSpriteState(
  projectId: string,
  input: unknown,
  verifiedImports: ReadonlySet<string>,
) {
  const diagnostics: { path: string; message: string }[] = [];
  let migrated = false;
  const container = object(input) ? input : {};
  if (!object(input)) diagnostics.push({ path: "$", message: "Expected a sprite state object." });
  const decode = (schema: Schema.Codec<unknown>, value: unknown, path: string) => {
    try {
      return Schema.decodeUnknownSync(schema)(value);
    } catch (e) {
      diagnostics.push({ path, message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  };
  const result: Record<string, unknown> = { context: null, runs: [] };
  for (const [key, schema] of Object.entries(SpriteState.fields)) {
    if (["runs", "plans", "canonicalVersions", "recovery"].includes(key)) continue;
    if (container[key] !== undefined)
      result[key] = decode(schema, container[key], key) ?? (key === "context" ? null : undefined);
  }
  for (const [key, schema] of [
    ["runs", SpriteRun],
    ["plans", SpriteGenerationPlan],
    ["canonicalVersions", SpriteCanonicalReference],
  ] as const) {
    const values = container[key];
    if (values === undefined && key !== "runs") continue;
    if (!Array.isArray(values)) {
      diagnostics.push({ path: key, message: "Expected an array." });
      continue;
    }
    result[key] = values.flatMap((value, index) => {
      let record: unknown = value;
      if (
        key === "runs" &&
        object(value) &&
        object(value.input) &&
        typeof value.input.requestId === "string" &&
        value.input.requestId.startsWith("source:")
      ) {
        const sourceId = value.input.requestId.slice(7);
        // Narrowly repair the old local-import bug, never provider request IDs.
        if (
          verifiedImports.has(sourceId) &&
          value.jobId === null &&
          value.imageStatus === "imported" &&
          !value.planId &&
          !value.submissionPhase &&
          !value.submissionInputs &&
          object(value.source) &&
          value.source.id === sourceId &&
          (!Array.isArray(value.candidates) ||
            value.candidates.every(
              (c) => object(c) && object(c.source) && c.source.id === sourceId,
            ))
        ) {
          try {
            const context = Schema.decodeUnknownSync(SpriteContext)(value.context);
            const configuration =
              value.configuration === undefined
                ? undefined
                : Schema.decodeUnknownSync(SpriteRun.fields.configuration)(value.configuration);
            const imported = spriteImportOrigin(projectId, sourceId, { context, configuration });
            record = {
              ...value,
              input: { ...value.input, requestId: imported.requestId },
              importOrigin: { ...imported.origin, legacyRequestId: value.input.requestId },
            };
            migrated = true;
          } catch {
            /* Keep invalid source records in the diagnostic backup. */
          }
        }
      }
      const valid = decode(schema, record, `${key}[${index}]`);
      return valid === undefined ? [] : [valid];
    });
  }
  const state = Schema.decodeUnknownSync(SpriteState)(result);
  return { state, migrated, diagnostics };
}
export function spriteRawAssetIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!object(value)) return;
    try {
      ids.add(Schema.decodeUnknownSync(ImageAsset)(value).id);
    } catch {
      /* Recurse through unknown records too. */
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === "sourceAssetId" || key === "referenceAssetId" || key === "derivedFrom") &&
        typeof item === "string" &&
        /^[\w-]{1,128}$/.test(item)
      )
        ids.add(item);
      walk(item);
    }
  };
  walk(raw);
  return ids;
}
