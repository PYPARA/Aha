// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS, BrowserDiagnosticsStore } from "./browserDiagnostics";
const THREAD_ID = ThreadId.makeUnsafe("thread-diagnostics");
const TAB_ID = "025aa711-edf6-4c63-b957-d7c96a3fdabb";
const createRuntime = () => {
  const events = new EventEmitter();
  const sendCommand = vi.fn(async (_method: string, _params: unknown) => ({}));
  let attached = true;
  const webContents = {
    isDestroyed: () => false,
    once: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(),
      sendCommand,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    },
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    emit: (method: string, params: unknown) => events.emit("message", {}, method, params),
    sendCommand,
    listenerCount: () => events.listenerCount("message"),
    setAttached: (value: boolean) => {
      attached = value;
    },
  };
};
const sentMethods = (sendCommand: ReturnType<typeof createRuntime>["sendCommand"]): string[] =>
  sendCommand.mock.calls.map(([method]) => method);
const createDestroyableRuntime = (options?: { readonly removeListenerError?: Error }) => {
  const lifecycleEvents = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async () => ({}));
  let destroyed = false;
  const debuggerSession = {
    isAttached: () => true,
    attach: vi.fn(),
    sendCommand,
    on: debuggerEvents.on.bind(debuggerEvents),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (options?.removeListenerError) throw options.removeListenerError;
      debuggerEvents.removeListener(event, listener);
    }),
  };
  const webContents = {
    isDestroyed: () => destroyed,
    once: lifecycleEvents.once.bind(lifecycleEvents),
    removeListener: lifecycleEvents.removeListener.bind(lifecycleEvents),
  } as unknown as WebContents;
  Object.defineProperty(webContents, "debugger", {
    get: () => {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return debuggerSession;
    },
  });
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    destroy: () => {
      destroyed = true;
      lifecycleEvents.emit("destroyed");
    },
    debuggerListenerCount: () => debuggerEvents.listenerCount("message"),
    lifecycleListenerCount: () => lifecycleEvents.listenerCount("destroyed"),
  };
};
describe("browser diagnostics store", () => {
  it("quiesces capture on release, keeps history, and re-enables on the next acquisition", async () => {
    const { runtime, emit, sendCommand, listenerCount } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "before-release" }] });
    await diagnostics.quiesce(runtime);
    await diagnostics.quiesce(runtime);
    expect(sentMethods(sendCommand)).toEqual([
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
    ]);
    expect(listenerCount()).toBe(1);
    // Runtime/Log are disabled, but the shared listener keeps capturing Network.
    sendCommand.mockClear();
    const output = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });
    expect(sentMethods(sendCommand)).toEqual(["Runtime.enable", "Log.enable", "Network.enable"]);
    expect(listenerCount()).toBe(1);
    expect(output.entries.map((entry) => entry.kind === "console" && entry.text)).toEqual([
      "before-release",
    ]);
    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "after-reacquire" }] });
    const next = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: false,
      limit: 100,
    });
    expect(next.entries.map((entry) => entry.kind === "console" && entry.text)).toEqual([
      "before-release",
      "after-reacquire",
    ]);
    diagnostics.dispose(runtime);
  });
  it("quiesces after the idle window following the last acquisition", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, sendCommand } = createRuntime();
      const diagnostics = new BrowserDiagnosticsStore();
      await diagnostics.observe(runtime);
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS - 1000);
      // A new acquisition restarts the idle window.
      await diagnostics.observe(runtime);
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS - 1000);
      expect(sentMethods(sendCommand)).not.toContain("Runtime.disable");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentMethods(sendCommand)).toContain("Runtime.disable");
      expect(sentMethods(sendCommand)).toContain("Runtime.discardConsoleEntries");
      diagnostics.dispose(runtime);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps network capture and in-flight metadata through an idle quiesce", async () => {
    vi.useFakeTimers();
    const { runtime, emit } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    try {
      await diagnostics.observe(runtime);
      emit("Network.requestWillBeSent", {
        requestId: "before-idle",
        request: { url: "https://example.test/before", method: "POST" },
      });
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS);
      emit("Network.responseReceived", {
        requestId: "before-idle",
        response: { url: "https://example.test/before", status: 201 },
      });
      emit("Network.requestWillBeSent", {
        requestId: "while-idle",
        request: { url: "https://example.test/idle", method: "PATCH" },
      });
      emit("Network.loadingFailed", { requestId: "while-idle", errorText: "fixture failure" });
      const output = await diagnostics.read(runtime, {
        includeConsole: false,
        includeNetwork: true,
        limit: 100,
      });
      expect(output.entries).toMatchObject([
        { kind: "network", phase: "request", requestId: "before-idle", method: "POST" },
        {
          kind: "network",
          phase: "response",
          requestId: "before-idle",
          method: "POST",
          status: 201,
        },
        { kind: "network", phase: "request", requestId: "while-idle", method: "PATCH" },
        {
          kind: "network",
          phase: "failure",
          requestId: "while-idle",
          method: "PATCH",
          url: "https://example.test/idle",
        },
      ]);
    } finally {
      diagnostics.dispose(runtime);
      vi.useRealTimers();
    }
  });
  it("skips disable commands when the debugger already detached", async () => {
    const { runtime, sendCommand, listenerCount, setAttached } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    sendCommand.mockClear();
    setAttached(false);
    await diagnostics.quiesce(runtime);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);
    diagnostics.dispose(runtime);
  });
  it("does not touch the debugger when quiescing after WebContents is destroyed", async () => {
    const { runtime, destroy } = createDestroyableRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    destroy();
    await expect(diagnostics.quiesce(runtime)).resolves.toBeUndefined();
  });
});
