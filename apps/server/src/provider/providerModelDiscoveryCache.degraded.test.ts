// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: providerModelDiscoveryCache.test.ts
// Purpose: Locks the shared model discovery cache semantics: fresh hits,
//          stale-while-revalidate, single-flight, project isolation, failure
//          replay, the timeout ceiling, and detachment from caller interrupts.
// Layer: Server provider tests
import type { ProviderListModelsResult } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderAdapterRequestError } from "./Errors.ts";
import {
  makeProviderModelDiscoveryCache,
  type PersistedModelCatalogEntryInput,
  type ProviderModelDiscoveryCacheKey,
} from "./providerModelDiscoveryCache.ts";
const KEY: ProviderModelDiscoveryCacheKey = {
  provider: "opencode",
  instanceId: null,
  binaryPath: "/bin/opencode",
  homePath: null,
  shadowHomePath: null,
  accountId: null,
  apiEndpoint: null,
  agentDir: null,
  serverUrl: null,
  serverPasswordKey: null,
  experimentalWebSockets: false,
  environmentKey: null,
  cwd: "/repo/a",
};
const CATALOG: ProviderListModelsResult = {
  models: [{ slug: "gpt-5", name: "GPT-5" }],
  source: "opencode-cli",
  cached: false,
};
function makeClock(start = 1000000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
describe("makeProviderModelDiscoveryCache", () => {
  it("retries a fallback catalog after the failure window without persisting it", async () => {
    const clock = makeClock();
    const snapshots: Array<ReadonlyArray<PersistedModelCatalogEntryInput>> = [];
    const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
      now: clock.now,
      failureTtlMs: 1000,
      onCatalogsChanged: (entries) => snapshots.push(entries),
    });
    const fallback = {
      ...CATALOG,
      models: [{ slug: "fallback", name: "Fallback" }],
      degraded: true,
    };
    let calls = 0;
    const discover = Effect.sync(() => (++calls === 1 ? fallback : CATALOG));
    expect(await Effect.runPromise(cache.lookup(KEY, discover))).toEqual(fallback);
    expect(await Effect.runPromise(cache.lookup(KEY, discover))).toEqual(fallback);
    expect(snapshots).toEqual([]);
    expect(cache.size()).toBe(0);
    clock.advance(1001);
    expect(await Effect.runPromise(cache.lookup(KEY, discover))).toEqual(CATALOG);
    expect(calls).toBe(2);
    expect(snapshots.at(-1)?.[0]?.result).toEqual(CATALOG);
  });
  it.each(["if-stale", "now"] as const)(
    "keeps the last good catalog through degraded %s refreshes and cooldown",
    async (refresh) => {
      const clock = makeClock();
      const snapshots: Array<ReadonlyArray<PersistedModelCatalogEntryInput>> = [];
      const cache = makeProviderModelDiscoveryCache<ProviderAdapterRequestError>({
        now: clock.now,
        freshTtlMs: 1000,
        failureTtlMs: 10000,
        onCatalogsChanged: (entries) => snapshots.push(entries),
      });
      await Effect.runPromise(cache.lookup(KEY, Effect.succeed(CATALOG)));
      clock.advance(61000);
      let calls = 0;
      const discover = Effect.sync(() => {
        calls += 1;
        return { ...CATALOG, models: [], degraded: true };
      });
      const expected = { ...CATALOG, cached: true };
      expect(await Effect.runPromise(cache.lookup(KEY, discover, refresh))).toEqual(expected);
      expect(await Effect.runPromise(cache.lookup(KEY, discover, refresh))).toEqual(expected);
      expect(await Effect.runPromise(cache.lookup(KEY, discover))).toEqual(expected);
      expect(calls).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(cache.size()).toBe(1);
      clock.advance(10001);
      expect(await Effect.runPromise(cache.lookup(KEY, Effect.succeed(CATALOG), refresh))).toEqual(
        CATALOG,
      );
    },
  );
});
