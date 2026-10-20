// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: DevinAdapter.test.ts
// Purpose: Compact adapter/runtime contract tests for Devin session configuration,
// model discovery, and plan-mode fail-closed behavior.
// Layer: Provider adapter tests
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import type { DevinAcpRuntimeInput } from "../acp/DevinAcpSupport.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { DevinAdapter } from "../Services/DevinAdapter.ts";
import { makeDevinAdapterLive } from "./DevinAdapter.ts";
function makeLifecycleAcpRuntime(
  prompt?: AcpSessionRuntimeShape["prompt"],
): AcpSessionRuntimeShape {
  return makeFakeAcpSessionRuntime({
    sessionId: "devin-test-session",
    ...(prompt ? { prompt } : {}),
  });
}
describe("Devin resume model pinning", () => {
  const sessionId = "devin-test-session";
  const startWith = (input: { resumeCursor?: unknown; modelVariant?: string }) => {
    const spawns: Array<Pick<DevinAcpRuntimeInput, "devinSettings" | "resumeSessionId">> = [];
    const layer = makeDevinAdapterLive(
      {},
      {
        makeAcpRuntime: (runtimeInput) =>
          Effect.sync(() => {
            spawns.push(runtimeInput);
            return makeLifecycleAcpRuntime();
          }),
        timeouts: { turnIdleMs: 30, toolIdleMs: 60 },
      },
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "devin-resume-model-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-resume-model");
        const result = yield* adapter
          .startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
            ...(input.modelVariant
              ? {
                  modelSelection: {
                    provider: "devin",
                    model: "gpt-6-astra",
                    options: { modelVariant: input.modelVariant },
                  },
                }
              : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          })
          .pipe(Effect.result);
        const live = yield* adapter.hasSession(threadId);
        yield* adapter.stopAll();
        return { result, live, spawns };
      }).pipe(Effect.provide(layer)),
    );
  };
  it("records the concrete model and reloads only a session created for it", async () => {
    const fresh = await startWith({ modelVariant: "gpt-6-astra-xhigh-priority" });
    expect(fresh.result._tag).toBe("Success");
    const cursor = fresh.result._tag === "Success" ? fresh.result.success.resumeCursor : undefined;
    expect(cursor).toEqual({
      schemaVersion: 1,
      sessionId,
      model: "gpt-6-astra-xhigh-priority",
    });
    const reloaded = await startWith({
      modelVariant: "gpt-6-astra-xhigh-priority",
      resumeCursor: cursor,
    });
    expect(reloaded.result._tag).toBe("Success");
    expect(reloaded.spawns.map((spawn) => spawn.resumeSessionId)).toEqual([sessionId]);
    expect(reloaded.result._tag === "Success" && reloaded.result.success.resumeCursor).toEqual(
      cursor,
    );
  });
  it.each([
    {
      name: "a session created for another variant (Fast turned off)",
      resumeCursor: { schemaVersion: 1, sessionId, model: "gpt-6-astra-xhigh-priority" },
    },
    {
      name: "a legacy cursor that never recorded its model",
      resumeCursor: { schemaVersion: 1, sessionId },
    },
  ])("refuses to reload $name before spawning Devin", async ({ resumeCursor }) => {
    const { result, live, spawns } = await startWith({
      modelVariant: "gpt-6-astra-xhigh",
      resumeCursor,
    });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ProviderAdapterProcessError);
      expect(result.failure).toMatchObject({ reason: "resume-state-unavailable" });
    }
    expect(spawns).toEqual([]);
    expect(live).toBe(false);
  });
  it("keeps reloading a legacy cursor when no model is requested", async () => {
    const { result, spawns } = await startWith({
      resumeCursor: { schemaVersion: 1, sessionId },
    });
    expect(result._tag).toBe("Success");
    expect(spawns.map((spawn) => spawn.resumeSessionId)).toEqual([sessionId]);
  });
});
