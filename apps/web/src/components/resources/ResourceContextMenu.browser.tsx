import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImageJob } from "@synara/contracts";
import { DrawingGallery } from "../drawing/DrawingGallery";
import { DrawingJobDialog } from "../drawing/DrawingJobDialog";
import { ExpandedImageOverlay } from "../chat/ExpandedImageOverlay";
import { GeneratedMarkdownImage } from "../chat/GeneratedMarkdownImage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import type { DesktopBridge, NativeApi } from "@synara/contracts";
import {
  ResourceCapture,
  resourceContextMenu,
  drawingResourceSource,
} from "./ResourceCollectionDialog";
import { useResourceCollection, ResourceChatContext } from "./resourceLibrary";
import { installResourceContextMenuExtension } from "~/lib/resourceContextMenuExtension";
import { showLinkContextMenu } from "~/lib/linkContextMenu";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
vi.mock("~/aha/AppearanceProvider", async (original) => ({
  ...(await original<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (s: string) => s,
}));
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const job = {
  id: "job-test",
  clientRequestId: "request-test",
  providerId: "provider-test",
  providerName: "Test provider",
  providerVersion: 1,
  model: "test-model",
  prompt: "A test drawing",
  parameters: { n: 1 },
  inputReferences: [],
  status: "succeeded",
  error: null,
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  sourceJobId: null,
  isTest: false,
  inputs: [],
  mask: null,
  outputs: [
    {
      id: "asset-test",
      name: "drawing.png",
      mimeType: "image/png",
      url: pixel,
      thumbnailUrl: pixel,
      width: 1,
      height: 1,
      bytes: 70,
      createdAt: "2026-10-12T00:00:00Z",
    },
  ],
  actualParameters: {},
  usage: null,
  upstreamRequestId: null,
} as unknown as ImageJob;
vi.mock("../drawing/useDrawing", () => ({
  imageUrl: () => pixel,
  drawingJobsKey: ["drawing-test"],
  drawingApi: () => ({ getJob: async () => job }),
  useImageJobs: () => ({
    data: { pages: [{ jobs: [job] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: vi.fn(),
  }),
}));
const noop = () => {};
async function renderWithQuery(content: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {content}
    </QueryClientProvider>,
  );
}
const originalBridge = window.desktopBridge,
  originalApi = window.nativeApi;
let query: Parameters<NonNullable<DesktopBridge["contextMenuExtension"]>["onQuery"]>[0];
let result: Parameters<NonNullable<DesktopBridge["contextMenuExtension"]>["onResult"]>[0];
let dispose: (() => void) | undefined;
const respond = vi.fn(),
  show = vi.fn();
beforeEach(() => {
  respond.mockReset();
  show.mockReset().mockResolvedValue(null);
  window.desktopBridge = {
    resourceLibrary: {},
    showContextMenu: show,
    contextMenuExtension: {
      onQuery: (listener: typeof query) => {
        query = listener;
        return vi.fn();
      },
      respond,
      onResult: (listener: typeof result) => {
        result = listener;
        return vi.fn();
      },
    },
  } as unknown as DesktopBridge;
  window.nativeApi = { contextMenu: { show } } as unknown as NativeApi;
  dispose = installResourceContextMenuExtension(window.desktopBridge);
  useResourceCollection.setState({ sources: null });
});
afterEach(() => {
  cleanup();
  dispose?.();
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  if (originalApi) window.nativeApi = originalApi;
  else delete window.nativeApi;
});
function rightClick(element: Element) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 23,
    clientY: 45,
  });
  element.dispatchEvent(event);
  return event;
}
function request(id = "menu") {
  query({ requestId: id, x: 23, y: 45 });
}
describe("resource collection extends existing menus", () => {
  it("leaves image native menu enabled, preserves chat origin, and collects only after selection", async () => {
    await render(
      <ResourceChatContext.Provider value="thread-1">
        <div data-chat-find-document-id="message-1">
          <ResourceCapture source={{ name: "hero.png", url: "https://example.com/hero.png" }}>
            <img alt="hero" />
          </ResourceCapture>
        </div>
      </ResourceChatContext.Provider>,
    );
    expect(rightClick(document.querySelector('img[alt="hero"]')!).defaultPrevented).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(useResourceCollection.getState().sources).toBeNull();
    request();
    expect(respond).toHaveBeenCalledWith("menu", "Add to resource center");
    result({ requestId: "menu", selected: true });
    expect(useResourceCollection.getState().sources?.[0]?.origin).toEqual({
      kind: "chat",
      threadId: "thread-1",
      messageId: "message-1",
    });
  });
  it.each(["drawing thumbnail", "drawing detail", "expanded image", "generated image"])(
    "keeps native behavior and lazy resolution for %s",
    async (surface) => {
      const resolveUrl = vi.fn().mockResolvedValue("file-url");
      const source = surface.startsWith("drawing")
        ? drawingResourceSource({ name: "hero.png", url: "/image" }, "http://localhost/image", {
            id: "job-1",
            prompt: "hero",
            model: "test",
            parameters: {},
          })
        : { name: "hero.png", url: "/image", resolveUrl };
      await render(
        <img
          alt={surface}
          onContextMenuCapture={(event) => resourceContextMenu(event, [source], (s) => s)}
        />,
      );
      expect(rightClick(document.querySelector(`img[alt="${surface}"]`)!).defaultPrevented).toBe(
        false,
      );
      request();
      expect(resolveUrl).not.toHaveBeenCalled();
      result({ requestId: "menu", selected: true });
      expect(useResourceCollection.getState().sources?.[0]?.name).toBe("hero.png");
      if (surface.startsWith("drawing"))
        expect(useResourceCollection.getState().sources?.[0]?.origin?.jobId).toBe("job-1");
    },
  );
  it("appends to an enclosing link menu without suppressing its original actions or duplicating menus", async () => {
    show.mockResolvedValue("collect-resource");
    await render(
      <a
        href="https://example.com"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void showLinkContextMenu({
            url: "https://example.com",
            position: { x: event.clientX, y: event.clientY },
            actions: null,
          });
        }}
      >
        <ResourceCapture source={{ name: "hero", url: "/hero" }}>
          <img alt="linked" />
        </ResourceCapture>
      </a>,
    );
    expect(rightClick(document.querySelector('img[alt="linked"]')!).defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(useResourceCollection.getState().sources?.[0]?.name).toBe("hero"),
    );
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]![0].map((item: { id: string }) => item.id)).toEqual([
      "open-external",
      "copy-link",
      "collect-resource",
    ]);
    expect(show.mock.calls[0]![0].at(-1).separatorBefore).toBe(true);
    request();
    expect(respond).toHaveBeenLastCalledWith("menu", null);
  });
  it.each(["gallery", "detail", "expanded", "generated", "linked-generated"])(
    "uses the actual %s component without replacing its menu",
    async (surface) => {
      const content =
        surface === "gallery" ? (
          <DrawingGallery
            filters={{ statusGroup: "all" }}
            hasProvider
            onOpen={noop}
            onOpenSource={noop}
            onReuse={noop}
            onRegenerate={noop}
            onCancel={noop}
            onDelete={noop}
            onSettings={noop}
          />
        ) : surface === "detail" ? (
          <DrawingJobDialog
            initialJob={job}
            onClose={noop}
            onDownload={noop}
            onReference={noop}
            onAnnotate={noop}
            onMask={noop}
            onReuse={noop}
            onRegenerate={noop}
            onCancel={noop}
            onDelete={noop}
            onPreview={noop}
            onOpenSource={noop}
          />
        ) : surface === "expanded" ? (
          <ExpandedImageOverlay
            expandedImage={{
              images: [
                {
                  src: pixel,
                  name: "expanded.png",
                  resourceOrigin: { kind: "drawing", jobId: job.id },
                },
              ],
              index: 0,
            }}
            onClose={noop}
            onNavigate={noop}
          />
        ) : (
          <GeneratedMarkdownImage
            src={pixel}
            alt="generated.png"
            cwd={undefined}
            isLinked={surface === "linked-generated"}
          />
        );
      await renderWithQuery(content);
      const img = document.querySelector("img")!;
      expect(img).not.toBeNull();
      expect(rightClick(img).defaultPrevented).toBe(false);
      request();
      expect(respond).toHaveBeenLastCalledWith("menu", "Add to resource center");
      expect(show).not.toHaveBeenCalled();
      result({ requestId: "menu", selected: true });
      const source = useResourceCollection.getState().sources?.[0];
      expect(source).toBeDefined();
      if (["gallery", "detail", "expanded"].includes(surface))
        expect(source?.origin?.jobId).toBe(job.id);
      if (["gallery", "detail"].includes(surface)) expect(source?.name).toBe("drawing.png");
    },
  );
  it("retains the file menu's original order and appends collection exactly once", async () => {
    await showFileReferenceContextMenu({
      path: "hero.png",
      revealPath: "/tmp/hero.png",
      position: { x: 23, y: 45 },
      onReferenceInChat: vi.fn(),
      onAskWhyInChat: vi.fn(),
    });
    expect(show.mock.calls[0]![0].map((item: { id: string }) => item.id)).toEqual([
      "reference-in-chat",
      "ask-why-in-chat",
      "reveal-in-folder",
      "copy-path",
      "collect-resource",
    ]);
  });
  it("discards canceled, superseded and detached targets and never reuses an image on a plain click", async () => {
    await render(
      <div>
        <ResourceCapture source={{ name: "hero", url: "/hero" }}>
          <img alt="cancel" />
        </ResourceCapture>
        <p>plain</p>
      </div>,
    );
    const img = document.querySelector('img[alt="cancel"]')!;
    rightClick(img);
    request("old");
    result({ requestId: "old", selected: false });
    expect(useResourceCollection.getState().sources).toBeNull();
    rightClick(img);
    request("old");
    rightClick(document.querySelector("p")!);
    request("new");
    result({ requestId: "old", selected: true });
    expect(respond).toHaveBeenLastCalledWith("new", null);
    expect(useResourceCollection.getState().sources).toBeNull();
    rightClick(img);
    request("detached");
    cleanup();
    result({ requestId: "detached", selected: true });
    expect(useResourceCollection.getState().sources).toBeNull();
  });
  it("rejects queries at a different point without consuming the latest target", async () => {
    await render(
      <ResourceCapture source={{ name: "hero", url: "/hero" }}>
        <img alt="position" />
      </ResourceCapture>,
    );
    rightClick(document.querySelector('img[alt="position"]')!);
    query({ requestId: "stale-point", x: 200, y: 400 });
    expect(respond).toHaveBeenLastCalledWith("stale-point", null);
    request("current-point");
    expect(respond).toHaveBeenLastCalledWith("current-point", "Add to resource center");
    result({ requestId: "stale-point", selected: true });
    expect(useResourceCollection.getState().sources).toBeNull();
    result({ requestId: "current-point", selected: true });
    expect(useResourceCollection.getState().sources?.[0]?.name).toBe("hero");
  });
  it("leaves browser context menus untouched when desktop resources are unavailable", async () => {
    delete window.desktopBridge;
    await render(
      <ResourceCapture source={{ name: "hero", url: "/hero" }}>
        <img alt="web" />
      </ResourceCapture>,
    );
    expect(rightClick(document.querySelector('img[alt="web"]')!).defaultPrevented).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });
});
