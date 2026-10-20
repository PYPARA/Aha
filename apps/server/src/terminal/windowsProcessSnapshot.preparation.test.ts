// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessChildrenMap } from "./processTreeKiller";
import {
  createPreparedWindowsTeardownProcessSnapshotObserver,
  createWindowsProcessSnapshotObserver,
  createWindowsTeardownProcessSnapshotObserver,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot";
function snapshot(
  entries: Array<{
    ppid: number;
    pid: number;
    command: string;
  }>,
): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const entry of entries) {
    const siblings = childrenByParentPid.get(entry.ppid) ?? [];
    siblings.push({ pid: entry.pid, command: entry.command });
    childrenByParentPid.set(entry.ppid, siblings);
  }
  return childrenByParentPid;
}
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("Windows process snapshots", () => {
  it("prepares once while alive and drains that table before a fresh teardown snapshot", async () => {
    const preparation = deferred<ProcessChildrenMap>();
    const staleSnapshot = snapshot([{ ppid: 100, pid: 101, command: "provider.exe" }]);
    const freshSnapshot = snapshot([
      { ppid: 100, pid: 101, command: "provider.exe" },
      { ppid: 101, pid: 102, command: "late-worker.exe" },
    ]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    await Promise.resolve();
    expect(worker.capture).toHaveBeenCalledTimes(1);
    const first = observer.captureWithin(3000);
    const second = observer.captureWithin(3000);
    expect(worker.capture).toHaveBeenCalledTimes(1);
    preparation.resolve(staleSnapshot);
    await expect(Promise.all([first, second])).resolves.toEqual([freshSnapshot, freshSnapshot]);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });
  it("completes cold initialization before admission without extending subsequent snapshot probes", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const stalled = deferred<ProcessChildrenMap>();
    const staleSnapshot = snapshot([{ ppid: 100, pid: 101, command: "before-spawn.exe" }]);
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "owned-provider.exe" }]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValueOnce(freshSnapshot)
        .mockImplementation(() => stalled.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker,
      preparationTimeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(3500);
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(worker.capture).toHaveBeenCalledTimes(1);
    let ready = false;
    const prepared = observer.waitUntilReady().then((value) => {
      ready = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    preparation.resolve(staleSnapshot);
    await expect(prepared).resolves.toBe(true);
    await expect(observer.captureWithin(3000)).resolves.toBe(freshSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    let settled = false;
    const capture = observer.captureWithin(3000).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBeNull();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    observer.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fails readiness at its initialization budget without publishing a late table", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => preparation.promise),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      preparationTimeoutMs: 5000,
    });
    let settled = false;
    const ready = observer.waitUntilReady().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(ready).resolves.toBe(false);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    preparation.resolve(new Map());
    await expect(observer.waitUntilReady()).resolves.toBe(false);
    observer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not count a failed preparation as successful readiness", async () => {
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("CIM unavailable")),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      preparationTimeoutMs: 5000,
    });
    await expect(observer.waitUntilReady()).resolves.toBe(false);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    observer.dispose();
  });
  it("cancels readiness before worker creation when disposed in the same turn", async () => {
    vi.useFakeTimers();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(new Map()),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker,
      preparationTimeoutMs: 5000,
    });
    const ready = observer.waitUntilReady();
    observer.dispose();
    await expect(ready).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.capture).not.toHaveBeenCalled();
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("counts preparation and the fresh query against the original teardown deadline", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const fresh = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockImplementation(() => fresh.promise),
      dispose: vi.fn(() => fresh.reject(new Error("worker disposed"))),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
    });
    let settled = false;
    const capture = observer.captureWithin(3000).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2000);
    preparation.resolve(new Map());
    await vi.advanceTimersByTimeAsync(999);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBeNull();
    observer.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps an expired preparation wait unknown and discards its late table", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "late-worker.exe" }]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
    });
    const expired = observer.captureWithin(250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(expired).resolves.toBeNull();
    expect(worker.capture).toHaveBeenCalledTimes(1);
    preparation.resolve(new Map());
    await vi.advanceTimersByTimeAsync(0);
    await expect(observer.captureWithin(250)).resolves.toBe(freshSnapshot);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });
  it("recovers failed preparation only through the existing bounded teardown backoff", async () => {
    vi.useFakeTimers();
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "provider.exe" }]);
    const failedWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("cold CIM unavailable")),
      dispose: vi.fn(),
    };
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn().mockReturnValueOnce(failedWorker).mockReturnValue(recoveredWorker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    await vi.advanceTimersByTimeAsync(0);
    expect(failedWorker.dispose).toHaveBeenCalledTimes(1);
    const capture = observer.captureWithin(500);
    await vi.advanceTimersByTimeAsync(99);
    expect(createWorker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBe(freshSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(2);
    observer.dispose();
  });
  it("disposes an in-flight preparation wait without publishing its late completion", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => preparation.promise),
      dispose: vi.fn(() => preparation.reject(new Error("worker disposed"))),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    const capture = observer.captureWithin(3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(1);
    expect(worker.dispose).not.toHaveBeenCalled();
    observer.dispose();
    await expect(capture).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(observer.captureWithin(3000)).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["ordinary", createWindowsProcessSnapshotObserver],
    ["teardown", createWindowsTeardownProcessSnapshotObserver],
    ["prepared", createPreparedWindowsTeardownProcessSnapshotObserver],
  ] as const)(
    "does not create or capture a %s worker after immediate disposal",
    async (_name, create) => {
      vi.useFakeTimers();
      const worker: ProcessChildrenSnapshotWorker = {
        capture: vi.fn().mockResolvedValue(new Map()),
        dispose: vi.fn(),
      };
      const createWorker = vi.fn(() => worker);
      const observer = create({ createWorker });
      const capture = observer.capture();
      // Dispose in the same turn, before the queued worker-creation callback runs.
      observer.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(createWorker).not.toHaveBeenCalled();
      expect(worker.capture).not.toHaveBeenCalled();
      expect(worker.dispose).not.toHaveBeenCalled();
      await expect(capture).resolves.toBeNull();
      await expect(observer.capture()).resolves.toBeNull();
      observer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
