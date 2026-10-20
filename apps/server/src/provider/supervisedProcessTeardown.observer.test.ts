// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { describe, expect, it, vi } from "vitest";
import { defaultProcessTreeKiller } from "../platform/processTreeController";
import type { TeardownProcessChildrenSnapshotObserver } from "../platform/windowsProcessSnapshot";
import {
  ProviderProcessExitUnprovenError,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";
function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
describe("teardownProviderProcessTree", () => {
  it("borrows the runtime observer for fresh Windows capture, liveness, and exit proof", async () => {
    const rootExit = deferred<void>();
    let current = new Map([
      [0, [{ pid: 91, command: "provider.exe", startedAt: "root-start" }]],
      [91, [{ pid: 92, command: "worker.exe", startedAt: "worker-start" }]],
    ]);
    const observer: TeardownProcessChildrenSnapshotObserver = {
      capture: vi.fn(async () => current),
      captureWithin: vi.fn(async () => current),
      retryDelayMs: () => 0,
      dispose: vi.fn(),
    };
    const signal = vi.spyOn(defaultProcessTreeKiller, "signal").mockImplementation(() => {
      current = new Map();
      rootExit.resolve(undefined);
    });
    try {
      const result = await teardownProviderProcessTree(
        { rootPid: 91, rootExited: rootExit.promise },
        { platform: "win32", windowsProcessSnapshotObserver: observer, ...deterministicClock() },
      );
      expect(result).toEqual({ escalated: false, signalErrors: [], capturedBeforeRootExit: true });
      expect(observer.captureWithin).toHaveBeenNthCalledWith(1, 3000);
      expect(observer.captureWithin).toHaveBeenNthCalledWith(2, 250);
      expect(observer.captureWithin).toHaveBeenNthCalledWith(3, 1500);
      expect(signal).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: "SIGTERM",
          tree: {
            descendants: [{ pid: 92, command: "worker.exe", startedAt: "worker-start" }],
            captureComplete: true,
          },
        }),
      );
      expect(observer.dispose).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
      observer.dispose();
    }
  });
  it("keeps failed borrowed Windows snapshots unproven after the root exits", async () => {
    const observer: TeardownProcessChildrenSnapshotObserver = {
      capture: vi.fn(async () => null),
      captureWithin: vi.fn(async () => null),
      retryDelayMs: () => 0,
      dispose: vi.fn(),
    };
    const signal = vi.spyOn(defaultProcessTreeKiller, "signal").mockImplementation(() => {});
    try {
      const failure = await teardownProviderProcessTree(
        { rootPid: 91, rootExited: Promise.resolve(), termGraceMs: 5, forceExitMs: 5 },
        { platform: "win32", windowsProcessSnapshotObserver: observer, ...deterministicClock() },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(failure).toMatchObject({
        rootExited: true,
        captureComplete: false,
        remainingDescendantPids: null,
      });
      expect(signal).toHaveBeenCalledTimes(2);
      for (const [input] of signal.mock.calls) expect(input.includeRootTree).toBe(false);
      expect(observer.dispose).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
      observer.dispose();
    }
  });
});
