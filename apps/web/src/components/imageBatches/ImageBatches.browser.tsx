import "../../index.css";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImageBatchState, ImageBatchResult, DesktopBridge } from "@synara/contracts";
import { BatchProposals } from "./BatchProposals";
import { BatchExecution } from "./BatchExecution";
import { BatchResults } from "./BatchResults";
import { useResourceCollection } from "../resources/resourceLibrary";
import { useBatchCollectionWorker } from "../resources/useBatchCollectionWorker";
import type {
  ResourceCollectionOperation,
  ResourceCommand,
} from "@synara/contracts/resourceLibrary";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  preflight: vi.fn(),
  results: vi.fn(),
  listProviders: vi.fn(),
  navigate: vi.fn(),
  resource: vi.fn(),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (text: string) => text }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    imageBatches: mocks,
    imageGeneration: { listProviders: mocks.listProviders },
  }),
}));
let batch: ImageBatchState;
let original: DesktopBridge | undefined;
const onError = vi.fn();
function ReceiptHarness() {
  const receipts = useBatchCollectionWorker();
  return <button onClick={() => void receipts.refetch()}>Refresh copy receipts</button>;
}
const mount = (child: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <div style={{ height: 700, display: "flex", flexDirection: "column" }}>{child}</div>
    </QueryClientProvider>,
  );
