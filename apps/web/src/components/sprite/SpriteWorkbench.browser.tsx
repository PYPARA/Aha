import "../../index.css";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sliceFrames, type SpriteProject } from "./spriteModel";
import type { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import SpriteWorkbench from "./SpriteWorkbench";
import { newSpriteProject } from "./spriteModel";
import { unzipSync, strFromU8 } from "fflate";
const mocks = vi.hoisted(() => ({
  menu: vi.fn(),
  copyImage: vi.fn(async (_blob: Blob, _isCurrent: () => boolean) => {}),
  download: vi.fn(),
  save: vi.fn(async (_project: import("./spriteModel").SpriteProject) => {}),
  upload: vi.fn(),
  attach: vi.fn(async (_thread: string, _files: File[]) => {}),
  sync: vi.fn(
    async (
      _input?: import("@synara/contracts").SpriteCommand,
    ): Promise<import("@synara/contracts").SpriteState> => ({ context: null, runs: [] }),
  ),
  imageUrl: vi.fn(() => ""),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useBlocker: () => {} }));
vi.mock("~/store", () => ({
  useStore: (select: (state: { threadShellById: Record<string, unknown> }) => unknown) =>
    select({ threadShellById: {} }),
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ contextMenu: { show: mocks.menu } }) }));
vi.mock("./spriteClipboard", () => ({ copySpriteSourceToClipboard: mocks.copyImage }));
vi.mock("~/lib/browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("./spriteStorage", () => ({
  saveSpriteProject: mocks.save,
  deleteSpriteProject: vi.fn(),
  spriteErrorMessage: (e: Error) => e.message,
}));
vi.mock("../drawing/useDrawing", () => ({
  useImageProviders: () => ({ data: [] }),
  useDrawingEvents: () => {},
  drawingApi: () => ({ spriteCommand: mocks.sync, onEvent: () => () => {} }),
  uploadDrawingImage: mocks.upload,
  imageUrl: mocks.imageUrl,
}));
vi.mock("../drawing/DrawingPickers", () => ({ DrawingModelPicker: () => null }));
vi.mock("./SpriteChat", () => ({
  SpriteChat: ({
    project,
    attachmentBridge,
    onThread,
  }: {
    project: SpriteProject;
    attachmentBridge: EmbeddedChatAttachments;
    onThread: (id: string) => Promise<void>;
  }) => {
    useEffect(
      () =>
        attachmentBridge.register(project.activeThreadId!, (files) =>
          mocks.attach(project.activeThreadId!, files),
        ),
      [attachmentBridge, project.activeThreadId],
    );
    return (
      <div>
        <span>Conversation fixture</span>
        <button onClick={() => void onThread("thread-b")}>Switch fixture conversation</button>
      </div>
    );
  },
}));
beforeEach(async () => {
  await page.viewport(1440, 1000);
  mocks.menu.mockReset();
  mocks.copyImage.mockReset();
  mocks.copyImage.mockResolvedValue(undefined);
  mocks.download.mockClear();
  mocks.save.mockClear();
  mocks.attach.mockClear();
  mocks.sync.mockReset();
  mocks.sync.mockResolvedValue({ context: null, runs: [] });
  mocks.imageUrl.mockReset();
  mocks.imageUrl.mockReturnValue("");
  mocks.upload.mockReset();
  mocks.upload.mockResolvedValue({ id: "reference-asset" });
});
afterEach(async () => {
  await cleanup();
  document.querySelectorAll("[data-sprite-test-host]").forEach((host) => host.remove());
});
async function mountSheet(fifty = false, configure?: (project: SpriteProject) => void) {
  const c = document.createElement("canvas");
  c.width = fifty ? 400 : 32;
  c.height = fifty ? 8 : 24;
  const ctx = c.getContext("2d")!;
  // Two visible cells in row 1, three in row 2, row 3 entirely empty.
  ctx.fillStyle = "red";
  ctx.fillRect(1, 1, 4, 5);
  ctx.fillRect(9, 1, 4, 5);
  ctx.fillStyle = "blue";
  for (let i = 0; i < 3; i++) ctx.fillRect(i * 8 + 1, 9, 4, 5);
  if (fifty) {
    ctx.fillStyle = "purple";
    for (let i = 0; i < 50; i++) ctx.fillRect(i * 8 + 1, 1, 4, 5);
  }
  const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), "image/png"));
  const p = newSpriteProject();
  p.name = "Fox";
  p.threadIds = ["thread-a", "thread-b"];
  p.activeThreadId = "thread-a";
  p.sources = [{ id: "sheet", name: "sheet.png", width: c.width, height: c.height, blob }];
  p.actions[0]!.frames = [
    { id: "whole", sourceId: "sheet", x: 0, y: 0, width: 32, height: 24, offsetX: 0, offsetY: 0 },
  ];
  if (fifty) {
    p.width = 8;
    p.height = 8;
    p.actions[0]!.frames = sliceFrames(p.sources[0]!, {
      mode: "grid",
      columns: 50,
      rows: 1,
      width: 8,
      height: 8,
      margin: 0,
      gap: 0,
    });
  }
  configure?.(p);
  const host = document.createElement("div");
  host.dataset.spriteTestHost = "true";
  host.style.cssText = "height:100vh;display:flex;";
  document.body.append(host);
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SpriteWorkbench initialProject={p} onBack={async () => {}} />
    </QueryClientProvider>,
    { container: host },
  );
  return host;
}
it("keeps the full plan in conversation and shows only a navigation hint in the workbench", async () => {
  let state: import("@synara/contracts").SpriteState = {
    context: null,
    runs: [],
    plans: [
      {
        id: "plan",
        projectId: "project",
        threadId: "thread-a",
        turnId: "turn",
        requestId: "request",
        version: 1,
        status: "draft",
        confirmedAt: null,
        createdAt: "2026-10-14T00:00:00.000Z",
        configuration: {
          kind: "character",
          mode: "combined",
          prompt: "A pixel art fox character.",
          actions: [],
          references: [],
          providerId: "drawing",
          model: "gpt-image",
          width: 256,
          height: 256,
          background: "transparent",
          chromaKey: "#00ff00",
          parameters: { n: 1, size: "auto", quality: "auto", outputFormat: "png" },
        },
      },
    ],
  };
  mocks.sync.mockImplementation(async (input) => {
    if (input?.operation === "update-plan") {
      const plan = state.plans![0]!;
      state = {
        ...state,
        plans: [{ ...plan, configuration: input.configuration!, version: plan.version + 1 }],
      };
    }
    return structuredClone(state);
  });
  const host = await mountSheet(false, (project) => {
    project.id = "project";
  });
  await expect.element(page.getByText("A plan is awaiting confirmation")).toBeVisible();
  expect(host.querySelector('section[aria-label="Sprite generation plan"]')).toBeNull();
  await page.getByRole("button", { name: "Go to conversation" }).click();
  expect(sessionStorage.getItem("aha-sprite-plan-focus")).toBe("plan");
});
it("offers copy alongside all source operations from both menus and reports clipboard failures", async () => {
  await mountSheet();
  mocks.menu.mockResolvedValueOnce("copy-image");
  await userEvent.click(page.getByRole("button", { name: "sheet.png sheet.png", exact: true }), {
    button: "right",
  });
  expect(mocks.menu.mock.calls.at(-1)?.[0].map((item: { id: string }) => item.id)).toEqual([
    "copy-image",
    "rename",
    "attach",
    "delete",
  ]);
  await expect.element(page.getByText("Image copied to clipboard.", { exact: true })).toBeVisible();
  expect(mocks.copyImage.mock.calls[0]![1]()).toBe(true);
  const image = await createImageBitmap(mocks.copyImage.mock.calls[0]![0]);
  expect([image.width, image.height]).toEqual([32, 24]);
  image.close();
  mocks.menu.mockResolvedValueOnce("copy-image");
  mocks.copyImage.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  expect(mocks.menu.mock.calls.at(-1)?.[0].map((item: { id: string }) => item.id)).toEqual([
    "copy-image",
    "rename",
    "attach",
    "delete",
  ]);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Clipboard unavailable");
  await expect
    .element(page.getByText("Image copied to clipboard.", { exact: true }))
    .not.toBeInTheDocument();
  mocks.menu.mockResolvedValueOnce("attach");
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  await expect.poll(() => mocks.attach.mock.calls.length).toBe(1);
});
it("keeps the copied source fixed across selection changes and invalidates it when removed", async () => {
  let original: Blob | undefined;
  await mountSheet(false, (p) => {
    original = p.sources[0]!.blob;
    p.sources.push({ ...p.sources[0]!, id: "second-source", name: "second.png" });
  });
  let finish!: () => void;
  mocks.copyImage.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.menu.mockResolvedValueOnce("copy-image");
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  await expect.poll(() => mocks.copyImage.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "second.png second.png", exact: true }).click();
  expect(mocks.copyImage.mock.calls[0]![0]).toBe(original);
  expect(mocks.copyImage.mock.calls[0]![1]()).toBe(true);
  await expect
    .element(page.getByText("Image copied to clipboard.", { exact: true }))
    .not.toBeInTheDocument();
  finish();
  await expect.element(page.getByText("Image copied to clipboard.", { exact: true })).toBeVisible();

  mocks.copyImage.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.menu.mockResolvedValueOnce("copy-image");
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  await expect.poll(() => mocks.copyImage.mock.calls.length).toBe(2);
  mocks.menu.mockResolvedValueOnce("delete");
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  expect(mocks.copyImage.mock.calls[1]![1]()).toBe(false);
  finish();
  await expect
    .element(page.getByText("Image copied to clipboard.", { exact: true }))
    .not.toBeInTheDocument();
});
it("defaults to a combined atlas of all non-empty actions even when the current action is empty", async () => {
  await mountSheet(false, (p) => {
    p.actions.push({ ...p.actions[0]!, id: "other", name: "other", frames: [] });
    p.selectedActionId = "other";
  });
  await expect
    .element(page.getByRole("combobox", { name: "Export format", exact: true }))
    .toHaveValue("combined");
  await expect
    .element(page.getByRole("checkbox", { name: "All actions", exact: true }))
    .toBeChecked();
  await expect.element(page.getByText("Empty actions skipped: 1", { exact: true })).toBeVisible();
  const download = page.getByRole("button", { name: "Download ZIP", exact: true });
  await expect.element(download).toBeEnabled();
  await download.click();
  await expect.poll(() => mocks.download.mock.calls.length).toBe(1);
  const files = unzipSync(
    new Uint8Array(await (mocks.download.mock.calls[0]![0] as Blob).arrayBuffer()),
  );
  expect(Object.keys(files).toSorted()).toEqual(["animation.json", "atlas.png"]);
  expect(JSON.parse(strFromU8(files["animation.json"]!)).actions).toHaveLength(1);
  await page.getByRole("checkbox", { name: "All actions", exact: true }).click();
  await expect.element(download).toBeDisabled();
});
it("disables download when all actions are empty", async () => {
  await mountSheet(false, (p) => {
    p.actions[0]!.frames = [];
  });
  await expect
    .element(page.getByRole("button", { name: "Download ZIP", exact: true }))
    .toBeDisabled();
});
it("imports each non-empty row as an action, then renames, copies, deletes and undoes from the sidebar", async () => {
  const host = await mountSheet();
  await page.getByRole("button", { name: "sheet.png sheet.png", exact: true }).click();
  await page.getByRole("spinbutton", { name: "columns", exact: true }).fill("4");
  await page.getByRole("spinbutton", { name: "rows", exact: true }).fill("3");
  await page.getByRole("button", { name: "Split rows into actions", exact: true }).click();
  await page.getByRole("textbox", { name: "Action name 1", exact: true }).fill("idle");
  await page.getByRole("textbox", { name: "Action name 2", exact: true }).fill("walk");
  await expect
    .element(page.getByRole("button", { name: "Create actions (2)", exact: true }))
    .toBeEnabled();
  await page.getByRole("button", { name: "Create actions (2)", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "idle 2", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "walk 3", exact: true })).toBeVisible();
  mocks.menu.mockResolvedValueOnce("rename");
  await page.getByRole("button", { name: "Action options: walk", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Action name", exact: true })
    .fill("run");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "run 3", exact: true })).toBeVisible();
  mocks.menu.mockResolvedValueOnce("duplicate");
  await page.getByRole("button", { name: "Action options: run", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "run copy 3", exact: true })).toBeVisible();
  mocks.menu.mockResolvedValueOnce("delete");
  await userEvent.click(page.getByRole("button", { name: "run 3", exact: true }), {
    button: "right",
  });
  await expect
    .element(page.getByRole("button", { name: "run 3", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "run 3", exact: true })).toBeVisible();
  await page.screenshot({
    path: "../../../../../output/playwright/sprite-row-actions.png",
    element: host,
  });
  for (const name of ["run", "run copy"]) {
    mocks.menu.mockResolvedValueOnce("delete");
    await page.getByRole("button", { name: `Action options: ${name}`, exact: true }).click();
  }
  mocks.menu.mockResolvedValueOnce("clear");
  await page.getByRole("button", { name: "Action options: idle", exact: true }).click();
  expect(mocks.menu.mock.calls.at(-1)?.[0].map((item: { id: string }) => item.id)).toEqual([
    "rename",
    "duplicate",
    "clear",
  ]);
  await expect.element(page.getByRole("button", { name: "idle 0", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "idle 2", exact: true })).toBeVisible();
  document.documentElement.classList.remove("dark");
  host.remove();
});
it("adds a cropped frame to the conversation, retries intake failure, and leaves source artwork intact", async () => {
  const host = await mountSheet();
  await page.getByRole("button", { name: "sheet.png sheet.png", exact: true }).click();
  await page.getByRole("spinbutton", { name: "columns", exact: true }).fill("4");
  await page.getByRole("spinbutton", { name: "rows", exact: true }).fill("3");
  await page.getByRole("button", { name: "Split rows into actions", exact: true }).click();
  await page.getByRole("button", { name: "Create actions (2)", exact: true }).click();
  await expect.poll(() => mocks.save.mock.calls.at(-1)?.[0].actions.length).toBe(2);
  mocks.attach.mockRejectedValueOnce(new Error("Attachment intake failed"));
  await page
    .getByRole("button", { name: "Add current frame to conversation", exact: true })
    .click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Attachment intake failed");
  await page
    .getByRole("button", { name: "Add current frame to conversation", exact: true })
    .click();
  await expect.poll(() => mocks.attach.mock.calls.length).toBe(2);
  expect(mocks.attach.mock.calls[1]![0]).toBe("thread-a");
  const image = mocks.attach.mock.calls[1]![1][0]!;
  const bitmap = await createImageBitmap(image);
  expect([bitmap.width, bitmap.height]).toEqual([8, 8]);
  bitmap.close();
  expect(mocks.save.mock.calls.at(-1)?.[0].sources).toHaveLength(1);
  expect(mocks.save.mock.calls.at(-1)?.[0].actions.map((a) => a.frames.length)).toEqual([2, 3]);
  expect(mocks.upload).not.toHaveBeenCalled();
  document.documentElement.classList.remove("dark");
  host.remove();
});
it("renames sources, confirms all affected actions when deleting, and restores them with undo", async () => {
  const host = await mountSheet();
  await page.getByRole("button", { name: "sheet.png sheet.png", exact: true }).click();
  await page.getByRole("spinbutton", { name: "columns", exact: true }).fill("4");
  await page.getByRole("spinbutton", { name: "rows", exact: true }).fill("3");
  await page.getByRole("button", { name: "Split rows into actions", exact: true }).click();
  await page.getByRole("button", { name: "Create actions (2)", exact: true }).click();
  mocks.menu.mockResolvedValueOnce("rename");
  await page.getByRole("button", { name: "Image options: sheet.png", exact: true }).click();
  await page.getByRole("textbox", { name: "Image name", exact: true }).fill("Fox sheet");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  mocks.menu.mockResolvedValueOnce("delete");
  await page.getByRole("button", { name: "Image options: Fox sheet", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("action-1: 2");
  await expect.element(page.getByRole("dialog")).toHaveTextContent("action-2: 3");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "action-1 0", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "action-2 0", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Image options: Fox sheet", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "action-1 2", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Image options: Fox sheet", exact: true }))
    .toBeVisible();
  document.documentElement.classList.remove("dark");
  host.remove();
});

