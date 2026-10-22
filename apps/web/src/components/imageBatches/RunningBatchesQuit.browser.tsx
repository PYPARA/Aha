import "../../index.css";
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { DesktopBridge, DesktopQuitConfirmationRequest } from "@synara/contracts";
import { RunningChatsQuitCoordinator } from "../RunningChatsQuitCoordinator";
const mocks = vi.hoisted(() => ({
  reply: vi.fn(),
  request: null as ((request: DesktopQuitConfirmationRequest) => void) | null,
  list: vi.fn(),
  interrupt: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    imageBatches: { list: mocks.list },
    orchestration: { dispatchCommand: mocks.interrupt },
  }),
}));
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { resumeChatsAfterQuit: false }, updateSettings: vi.fn() }),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (text: string) => text }));
vi.mock("~/store", () => ({ useStore: { getState: () => ({ sidebarThreadSummaryById: {} }) } }));
const original = window.desktopBridge;
afterEach(async () => {
  await cleanup();
  if (original) window.desktopBridge = original;
  else delete window.desktopBridge;
  vi.clearAllMocks();
});
it("includes active batches in quit confirmation without treating batch IDs as chat interruptions", async () => {
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener: (request: DesktopQuitConfirmationRequest) => void) => {
      mocks.request = listener;
      return () => {};
    },
    replyQuitConfirmation: mocks.reply,
  } as unknown as DesktopBridge;
  mocks.list.mockResolvedValue({
    batches: [{ id: "batch", name: "Knowledge batch" }],
    nextCursor: null,
  });
  await render(<RunningChatsQuitCoordinator />);
  mocks.request!({ requestId: "quit-request", presentation: "in-app" });
  await expect.element(page.getByRole("alertdialog")).toHaveTextContent("Knowledge batch");
  expect(mocks.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "image-batch:batch", title: "Batch images: Knowledge batch" }],
    }),
  );
  await page.getByRole("button", { name: /Cancel/ }).click();
  expect(mocks.reply).toHaveBeenCalledWith({
    requestId: "quit-request",
    phase: "decision",
    allow: false,
  });
  expect(mocks.interrupt).not.toHaveBeenCalled();
});
