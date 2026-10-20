// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: providerModelCatalogCache.test.ts
// Purpose: Locks the durable catalog snapshot contract: atomic round trips,
//          path resolution under stateDir, and resilience to missing or
//          malformed files so a corrupt cache can never block server boot.
// Layer: Server provider tests
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderListModelsResult } from "@synara/contracts";
import { Effect, type FileSystem } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readProviderModelCatalogCache,
  resolveProviderModelCatalogCachePath,
} from "./providerModelCatalogCache.ts";
const CATALOG: ProviderListModelsResult = {
  models: [{ slug: "gpt-5", name: "GPT-5" }],
  source: "opencode-cli",
  cached: false,
};
let stateDir: string;
const filePath = () => resolveProviderModelCatalogCachePath({ stateDir });
const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "model-catalog-cache-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
describe("providerModelCatalogCache", () => {
  it("does not restore pre-provenance catalogs that could contain an unmarked fallback", async () => {
    mkdirSync(path.dirname(filePath()), { recursive: true });
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        entries: [{ key: "cursor-key", result: { ...CATALOG, source: "cursor.cli" }, storedAt: 1 }],
      }),
    );
    expect(await run(readProviderModelCatalogCache(filePath()))).toEqual([]);
  });
});