it("selects five of fifty frames with Shift, copies an action, keeps a subset and undoes", async () => {
  const host = await mountSheet(true);
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.getByRole("button", { name: "Frame 6", exact: true }).click();
  await page.getByRole("button", { name: "Frame 10", exact: true }).click({ modifiers: ["Shift"] });
  for (let i = 6; i <= 10; i++)
    await expect
      .element(page.getByRole("button", { name: `Frame ${i}`, exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(page.getByRole("button", { name: "Frame 11", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "New action from selection", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Action name", exact: true })
    .fill("walk");
  await page.getByRole("button", { name: "Create action", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "idle 50", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "walk 5", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await page.getByRole("button", { name: "Frame 2", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Keep selected frames only", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "walk 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "walk 5", exact: true })).toBeVisible();
  await page.screenshot({
    path: "../../../../../output/playwright/sprite-compact-grid.png",
    element: host,
  });
  document.documentElement.classList.add("dark");
  await page.viewport(1100, 900);
  await page.screenshot({
    path: "../../../../../output/playwright/sprite-compact-dark-narrow.png",
    element: host,
  });
  document.documentElement.classList.remove("dark");
  host.remove();
});

it("previews and adopts selected generated actions, keeps unique ids and undoes the whole adoption", async () => {
  const { SpriteProjectDataSchema } = await import("@synara/contracts/spriteLibrarySchema");
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  canvas.getContext("2d")!.fillRect(4, 4, 8, 8);
  const image = canvas.toDataURL("image/png");
  mocks.imageUrl.mockReturnValue(image);
  const asset = {
    id: "frame",
    name: "frame.png",
    mimeType: "image/png" as const,
    url: image,
    thumbnailUrl: image,
    width: 16,
    height: 16,
    bytes: 100,
    createdAt: "2026-10-14T00:00:00.000Z",
  };
  const actions = ["idle", "walk", "jump"].map((name) => ({
    action: {
      id: name,
      name,
      description: name,
      enabled: true,
      frameCount: 1,
      fps: name === "jump" ? 20 : 12,
      loop: name !== "jump",
    },
    frames: [{ ...asset, id: `${name}-frame` }],
    warnings: [],
  }));
  const run: import("@synara/contracts").SpriteRun = {
    id: "run",
    planId: "plan",
    planVersion: 1,
    context: {
      projectId: "project",
      threadId: "thread-a",
      name: "Fox",
      providerId: "drawing",
      model: "model",
      referenceAssetId: null,
      action: "idle",
      frameCount: 1,
      fps: 12,
      width: 16,
      height: 16,
      background: "transparent",
      chromaKey: "#00ff00",
    },
    input: { kind: "animation", prompt: "fox actions", requestId: "request" },
    actions,
    source: asset,
    frames: actions.flatMap((o) => o.frames),
    jobId: "job",
    status: "ready",
    warnings: [],
    error: null,
    createdAt: asset.createdAt,
  };
  mocks.sync.mockResolvedValue({ context: null, runs: [run] });
  await mountSheet(false, (p) => {
    p.actions[0]!.id = "idle";
    p.selectedActionId = "idle";
  });
  await page.getByRole("button", { name: /Action animation.*ready.*candidates/ }).click();
  await page.getByRole("button", { name: "Open in frame editor", exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "Preview action" })).toBeVisible();
  await page.getByRole("checkbox", { name: "walk · 1 frames · 12 FPS" }).click();
  await page.getByRole("button", { name: "Add selected actions · 2" }).click();
  await expect
    .poll(() => mocks.save.mock.calls.at(-1)?.[0].adoptedCandidateIds)
    .toEqual(["run:frame:idle", "run:frame:jump"]);
  const adopted = mocks.save.mock.calls.at(-1)![0];
  expect(adopted.actions).toHaveLength(3);
  expect(
    adopted.sources.filter(
      (s: import("./spriteModel").SpriteSource) => s.usage !== "generated-frame",
    ),
  ).toHaveLength(1);
  expect(
    adopted.sources.filter(
      (s: import("./spriteModel").SpriteSource) => s.usage === "generated-frame",
    ),
  ).toHaveLength(2);
  expect(new Set(adopted.actions.map((a) => a.id)).size).toBe(3);
  expect(adopted.actions.find((a) => a.name === "jump")).toMatchObject({ fps: 20, loop: false });
  expect(adopted.provenance).toEqual(
    expect.arrayContaining([expect.objectContaining({ actionId: "jump", planId: "plan" })]),
  );
  // Confirm the desktop schema accepts the saved adoption keys, independent of generated ids.
  const { sources, ...data } = adopted;
  SpriteProjectDataSchema.parse({
    ...data,
    sources: sources.map((s, i) => ({
      id: s.id,
      name: s.name,
      width: s.width,
      height: s.height,
      mimeType: "image/png",
      file: `images/${String(i).padStart(64, "0")}.png`,
      assetId: s.assetId,
    })),
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => mocks.save.mock.calls.at(-1)?.[0].adoptedCandidateIds).toEqual([]);
  expect(mocks.save.mock.calls.at(-1)![0].actions).toHaveLength(1);
});
