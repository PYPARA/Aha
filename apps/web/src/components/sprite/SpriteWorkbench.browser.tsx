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
import { DEFAULT_SPRITE_RENDER_SPEC } from "@synara/contracts";
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
  getSpriteProject: vi.fn(async () => ({ sources: [] })),
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
vi.mock("../RouteSurface", () => ({
  RouteSurfaceHeader: ({ children }: { children: import("react").ReactNode }) => (
    <header className="flex items-center gap-2 border-b p-3">{children}</header>
  ),
}));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await page.viewport(1440, 1000);
  mocks.menu.mockReset();
  mocks.copyImage.mockReset();
  mocks.copyImage.mockResolvedValue(undefined);
  mocks.download.mockClear();
  mocks.save.mockClear();
  mocks.save.mockResolvedValue(undefined);
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
  p.version = 1;
  p.renderSpec = undefined;
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
async function mountGroupedSheet(names = ["action-1", "action-2"]) {
  return mountSheet(false, (p) => {
    const frames = sliceFrames(p.sources[0]!, {
      mode: "grid",
      columns: 4,
      rows: 3,
      width: 8,
      height: 8,
      margin: 0,
      gap: 0,
    });
    p.width = 8;
    p.height = 8;
    p.actions = names.map((name, i) => ({
      id: `imported-${i}`,
      name,
      fps: 12,
      loop: true,
      frames: frames.slice(i * 4, i * 4 + (i ? 3 : 2)),
    }));
    p.selectedActionId = p.actions[0]!.id;
  });
}
it("starts v2 with character approval and reserves the editor width by folding the sidebars", async () => {
  const host = await mountSheet(false, (project) => {
    project.version = 2;
    project.renderSpec = { ...DEFAULT_SPRITE_RENDER_SPEC };
    project.width = 256;
    project.height = 256;
  });
  await expect
    .element(page.getByRole("button", { name: "Confirm character reference", exact: true }))
    .toBeDisabled();
  await expect.poll(() => host.querySelector(".sb-sidebar") !== null).toBe(true);
  await expect.poll(() => host.querySelector(".sb-inspector") !== null).toBe(true);
  await page.viewport(1150, 1000);
  await expect.poll(() => host.querySelector(".sb-inspector")).toBeNull();
  await expect.poll(() => host.querySelector(".sb-sidebar") !== null).toBe(true);
  await page.viewport(950, 1000);
  await expect.poll(() => host.querySelector(".sb-sidebar")).toBeNull();
  await page.getByRole("button", { name: "Open inspector", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("region", { name: "Inspector", exact: true })
        .getByText("Character settings", { exact: true }),
    )
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("region", { name: "Inspector", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Actions list", exact: true }).click();
  await page.getByRole("button", { name: "Image sources", exact: true }).click();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close panel");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("region", { name: "Image sources", exact: true }))
    .not.toBeInTheDocument();
  await page.screenshot({ path: "../../../node_modules/.cache/aha-staged-workbench-narrow.png" });
});
it("does not import conversation file drops as action frames", async () => {
  const host = await mountSheet();
  const target = host.querySelector("[data-sprite-chat]")!;
  const transfer = new DataTransfer();
  transfer.items.add(
    new File([new Uint8Array([137, 80, 78, 71])], "attachment.png", { type: "image/png" }),
  );
  const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  await expect.element(page.getByRole("button", { name: "idle 1", exact: true })).toBeVisible();
});
const configureCreationProject = (p: SpriteProject) => {
  p.id = "creation-test";
  p.version = 2;
  p.renderSpec = { mode: "illustration", logicalWidth: 256, logicalHeight: 256, outputScale: 1 };
};

it("opens character creation repeatedly without creating a plan and restores the local description", async () => {
  await mountSheet(false, configureCreationProject);
  const toolbar = page.getByRole("navigation", { name: "Sprite workflow" });
  await toolbar.getByRole("button", { name: "Character", exact: true }).click();
  await toolbar.getByRole("button", { name: "Generate character", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Creation description", exact: true })
    .fill("A silver wolf with a blue scarf");
  await toolbar.getByRole("button", { name: "Generate character", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Creation description", exact: true }))
    .toHaveValue("A silver wolf with a blue scarf");
  expect(
    mocks.sync.mock.calls.some(
      ([command]) => command?.operation === "propose" || command?.operation === "generate",
    ),
  ).toBe(false);
  await cleanup();
  document.querySelectorAll("[data-sprite-test-host]").forEach((el) => el.remove());
  await mountSheet(false, configureCreationProject);
  await expect
    .element(page.getByRole("textbox", { name: "Creation description", exact: true }))
    .toHaveValue("A silver wolf with a blue scarf");
  expect(mocks.sync.mock.calls.some(([command]) => command?.operation === "propose")).toBe(false);
});
it("asks the purpose of a canvas image before changing frames and keeps material pastes separate", async () => {
  const host = await mountSheet();
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 12;
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/png"),
  );
  const data = new DataTransfer();
  data.items.add(new File([blob], "pasted.png", { type: "image/png" }));
  const main = host.querySelector("main")!;
  main.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  await expect
    .element(page.getByRole("dialog", { name: "Import image usage", exact: true }))
    .toBeVisible();
  expect(mocks.save.mock.calls.at(-1)?.[0].actions[0]!.frames.length ?? 1).toBe(1);
  await page.getByRole("button", { name: "Add to image sources", exact: true }).click();
  await expect.poll(() => mocks.save.mock.calls.at(-1)?.[0].sources.length).toBe(2);
  expect(mocks.save.mock.calls.at(-1)?.[0].actions[0]!.frames).toHaveLength(1);
  const materials = host.querySelector(".sb-sidebar [data-sprite-image-input]")!;
  materials.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  await expect.poll(() => mocks.save.mock.calls.at(-1)?.[0].sources.length).toBe(3);
  expect(mocks.save.mock.calls.at(-1)?.[0].actions[0]!.frames).toHaveLength(1);
});
it("edits frame duration, preserves it when FPS changes and clears it back to inheritance", async () => {
  await mountSheet();
  await page.getByRole("spinbutton", { name: "Frame duration (ms)", exact: true }).fill("250");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("24");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => mocks.save.mock.calls.at(-1)?.[0].actions[0]!.frames[0]!.durationMs)
    .toBe(250);
  await expect.element(page.getByText("Custom frame duration", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use action FPS", exact: true }).click();
  await expect
    .poll(() => mocks.save.mock.calls.at(-1)?.[0].actions[0]!.frames[0]!.durationMs)
    .toBeUndefined();
  await expect
    .element(page.getByRole("spinbutton", { name: "Frame duration (ms)", exact: true }))
    .toHaveValue("42");
});
it("keeps playback controls visible at target sizes and effective 125% / 150% zoom", async () => {
  const host = await mountSheet();
  for (const [width, height, zoom] of [
    [1280, 800, 1],
    [1440, 900, 1],
    [1920, 1080, 1],
    [1440, 900, 1.25],
    [1440, 900, 1.5],
  ] as const) {
    await page.viewport(Math.floor(width / zoom), Math.floor(height / zoom));
    await expect
      .poll(() => host.querySelector(".sprite-workbench")!.getBoundingClientRect().width)
      .toBeLessThanOrEqual(window.innerWidth);
    await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    const controls = page
      .getByRole("button", { name: "Play", exact: true })
      .element()
      .getBoundingClientRect();
    expect(controls.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
});
it("opens the active conversation plan in the staged workbench", async () => {
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
  await expect.poll(() => mocks.sync.mock.calls.some(([i]) => i?.operation === "get")).toBe(true);
  expect(host.querySelector('section[aria-label="Sprite generation plan"]')).toBeNull();
  window.dispatchEvent(new CustomEvent("aha-sprite-plan-focus", { detail: "plan" }));
  await expect
    .poll(() => host.querySelector('section[aria-label="Sprite generation plan"]'))
    .not.toBeNull();
});
it("offers copy alongside all source operations from both menus and reports clipboard failures", async () => {
  await mountSheet();
  mocks.menu.mockResolvedValueOnce("copy-image");
  await page.getByRole("button", { name: "Image sources", exact: true }).click();
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
  await page.getByRole("button", { name: "Image sources", exact: true }).click();
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

  await page.getByRole("button", { name: "Image sources", exact: true }).click();
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
  await page
    .getByRole("navigation", { name: "Sprite workflow" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  await expect
    .element(page.getByRole("combobox", { name: "Export format", exact: true }))
    .toHaveTextContent("Combined PNG atlas + JSON");
  await expect.element(page.getByRole("checkbox", { name: /^idle/ })).toBeChecked();
  await expect.element(page.getByText("No adopted frames", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Sprite workflow" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  const download = page.getByRole("button", { name: "Export animation resources", exact: true });
  await expect.element(download).toBeEnabled();
  await download.click();
  await expect.poll(() => mocks.download.mock.calls.length).toBe(1);
  const files = unzipSync(
    new Uint8Array(await (mocks.download.mock.calls[0]![0] as Blob).arrayBuffer()),
  );
  expect(Object.keys(files).toSorted()).toEqual(["animation.json", "atlas.png"]);
  expect(JSON.parse(strFromU8(files["animation.json"]!)).actions).toHaveLength(1);
  await expect
    .poll(() => mocks.save.mock.calls.at(-1)?.[0].lastExport?.actionVersionIds?.length)
    .toBe(1);
  await page.getByRole("checkbox", { name: /^idle/ }).click();
  await expect.element(download).toBeDisabled();
});
it("disables download when all actions are empty", async () => {
  await mountSheet(false, (p) => {
    p.actions[0]!.frames = [];
  });
  await page
    .getByRole("navigation", { name: "Sprite workflow" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  await expect
    .element(page.getByRole("button", { name: "Export animation resources", exact: true }))
    .toBeDisabled();
});
it("renames, copies, deletes and undoes grouped imported actions from the sidebar", async () => {
  const host = await mountGroupedSheet(["idle", "walk"]);
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
    element: page.getByTestId("sprite-workbench"),
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
  const host = await mountGroupedSheet();
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
  const host = await mountGroupedSheet();
  await page.getByRole("button", { name: "Image sources", exact: true }).click();
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
  await page.getByRole("button", { name: "Image sources", exact: true }).click();
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
    element: page.getByTestId("sprite-workbench"),
  });
  document.documentElement.classList.add("dark");
  await page.viewport(1100, 900);
  await page.screenshot({
    path: "../../../../../output/playwright/sprite-compact-dark-narrow.png",
    element: page.getByTestId("sprite-workbench"),
  });
  document.documentElement.classList.remove("dark");
  host.remove();
});

async function candidateFixture() {
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
  return { run, image };
}
it("previews and adopts selected generated actions, keeps unique ids and undoes the whole adoption", async () => {
  const { SpriteProjectDataSchema } = await import("@synara/contracts/spriteLibrarySchema");
  const { run } = await candidateFixture();
  mocks.sync.mockResolvedValue({ context: null, runs: [run] });
  await mountSheet(false, (p) => {
    p.actions[0]!.id = "idle";
    p.selectedActionId = "idle";
  });
  await page.getByRole("button", { name: /^Generation tasks ·/ }).click();
  await page.getByRole("button", { name: "Review candidate", exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "Preview action" })).toBeVisible();
  await page.getByText("Select actions for adoption", { exact: true }).click();
  await page.getByRole("checkbox", { name: /^walk ·/ }).click();
  await page
    .getByRole("button", { name: "Confirm review and adopt selected (2)", exact: true })
    .click();
  mocks.save.mockImplementation(async (p) => {
    if (p.adoptedCandidateIds.length) throw new Error("Disk full");
  });
  await page.getByRole("button", { name: "Confirm action updates (1)", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Disk full");
  await expect
    .element(page.getByRole("button", { name: "jump 1", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  mocks.save.mockResolvedValue(undefined);
  await page
    .getByRole("button", { name: "Confirm review and adopt selected (2)", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm action updates (1)", exact: true }).click();
  await expect
    .poll(() => mocks.save.mock.calls.at(-1)?.[0].adoptedCandidateIds)
    .toEqual(["run:frame:idle", "run:frame:jump"]);
  const adopted = mocks.save.mock.calls.at(-1)![0];
  expect(adopted.actions).toHaveLength(2);
  expect(adopted.actionVersions?.filter((v) => v.action.id === "idle")).toHaveLength(2);
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
  expect(new Set(adopted.actions.map((a) => a.id)).size).toBe(2);
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
it("opens slicing directly from the character stage, saves a processing version and returns to review", async () => {
  const { run } = await candidateFixture();
  let state: import("@synara/contracts").SpriteState = {
    context: null,
    runs: [
      {
        ...run,
        selectedCandidateId: run.source!.id,
        candidates: [
          {
            id: run.source!.id,
            source: run.source!,
            frames: run.frames,
            actions: run.actions!,
            warnings: [],
            error: null,
            status: "ready",
            version: 1,
            processingVersionId: "v1",
          },
        ],
      },
    ],
  };
  mocks.sync.mockImplementation(async (input) => {
    if (input?.operation === "save-slicing")
      state = {
        ...state,
        runs: state.runs.map((r) => ({
          ...r,
          candidates: r.candidates!.map((c) =>
            Object.assign({}, c, {
              slice: input.slice!,
              version: 2,
              processingVersionId: "v2",
              actions: c.actions.map((o) => ({
                ...o,
                action: input.slice!.rows.find((row) => row.action.id === o.action.id)!.action,
              })),
            }),
          ),
        })),
      };
    return structuredClone(state);
  });
  await mountSheet(false, (p) => {
    p.id = "project";
    p.version = 2;
    p.renderSpec = { ...DEFAULT_SPRITE_RENDER_SPEC };
    p.width = 256;
    p.height = 256;
  });
  await expect
    .element(page.getByRole("button", { name: "Confirm character reference", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: /^Generation tasks ·/ }).click();
  await page.getByRole("button", { name: "Adjust slicing and alignment", exact: true }).click();
  await expect
    .element(
      page.getByRole("button", { name: "Save corrections and return to review", exact: true }),
    )
    .toBeVisible();
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("15");
  await userEvent.keyboard("{Enter}");
  await page.screenshot({
    path: "../../../../../.tmp/validation/sprite-workbench/06-slicing-fixture.png",
    element: page.getByTestId("sprite-workbench"),
  });
  await page
    .getByRole("button", { name: "Save corrections and return to review", exact: true })
    .click();
  await expect
    .element(page.getByRole("button", { name: "Confirm review and adopt", exact: true }))
    .toBeVisible();
  expect(mocks.sync.mock.calls.some(([i]) => i?.operation === "save-slicing")).toBe(true);
  expect(
    mocks.sync.mock.calls.some(([i]) =>
      ["propose", "review-candidate"].includes(i?.operation ?? ""),
    ),
  ).toBe(false);
  expect(mocks.save.mock.calls.some(([p]) => p.provenance.length)).toBe(false);
  await page.screenshot({
    path: "../../../../../.tmp/validation/sprite-workbench/05-candidate-fixture.png",
    element: page.getByTestId("sprite-workbench"),
  });
});

it.each([8, 7])(
  "updates %i existing actions and adds missing ones atomically, preserving cancellation and undo",
  async (priorCount) => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    canvas.getContext("2d")!.fillRect(3, 3, 9, 9);
    const image = canvas.toDataURL("image/png");
    mocks.imageUrl.mockReturnValue(image);
    const asset = {
      id: "new-frame",
      name: "frame.png",
      mimeType: "image/png" as const,
      url: image,
      thumbnailUrl: image,
      width: 16,
      height: 16,
      bytes: 100,
      createdAt: "2026-10-16T00:00:00Z",
    };
    const outputs = Array.from({ length: 8 }, (_, i) => ({
      action: {
        id: `generated-${i}`,
        name: `action-${i}`,
        description: "",
        enabled: true,
        frameCount: 7,
        fps: 15,
        loop: false,
      },
      frames: Array.from({ length: 7 }, () => asset),
      warnings: [],
    }));
    const frames = outputs.flatMap((a) => a.frames);
    const run: import("@synara/contracts").SpriteRun = {
      id: "corrected",
      planId: "plan",
      input: { kind: "animation", prompt: "sprites", requestId: "original" },
      context: {
        projectId: "project",
        threadId: "thread-a",
        name: "Fox",
        providerId: "drawing",
        model: "image",
        referenceAssetId: null,
        action: "idle",
        frameCount: 8,
        fps: 12,
        width: 16,
        height: 16,
        background: "transparent",
        chromaKey: "#00ff00",
      },
      jobId: "job",
      source: asset,
      frames,
      actions: outputs,
      status: "ready",
      warnings: [],
      error: null,
      createdAt: asset.createdAt,
      selectedCandidateId: asset.id,
      candidates: [
        {
          id: asset.id,
          source: asset,
          frames,
          actions: outputs,
          status: "ready",
          warnings: [],
          error: null,
          processingVersionId: "v2",
        },
      ],
    };
    mocks.sync.mockResolvedValue({ context: null, runs: [run] });
    await mountSheet(false, (p) => {
      p.id = "project";
      const frame = p.actions[0]!.frames[0]!;
      p.actions = outputs.slice(0, priorCount).map((a, i) => ({
        id: `local-${i}`,
        name: a.action.name,
        fps: 12,
        loop: true,
        frames: Array.from({ length: 8 }, (_, j) => ({ ...frame, id: `old-${i}-${j}` })),
      }));
      p.selectedActionId = "local-0";
      p.adoptedCandidateIds = outputs
        .slice(0, priorCount)
        .map((a) => `${run.id}:${asset.id}:${a.action.id}`);
      p.provenance = outputs.slice(0, priorCount).map((a, i) => ({
        runId: run.id,
        candidateId: asset.id,
        actionId: a.action.id,
        localActionId: `local-${i}`,
        processingVersionId: "v1",
        prompt: "",
        action: a.action.name,
        providerId: "drawing",
        model: "image",
      }));
    });
    await page.getByRole("button", { name: /^Generation tasks ·/ }).click();
    await page.getByRole("button", { name: "Review candidate", exact: true }).click();
    await page.getByText("Select actions for adoption", { exact: true }).click();
    await expect.element(page.getByRole("checkbox", { name: /^action-0 ·/ })).toBeChecked();
    await page
      .getByRole("button", {
        name: "Confirm review and adopt selected (8)",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(page.getByRole("checkbox", { name: /^action-0 ·/ })).toBeChecked();
    expect(
      mocks.save.mock.calls.some(([p]) => p.provenance.some((o) => o.processingVersionId === "v2")),
    ).toBe(false);
    await page
      .getByRole("button", {
        name: "Confirm review and adopt selected (8)",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: `Confirm action updates (${priorCount})`, exact: true })
      .click();
    await expect
      .poll(() =>
        mocks.save.mock.calls.at(-1)?.[0].provenance.every((p) => p.processingVersionId === "v2"),
      )
      .toBe(true);
    const updated = mocks.save.mock.calls.at(-1)![0];
    expect(updated.actions).toHaveLength(8);
    expect(updated.actions.slice(0, priorCount).map((a) => a.id)).toEqual(
      outputs.slice(0, priorCount).map((_, i) => `local-${i}`),
    );
    expect(updated.actions.every((a) => a.frames.length === 7 && a.fps === 15 && !a.loop)).toBe(
      true,
    );
    expect(updated.sources.filter((s) => s.usage !== "generated-frame")).toHaveLength(1);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(() =>
        mocks.save.mock.calls
          .at(-1)?.[0]
          .actions.every((a) => a.frames.length === 8 && a.fps === 12 && a.loop),
      )
      .toBe(true);
  },
);

it("keeps high-resolution character references when regular edits collect unused generated sources", async () => {
  await mountSheet(false, (p) => {
    p.version = 2;
    p.renderSpec = {
      mode: "illustration",
      logicalWidth: 256,
      logicalHeight: 256,
      outputScale: 1,
    };
    p.width = p.height = 256;
    const asset = {
      id: "appearance-asset",
      name: "character.png",
      mimeType: "image/png" as const,
      width: 1024,
      height: 1024,
      bytes: p.sources[0]!.blob.size,
      url: "/appearance",
      thumbnailUrl: "/appearance",
      createdAt: p.updatedAt,
    };
    p.canonical = {
      revision: "reference-v1",
      source: { ...asset, id: "original-asset" },
      asset: { ...asset, id: "alignment-asset", width: 256, height: 256 },
      generationReference: asset,
      renderSpec: p.renderSpec!,
      registration: { scale: 1, offsetX: 0, offsetY: 0 },
      pivotX: 128,
      pivotY: 230,
      confirmedAt: p.updatedAt,
    };
    p.sources.push(
      {
        ...p.sources[0]!,
        id: "appearance",
        assetId: asset.id,
        name: "appearance.png",
        width: 1024,
        height: 1024,
        usage: "generated-master",
      },
      { ...p.sources[0]!, id: "unused-master", assetId: "unused", usage: "generated-master" },
    );
  });
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("10");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() =>
      mocks.save.mock.calls
        .at(-1)?.[0]
        .sources.some((s: SpriteProject["sources"][number]) => s.id === "unused-master"),
    )
    .toBe(false);
  expect(
    mocks.save.mock.calls
      .at(-1)?.[0]
      .sources.some((s: SpriteProject["sources"][number]) => s.assetId === "appearance-asset"),
  ).toBe(true);
});

it("keeps local formal actions when task reading fails, shows unknown results and can retry reading", async () => {
  mocks.sync.mockRejectedValue(new Error("Invalid archived task"));
  await mountSheet();
  await expect
    .element(
      page.getByText(
        "Task results could not be refreshed. Your last results and local actions are preserved.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "idle 1", exact: true })).toBeVisible();
  await expect
    .element(
      page.getByRole("button", {
        name: "Generation tasks · Task results unavailable",
        exact: true,
      }),
    )
    .toBeVisible();
  expect(document.body.textContent).not.toContain("No generation tasks yet.");
  mocks.sync.mockResolvedValue({ context: null, runs: [] });
  await page.getByRole("button", { name: "Retry reading", exact: true }).click();
  await expect
    .element(
      page.getByRole("button", {
        name: "Generation tasks · 0 running · 0 candidates",
        exact: true,
      }),
    )
    .toBeVisible();
});

it("shows canvas-change impact, preserves action history and allows cancelling before changing output", async () => {
  await mountSheet(false, (p) => {
    p.version = 2;
    p.renderSpec = { mode: "illustration", logicalWidth: 256, logicalHeight: 256, outputScale: 1 };
    p.width = 256;
    p.height = 256;
  });
  await page
    .getByRole("navigation", { name: "Sprite workflow" })
    .getByRole("button", { name: "Actions", exact: true })
    .click();
  await page.getByText("Canvas settings", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Action frame width", exact: true }).fill("128");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("dialog"))
    .toHaveTextContent("Current action edits are saved as recoverable versions");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .element(page.getByRole("spinbutton", { name: "Action frame width", exact: true }))
    .toHaveValue("256");
  await page.getByRole("spinbutton", { name: "Action frame width", exact: true }).fill("128");
  await userEvent.keyboard("{Enter}");
  await page
    .getByRole("button", { name: "Save versions and change specification", exact: true })
    .click();
  await expect.poll(() => mocks.save.mock.calls.at(-1)?.[0].width).toBe(128);
  expect(mocks.save.mock.calls.at(-1)![0].actionVersions?.some((v) => v.width === 256)).toBe(true);
});