beforeEach(() => {
  original = window.desktopBridge;
  window.desktopBridge = {
    resourceLibrary: { request: mocks.resource, onChanged: () => () => {} },
  } as unknown as DesktopBridge;
  batch = {
    id: "batch",
    name: "Batch",
    version: 2,
    projectId: null,
    threadId: null,
    brief: "",
    archived: false,
    removed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaults: {
      providerId: "mock",
      model: "image-model",
      parameters: { n: 2, outputFormat: "png" },
    },
    tasks: Array.from({ length: 6 }, (_, i) => ({
      id: "task" + i,
      name: "Task " + i,
      prompt: "Prompt " + i,
      enabled: true,
      references: [],
      sourceIds: [],
      ...(i === 0 ? { parameters: { n: 1 } } : {}),
    })),
    sources: [],
    proposals: [],
    executions: [],
  };
  mocks.command.mockImplementation(async () => batch);
  mocks.listProviders.mockResolvedValue([{ id: "mock", name: "Local mock" }]);
  mocks.preflight.mockResolvedValue({ version: 2, tasks: 6, images: 11, issues: [] });
  useResourceCollection.setState({ sources: null });
  onError.mockClear();
});
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
  if (original) window.desktopBridge = original;
  else delete window.desktopBridge;
  useResourceCollection.setState({ sources: null });
});
it("shows proposal differences without writing until Apply changes is clicked", async () => {
  batch.proposals = [
    {
      id: "proposal",
      requestId: "request",
      baseVersion: 2,
      threadId: "thread",
      turnId: "turn",
      createdAt: new Date().toISOString(),
      summary: "Reduce the first task to one image",
      warnings: ["Review unread source"],
      status: "pending",
      tasks: batch.tasks,
    },
  ];
  const before = {
    ...batch,
    tasks: batch.tasks.map((task) => ({ ...task, parameters: undefined })),
  };
  await mount(<BatchProposals batch={before} onError={onError} />);
  await page.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("12 → 11");
  expect(mocks.command).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Apply only", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledWith({
    operation: "apply-proposal",
    batchId: "batch",
    version: 2,
    proposalId: "proposal",
  });
});
it("applies a proposal and asks the workspace to open the generation check", async () => {
  batch.proposals = [
    {
      id: "proposal",
      requestId: "request",
      baseVersion: 2,
      threadId: "thread",
      turnId: "turn",
      createdAt: new Date().toISOString(),
      summary: "Rename the first task",
      warnings: [],
      status: "pending",
      tasks: batch.tasks.map((task, index) => (index ? task : { ...task, name: "Renamed" })),
    },
  ];
  const applied = { ...batch, version: 3 };
  mocks.command.mockResolvedValueOnce(applied);
  const onApplied = vi.fn();
  await mount(<BatchProposals batch={batch} onError={onError} onApplied={onApplied} />);
  await page.getByRole("button", { name: "Preview changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // The comparison is readable fields, not raw JSON.
  await expect.element(dialog).toHaveTextContent("Renamed");
  await expect.element(dialog.getByText('"references"')).not.toBeVisible();
  await page.getByRole("button", { name: "Apply and review generation", exact: true }).click();
  await vi.waitFor(() => expect(onApplied).toHaveBeenCalledWith(applied, true));
  expect(mocks.command).toHaveBeenCalledTimes(1);
  expect(mocks.command.mock.calls[0]![0]).toMatchObject({ operation: "apply-proposal" });
});
it("opens the generation check for the requested version without confirming", async () => {
  const opened = vi.fn();
  batch = { ...batch, defaults: { ...batch.defaults, stylePrompt: "Flat vector icons" } };
  await mount(
    <BatchExecution batch={batch} onError={onError} reviewVersion={2} onReviewOpened={opened} />,
  );
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Confirm image generation");
  // The summary shows the prompt that is actually sent: batch style first, then the task.
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Flat vector icons Prompt 0");
  expect(opened).toHaveBeenCalledTimes(1);
  expect(mocks.command).not.toHaveBeenCalled();
});
it("preflights 6 tasks and 11 images, shows channel names and sends exactly one explicit confirmation", async () => {
  await mount(<BatchExecution batch={batch} onError={onError} />);
  await page.getByRole("button", { name: "Review and generate", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("6 tasks · 11 images");
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Local mock");
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Unknown");
  expect(mocks.command).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Confirm generation", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledTimes(1);
  expect(mocks.command).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "confirm",
      batchId: "batch",
      version: 2,
      requestId: expect.any(String),
    }),
  );
});
it("keeps selection independent of adoption and copies only explicitly selected results", async () => {
  const asset = {
    id: "a".repeat(64),
    name: "image.png",
    mimeType: "image/png" as const,
    url: "data:image/png;base64,iVBORw0KGgo=",
    thumbnailUrl: "",
    width: 16,
    height: 16,
    bytes: 10,
    createdAt: new Date().toISOString(),
  };
  const results: ImageBatchResult[] = Array.from({ length: 3 }, (_, i) => ({
    id: "result" + i,
    batchId: "batch",
    executionId: "execution",
    attemptId: "attempt",
    taskId: "task0",
    taskName: "One",
    position: i,
    asset,
    prompt: "Prompt",
    model: "mock",
    parameters: { n: 3 },
    createdAt: new Date().toISOString(),
    adopted: false,
  }));
  mocks.results.mockResolvedValue({ results, total: 3, nextCursor: null });
  await mount(<BatchResults batch={batch} onError={onError} />);
  await page.getByRole("button", { name: "Select result: One 1", exact: true }).click();
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.resource).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Preview", exact: true })).toHaveFocus();
  await expect
    .element(page.getByRole("button", { name: "Select result: One 1", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Add to resource center", exact: true }).click();
  expect(useResourceCollection.getState().sources).toHaveLength(1);
  expect(useResourceCollection.getState().sources?.[0]?.origin).toMatchObject({
    kind: "image-batch",
    resultId: "result0",
    batchId: "batch",
  });
  expect(mocks.resource).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Mark adopted", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledWith({
    operation: "adopt",
    batchId: "batch",
    resultIds: ["result0"],
    adopted: true,
  });
});
it("retries a lost source-link acknowledgement even when the desktop receipt is unchanged", async () => {
  const operation: ResourceCollectionOperation = {
    id: "copy",
    libraryId: "library",
    directoryId: null,
    directoryKey: "key",
    createdAt: "",
    items: [
      {
        resultId: "result",
        assetId: "a".repeat(64),
        name: "image.png",
        origin: {
          kind: "image-batch",
          batchId: "batch",
          taskId: "task",
          attemptId: "attempt",
          resultId: "result",
        },
        status: "committed",
        resourceId: "resource",
      },
    ],
  };
  mocks.command.mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(batch);
  mocks.resource.mockImplementation(async (command: ResourceCommand) => {
    if (command.op === "listCollections") return structuredClone([operation]);
    if (command.op === "linkCollection") operation.items[0]!.status = "linked";
    if (command.op === "finishCollection") operation.released = true;
    return undefined;
  });
  await mount(<ReceiptHarness />);
  await expect.poll(() => mocks.command.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Refresh copy receipts" }).click();
  await expect.poll(() => operation.released).toBe(true);
  expect(mocks.resource.mock.calls.some(([command]) => command.op === "commitCollection")).toBe(
    false,
  );
  expect(mocks.command).toHaveBeenCalledWith({
    operation: "collection",
    batchId: "batch",
    resultId: "result",
    libraryId: "library",
    resourceId: "resource",
  });
});
