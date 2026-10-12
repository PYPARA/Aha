import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopBridge } from "@synara/contracts";
import type {
  ResourceCommand,
  ResourceEntry,
  ResourceSnapshot,
} from "@synara/contracts/resourceLibrary";
import ResourceCenter from "./ResourceCenter";
import { ResourceCapture, ResourceCollectionDialog } from "./ResourceCollectionDialog";
import {
  ResourceChatContext,
  collectResources,
  useResourceCollection,
  useResourceTransfer,
} from "./resourceLibrary";
vi.mock("~/aha/AppearanceProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (s: string) => s,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: async () => ({ ok: true, threadId: "new-chat" }) }),
}));
vi.mock("~/store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({ sidebarThreadSummaryById: {} }),
}));
let entries: ResourceEntry[];
let changed: (() => void) | undefined;
let commands: ResourceCommand[];
let snapshot: ResourceSnapshot;
const original = window.desktopBridge;
const make = (id: string, name: string, directory = false): ResourceEntry => ({
  id,
  name,
  path: directory ? name : `Pixel Quest/${name}`,
  kind: directory ? "directory" : "file",
  bytes: 1024,
  modifiedAt: 1_700_000_000_000,
  tags: [],
  notes: "",
  fileKey: id,
  hash: id,
});
beforeEach(() => {
  entries = [
    make("project", "Pixel Quest", true),
    make("hero", "hero.png"),
    make("json", "animation.json"),
  ];
  snapshot = {
    root: "/tmp/resources",
    libraryId: "test",
    directories: [entries[0]!],
    count: 2,
    error: null,
  };
  commands = [];
  changed = undefined;
  window.desktopBridge = {
    showContextMenu: vi.fn().mockResolvedValue("collect-resource"),
    resourceLibrary: {
      request: async (command: ResourceCommand) => {
        commands.push(command);
        if (command.op === "snapshot" || command.op === "refresh") return snapshot;
        if (command.op === "list") {
          const matching = entries.filter(
            (e) =>
              e.path.split("/").slice(0, -1).join("/") === command.query.path &&
              (!command.query.query || e.name.includes(command.query.query)),
          );
          return {
            entries: matching.slice(command.query.offset ?? 0, (command.query.offset ?? 0) + 100),
            total: matching.length,
          };
        }
        if (command.op === "createDirectory") {
          const entry = make("new-project", command.name, true);
          entries.push(entry);
          snapshot.directories.push(entry);
          changed?.();
          return entry;
        }
        if (command.op === "read")
          return {
            name: "hero.png",
            mimeType: "image/png",
            bytes: Uint8Array.from(
              atob(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
              ),
              (c) => c.charCodeAt(0),
            ),
          };
        if (command.op === "importPaths")
          return { added: 1, skipped: 0, failed: [], cancelled: false };
        return undefined;
      },
      onChanged: (listener: () => void) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
      onProgress: () => () => {},
    },
  } as unknown as DesktopBridge;
});
afterEach(async () => {
  await cleanup();
  if (original) window.desktopBridge = original;
  else delete window.desktopBridge;
  useResourceCollection.setState({ sources: null });
  useResourceTransfer.setState({ pending: null });
  localStorage.removeItem("aha:resource-destination");
});
function mount(child = <ResourceCenter />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: 800 }}>{child}</div>
    </QueryClientProvider>,
  );
}
describe("resource center interactions", () => {
  it("browses projects, searches, edits metadata and opens the export flow", async () => {
    await page.viewport(1440, 900);
    await mount();
    await page.getByRole("button", { name: "Pixel Quest", exact: true }).first().click();
    await expect.element(page.getByRole("checkbox", { name: "Select hero.png" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select hero.png" }).click();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    expect(commands.some((c) => c.op === "export" && c.ids[0] === "hero")).toBe(true);
    await page.getByRole("button", { name: /hero.png/ }).click();
    await page.getByRole("textbox", { name: "Tags", exact: true }).fill("pixel, hero");
    await page.getByRole("textbox", { name: "Notes" }).fill("Idle pose");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "metadata" && c.notes === "Idle pose")).toBe(true),
    );
    await page.screenshot({ path: "../../../../../output/playwright/resource-center.png" });
    await page.getByRole("textbox", { name: "Search resources" }).fill("animation");
    await expect
      .element(page.getByRole("checkbox", { name: "Select animation.json" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Select hero.png" }))
      .not.toBeInTheDocument();
  });
  it("creates a project and passes the chosen destination to imports", async () => {
    await mount();
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("New Game");
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByRole("button", { name: "Import folder" }).click();
    await vi.waitFor(() =>
      expect(
        commands.some((c) => c.op === "importPaths" && c.target === "New Game" && c.directories),
      ).toBe(true),
    );
  });
  it("requires an explicit destination before collecting a file", async () => {
    collectResources([{ name: "sprite.png", path: "/tmp/sprite.png" }]);
    await mount(<ResourceCollectionDialog />);
    await expect
      .element(page.getByRole("button", { name: "Add to resource center", exact: true }))
      .toBeDisabled();
    await page.getByRole("combobox", { name: "Destination" }).selectOptions("Pixel Quest");
    await page.getByRole("button", { name: "Add to resource center", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "importPaths" && c.target === "Pixel Quest")).toBe(true),
    );
  });
  it("transfers selected image files to drawing without creating a generation job", async () => {
    await mount();
    await page.getByRole("button", { name: "Pixel Quest", exact: true }).first().click();
    await page.getByRole("checkbox", { name: "Select hero.png" }).click();
    await page.getByRole("button", { name: "Use in drawing" }).click();
    await vi.waitFor(() => expect(useResourceTransfer.getState().pending?.target).toBe("drawing"));
    expect(useResourceTransfer.getState().pending?.files[0]?.name).toBe("hero.png");
  });
  it("paginates beyond the first hundred files without resetting the page", async () => {
    entries = [
      entries[0]!,
      ...Array.from({ length: 110 }, (_, i) =>
        make(`file-${i}`, `file-${String(i).padStart(3, "0")}.txt`),
      ),
    ];
    await mount();
    await page.getByRole("button", { name: "Pixel Quest", exact: true }).first().click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect.element(page.getByRole("checkbox", { name: "Select file-100.txt" })).toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Select file-000.txt" }))
      .not.toBeInTheDocument();
  });
  it("opens the right-click collection action with the actual sidechat and message origin", async () => {
    await mount(
      <ResourceChatContext.Provider value="sidechat-42">
        <div data-chat-find-document-id="message-7">
          <ResourceCapture source={{ name: "hero.png", path: "/tmp/hero.png" }}>
            <span>Chat image</span>
          </ResourceCapture>
        </div>
      </ResourceChatContext.Provider>,
    );
    await page.getByText("Chat image", { exact: true }).click({ button: "right" });
    await vi.waitFor(() =>
      expect(useResourceCollection.getState().sources?.[0]?.origin).toMatchObject({
        kind: "chat",
        threadId: "sidechat-42",
        messageId: "message-7",
      }),
    );
    expect(window.desktopBridge!.showContextMenu).toHaveBeenCalled();
  });
});
