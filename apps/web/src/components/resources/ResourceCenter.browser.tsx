import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopBridge } from "@synara/contracts";
import {
  resourceType,
  type ResourceCommand,
  type ResourceEntry,
  type ResourceSnapshot,
} from "@synara/contracts/resourceLibrary";
import ResourceCenter from "./ResourceCenter";
import { ResourceCapture, ResourceCollectionDialog } from "./ResourceCollectionDialog";
import {
  ResourceChatContext,
  collectResources,
  useResourceCollection,
  useResourceTransfer,
} from "./resourceLibrary";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn().mockResolvedValue(undefined) }));
vi.mock("~/aha/AppearanceProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (s: string) => s,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: async () => ({ ok: true, threadId: "new-chat" }) }),
}));
vi.mock("~/store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ sidebarThreadSummaryById: threadSummaries }),
}));
let entries: ResourceEntry[];
let changed: (() => void) | undefined;
let commands: ResourceCommand[];
let snapshot: ResourceSnapshot;
let metadataError: string | null;
let metadataPending: Promise<void> | null;
let imageBytes: Uint8Array;
let nextLibrary: ResourceSnapshot | null;
let treeListError: string | null;
let threadSummaries: Record<string, { id: string; title: string; archivedAt: string | null }>;
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
beforeEach(async () => {
  await page.viewport(1440, 900);
  localStorage.removeItem("aha:resource-tree-width");
  navigate.mockClear();
  metadataError = null;
  metadataPending = null;
  nextLibrary = null;
  treeListError = null;
  threadSummaries = {};
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#deeafb";
  context.fillRect(0, 0, 320, 400);
  context.fillStyle = "#4269a1";
  context.fillRect(98, 160, 124, 160);
  context.fillStyle = "#efc58f";
  context.fillRect(116, 70, 88, 88);
  context.fillStyle = "#202e46";
  context.fillRect(108, 48, 104, 32);
  context.fillRect(114, 320, 36, 40);
  context.fillRect(170, 320, 36, 40);
  imageBytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (c) =>
    c.charCodeAt(0),
  );
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
        if (command.op === "chooseRoot" && nextLibrary) {
          snapshot = nextLibrary;
          return snapshot;
        }
        if (command.op === "list") {
          if (command.query.sort === "name" && treeListError) throw new Error(treeListError);
          const matching = entries.filter(
            (e) =>
              (command.query.recursive
                ? !command.query.path || e.path.startsWith(`${command.query.path}/`)
                : e.path.split("/").slice(0, -1).join("/") === command.query.path) &&
              (!command.query.query || e.name.includes(command.query.query)) &&
              (!command.query.tag || e.tags.includes(command.query.tag)) &&
              (!command.query.type ||
                command.query.type === "all" ||
                resourceType(e.name) === command.query.type),
          );
          return {
            entries: matching.slice(command.query.offset ?? 0, (command.query.offset ?? 0) + 100),
            total: matching.length,
          };
        }
        if (command.op === "createDirectory") {
          const entry = {
            ...make(`new-${command.name}`, command.name, true),
            path: command.parent ? `${command.parent}/${command.name}` : command.name,
          };
          entries.push(entry);
          snapshot = { ...snapshot, directories: [...snapshot.directories, entry] };
          changed?.();
          return entry;
        }
        if (command.op === "metadata") {
          if (metadataPending) await metadataPending;
          if (metadataError) throw new Error(metadataError);
          entries = entries.map((entry) =>
            command.ids.includes(entry.id)
              ? {
                  ...entry,
                  tags: command.tags ?? entry.tags,
                  notes: command.notes ?? entry.notes,
                }
              : entry,
          );
          return;
        }
        if (command.op === "read")
          return {
            name: entries.find((entry) => entry.id === command.id)?.name ?? "hero.png",
            mimeType: "image/png",
            bytes: imageBytes,
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
  localStorage.removeItem("aha:resource-tree-width");
  vi.restoreAllMocks();
});
function mount(child = <ResourceCenter />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: Math.min(800, window.innerHeight), display: "flex" }}>{child}</div>
    </QueryClientProvider>,
  );
}
const element = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const card = (name: string) =>
  page.getByTestId("resource-entries").getByRole("button", { name: new RegExp(name) });
const checkbox = (name: string) => page.getByRole("checkbox", { name: `Select ${name}` });
const selectedIds = () =>
  [
    ...document.querySelectorAll<HTMLInputElement>(
      '[data-testid="resource-entries"] input:checked',
    ),
  ].map((input) => input.getAttribute("aria-label"));
const enterProject = () =>
  page
    .getByRole("navigation", { name: "Resource folders" })
    .getByRole("button", { name: "Pixel Quest", exact: true })
    .click();
const closeDetails = async () => {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
};
function addDirectories(paths: string[]) {
  const directories = paths.map((path, index) => ({
    ...make(`directory-${index}`, path.split("/").at(-1)!, true),
    path,
  }));
  entries = [...entries, ...directories];
  snapshot = { ...snapshot, directories: [...snapshot.directories, ...directories] };
}
function pointer(target: EventTarget, type: string, clientX: number, buttons = 1) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons,
      clientX,
    }),
  );
}
function layout() {
  const grid = element("resource-entries");
  const rect = grid.firstElementChild!.getBoundingClientRect();
  return {
    width: rect.width,
    left: rect.left,
    top: rect.top,
    columns: getComputedStyle(grid).gridTemplateColumns,
    scroll: element("resource-scroll").scrollTop,
  };
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
    await card("hero.png").dblClick();
    await page.getByRole("textbox", { name: "Tags", exact: true }).fill("pixel, hero");
    await page.getByRole("textbox", { name: "Notes" }).fill("Idle pose");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "metadata" && c.notes === "Idle pose")).toBe(true),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
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
  it("starts with projects expanded, toggles arrows independently and expands navigation ancestors", async () => {
    addDirectories([
      "Pixel Quest/assets",
      "Pixel Quest/assets/portraits",
      "Pixel Quest/assets/portraits/core",
    ]);
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await expect
      .element(folders.getByRole("button", { name: "assets", exact: true }))
      .toBeVisible();
    await expect
      .element(folders.getByRole("button", { name: "portraits", exact: true }))
      .not.toBeInTheDocument();
    await folders.getByRole("button", { name: "Expand folder assets" }).click();
    await expect
      .element(folders.getByRole("button", { name: "portraits", exact: true }))
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Resource path" })
          .getByRole("button", { name: "All projects", exact: true }),
      )
      .toHaveAttribute("aria-current", "page");
    await folders.getByRole("button", { name: "Collapse folder assets" }).click();
    await folders.getByRole("button", { name: "assets", exact: true }).click();
    await card("portraits").click();
    await card("core").click();
    await expect
      .element(folders.getByRole("button", { name: "core", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await folders.getByRole("button", { name: "Collapse folder Pixel Quest" }).click();
    await expect
      .element(folders.getByRole("button", { name: "core", exact: true }))
      .not.toBeInTheDocument();
    expect(
      page
        .getByRole("navigation", { name: "Resource path" })
        .getByRole("button", { name: "core", exact: true })
        .element()
        .getAttribute("aria-current"),
    ).toBe("page");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect
      .element(folders.getByRole("button", { name: "Expand folder Pixel Quest" }))
      .toBeVisible();
    await page
      .getByRole("navigation", { name: "Resource path" })
      .getByRole("button", { name: "portraits", exact: true })
      .click();
    await expect.element(folders.getByRole("button", { name: "core", exact: true })).toBeVisible();
  });
  it("shows files under expanded folders, including file-only folders, and loads them lazily", async () => {
    addDirectories(["Pixel Quest/assets", "Pixel Quest/assets/portraits"]);
    entries.push({
      ...make("portrait", "portrait.webp"),
      path: "Pixel Quest/assets/portraits/portrait.webp",
    });
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await expect
      .element(folders.getByRole("button", { name: "hero.png", exact: true }))
      .toBeVisible();
    await expect
      .element(folders.getByRole("button", { name: "animation.json", exact: true }))
      .toBeVisible();
    expect(
      commands.some(
        (command) => command.op === "list" && command.query.path === "Pixel Quest/assets",
      ),
    ).toBe(false);
    await folders.getByRole("button", { name: "Expand folder assets" }).click();
    await expect
      .element(folders.getByRole("button", { name: "Expand folder portraits" }))
      .toBeVisible();
    expect(
      commands.some(
        (command) => command.op === "list" && command.query.path === "Pixel Quest/assets/portraits",
      ),
    ).toBe(false);
    await folders.getByRole("button", { name: "Expand folder portraits" }).click();
    await expect
      .element(folders.getByRole("button", { name: "portrait.webp", exact: true }))
      .toBeVisible();
    await folders.getByRole("button", { name: "Collapse folder portraits" }).click();
    await expect
      .element(folders.getByRole("button", { name: "portrait.webp", exact: true }))
      .not.toBeInTheDocument();
    await folders.getByRole("button", { name: "Collapse folder Pixel Quest" }).click();
    await expect
      .element(folders.getByRole("button", { name: "hero.png", exact: true }))
      .not.toBeInTheDocument();
    expect(commands.some((command) => command.op === "read")).toBe(false);
  });
  it("locates a tree file in its directory, syncs selection with the grid and opens details on double-click", async () => {
    addDirectories(["Pixel Quest/assets"]);
    entries.push({ ...make("asset", "asset.webp"), path: "Pixel Quest/assets/asset.webp" });
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    const hero = folders.getByRole("button", { name: "hero.png", exact: true });
    await hero.click();
    await expect.element(checkbox("hero.png")).toBeChecked();
    await expect.element(hero).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await hero.click();
    await expect.element(checkbox("hero.png")).not.toBeChecked();
    await checkbox("hero.png").click();
    await expect.element(hero).toHaveAttribute("aria-pressed", "true");
    await hero.dblClick();
    await expect.element(page.getByRole("dialog", { name: "hero.png" })).toBeVisible();
    expect(selectedIds()).toEqual(["Select hero.png"]);
    await closeDetails();
    await folders.getByRole("button", { name: "Expand folder assets" }).click();
    await page.getByRole("textbox", { name: "Search resources" }).fill("hero");
    await folders.getByRole("button", { name: "asset.webp", exact: true }).click();
    await expect.element(checkbox("asset.webp")).toBeChecked();
    await expect.element(checkbox("hero.png")).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Search resources" })).toHaveValue("");
    await expect
      .element(folders.getByRole("button", { name: "assets", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await hero.dblClick();
    await expect.element(page.getByRole("dialog", { name: "hero.png" })).toBeVisible();
    await closeDetails();
    await vi.waitFor(() => expect(document.activeElement).toBe(hero.element()));
    await expect.element(checkbox("hero.png")).toBeChecked();
  });
  it("keeps tree keyboard selection when Enter opens details", async () => {
    await mount();
    const hero = page
      .getByRole("navigation", { name: "Resource folders" })
      .getByRole("button", { name: "hero.png", exact: true });
    await hero.click();
    await expect.element(checkbox("hero.png")).toBeChecked();
    await hero.click();
    await expect.element(checkbox("hero.png")).not.toBeChecked();
    hero.element().focus();
    await userEvent.keyboard(" ");
    await expect.element(checkbox("hero.png")).toBeChecked();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "hero.png" })).toBeVisible();
    expect(selectedIds()).toEqual(["Select hero.png"]);
    await closeDetails();
    await vi.waitFor(() => expect(document.activeElement).toBe(hero.element()));
  });
  it("keeps an empty expanded folder usable without a load-more loop", async () => {
    addDirectories(["Pixel Quest/empty"]);
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await folders.getByRole("button", { name: "Expand folder empty" }).click();
    await vi.waitFor(() =>
      expect(
        commands.some(
          (command) => command.op === "list" && command.query.path === "Pixel Quest/empty",
        ),
      ).toBe(true),
    );
    await expect.element(folders.getByRole("status")).not.toBeInTheDocument();
    await expect
      .element(folders.getByRole("button", { name: "Load more", exact: true }))
      .not.toBeInTheDocument();
    await folders.getByRole("button", { name: "empty", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Import files", exact: true }))
      .toBeEnabled();
  });
  it("loads tree files beyond the first hundred and locates the right grid page", async () => {
    entries = [
      entries[0]!,
      ...Array.from({ length: 110 }, (_, index) =>
        make(`file-${index}`, `file-${String(index).padStart(3, "0")}.txt`),
      ),
    ];
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await expect
      .element(folders.getByRole("button", { name: "file-099.txt", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(folders.getByRole("button", { name: "file-100.txt", exact: true }))
      .not.toBeInTheDocument();
    await folders.getByRole("button", { name: "Load more", exact: true }).click();
    await folders.getByRole("button", { name: "file-109.txt", exact: true }).click();
    await expect.element(checkbox("file-109.txt")).toBeChecked();
    await expect.element(checkbox("file-000.txt")).not.toBeInTheDocument();
    await folders.getByRole("button", { name: "file-000.txt", exact: true }).click();
    await expect.element(checkbox("file-000.txt")).toBeChecked();
    await expect.element(checkbox("file-109.txt")).not.toBeInTheDocument();
  });
  it("reports tree loading failures and retries without navigating", async () => {
    treeListError = "Could not load folder files";
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await expect.element(folders.getByRole("alert")).toHaveTextContent(treeListError);
    treeListError = null;
    await folders.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .element(folders.getByRole("button", { name: "hero.png", exact: true }))
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Resource path" })
          .getByRole("button", { name: "All projects", exact: true }),
      )
      .toHaveAttribute("aria-current", "page");
  });
  it("updates tree files after library changes without reopening a collapsed branch", async () => {
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await expect
      .element(folders.getByRole("button", { name: "hero.png", exact: true }))
      .toBeVisible();
    entries = entries.filter((entry) => entry.id !== "hero");
    entries.push(make("added", "added.webp"));
    changed?.();
    await expect
      .element(folders.getByRole("button", { name: "hero.png", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(folders.getByRole("button", { name: "added.webp", exact: true }))
      .toBeVisible();
    await folders.getByRole("button", { name: "Collapse folder Pixel Quest" }).click();
    changed?.();
    await expect
      .element(folders.getByRole("button", { name: "added.webp", exact: true }))
      .not.toBeInTheDocument();
  });
  it("resets directory expansion and open details when switching libraries", async () => {
    addDirectories(["Pixel Quest/assets", "Pixel Quest/assets/portraits"]);
    await mount();
    const folders = page.getByRole("navigation", { name: "Resource folders" });
    await folders.getByRole("button", { name: "Expand folder assets" }).click();
    await enterProject();
    await card("hero.png").dblClick();
    nextLibrary = { ...snapshot, libraryId: "another-library" };
    snapshot = nextLibrary;
    changed?.();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(folders.getByRole("button", { name: "assets", exact: true }))
      .toBeVisible();
    await expect
      .element(folders.getByRole("button", { name: "portraits", exact: true }))
      .not.toBeInTheDocument();
    await folders.getByRole("button", { name: "Collapse folder Pixel Quest" }).click();
    nextLibrary = { ...snapshot, libraryId: "third-library" };
    await page.getByRole("button", { name: "Switch library" }).click();
    await expect
      .element(folders.getByRole("button", { name: "assets", exact: true }))
      .toBeVisible();
  });
  it("resizes the tree, clamps its width and restores the preference after mounting", async () => {
    const mounted = await mount();
    const handle = page.getByRole("separator", { name: "Resize resource folders" });
    await expect.element(handle).toBeVisible();
    expect(element("resource-tree").getBoundingClientRect().width).toBe(208);
    const drag = async (from: number, to: number, expected: number) => {
      pointer(handle.element(), "pointerdown", from);
      const overlay = document.querySelector("[data-panel-resize-overlay]")!;
      pointer(overlay, "pointermove", to);
      await vi.waitFor(() =>
        expect(element("resource-tree").getBoundingClientRect().width).toBe(expected),
      );
      pointer(overlay, "pointerup", to, 0);
      expect(document.querySelector("[data-panel-resize-overlay]")).toBeNull();
      expect(localStorage.getItem("aha:resource-tree-width")).toBe(String(expected));
    };
    await drag(208, 320, 320);
    await drag(320, -500, 180);
    await drag(180, 1500, 480);
    await drag(480, 352, 352);
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(element("resource-tree").getBoundingClientRect().width).toBe(368);
    await userEvent.keyboard("{ArrowLeft}");
    expect(localStorage.getItem("aha:resource-tree-width")).toBe("352");
    await mounted.unmount();
    await mount();
    await expect
      .element(page.getByRole("separator", { name: "Resize resource folders" }))
      .toHaveAttribute("aria-valuenow", "352");
  });
  it("temporarily limits a saved width in a smaller container without losing the preference", async () => {
    localStorage.setItem("aha:resource-tree-width", "480");
    await mount();
    await expect.element(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "480");
    await page.viewport(720, 900);
    await vi.waitFor(() =>
      expect(element("resource-tree").getBoundingClientRect().width).toBeLessThan(480),
    );
    const frameWidth = element("resource-tree").parentElement!.clientWidth;
    expect(
      frameWidth - element("resource-tree").getBoundingClientRect().width,
    ).toBeGreaterThanOrEqual(360);
    expect(localStorage.getItem("aha:resource-tree-width")).toBe("480");
    // A click or vertical-only movement on the divider must not save the temporary clamp.
    const handle = page.getByRole("separator").element();
    const start = handle.getBoundingClientRect().left;
    pointer(handle, "pointerdown", start);
    const overlay = document.querySelector("[data-panel-resize-overlay]")!;
    pointer(overlay, "pointermove", start);
    pointer(overlay, "pointerup", start, 0);
    expect(localStorage.getItem("aha:resource-tree-width")).toBe("480");
    await page.viewport(1440, 900);
    await expect.element(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "480");
  });
  it("cleans up drag listeners and body styles on blur, cancellation and unmount", async () => {
    const mounted = await mount();
    const handle = page.getByRole("separator", { name: "Resize resource folders" });
    await expect.element(handle).toBeVisible();
    const originalCursor = document.body.style.cursor;
    const originalSelection = document.body.style.userSelect;
    for (const ending of ["blur", "pointercancel", "unmount"]) {
      pointer(handle.element(), "pointerdown", 208);
      const overlay = document.querySelector("[data-panel-resize-overlay]")!;
      expect(document.body.style.userSelect).toBe("none");
      if (ending === "blur") window.dispatchEvent(new Event("blur"));
      else if (ending === "pointercancel") pointer(overlay, ending, 208, 0);
      else await mounted.unmount();
      expect(document.querySelector("[data-panel-resize-overlay]")).toBeNull();
      expect(document.body.style.cursor).toBe(originalCursor);
      expect(document.body.style.userSelect).toBe(originalSelection);
    }
  });
  it.each(["not-a-number", "Infinity"])(
    "falls back to the default for an invalid saved width %s",
    async (value) => {
      localStorage.setItem("aha:resource-tree-width", value);
      await mount();
      await expect.element(page.getByRole("separator")).toHaveAttribute("aria-valuenow", "208");
    },
  );
  it("keeps browsing and resizing available when preference storage is blocked", async () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked storage");
    });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked storage");
    });
    await mount();
    const handle = page.getByRole("separator");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "208");
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "224");
    read.mockRestore();
    write.mockRestore();
  });
  it.each(["grid", "list"])(
    "toggles file selection independently of details in %s view",
    async (view) => {
      await mount();
      await enterProject();
      if (view === "list")
        await page.getByRole("button", { name: "List view", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Rename", exact: true }))
        .toBeDisabled();
      await card("hero.png").click();
      await expect.element(checkbox("hero.png")).toBeChecked();
      await card("animation.json").click();
      await expect.element(checkbox("animation.json")).toBeChecked();
      await card("hero.png").click();
      await expect.element(checkbox("hero.png")).not.toBeChecked();
      await checkbox("hero.png").click();
      expect(selectedIds()).toEqual(["Select hero.png", "Select animation.json"]);
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await card("hero.png").dblClick();
      await expect.element(page.getByRole("dialog", { name: "hero.png" })).toBeVisible();
      expect(selectedIds()).toEqual(["Select hero.png", "Select animation.json"]);
      await closeDetails();
      await page.getByRole("button", { name: "Clear selection" }).click();
      await card("hero.png").dblClick();
      await expect.element(page.getByRole("dialog")).toBeVisible();
      expect(selectedIds()).toEqual([]);
      await closeDetails();
      await card("animation.json").click({ button: "right" });
      await expect.element(checkbox("animation.json")).toBeChecked();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it("opens file details with Enter and toggles selection with Space", async () => {
    await mount();
    await enterProject();
    await expect.element(card("animation.json")).toBeVisible();
    card("animation.json").element().focus();
    await userEvent.keyboard(" ");
    await expect.element(checkbox("animation.json")).toBeChecked();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "animation.json" })).toBeVisible();
    expect(selectedIds()).toEqual(["Select animation.json"]);
    expect(page.getByTestId("resource-detail-preview").element().textContent).toBe("document");
    expect(commands.some((command) => command.op === "read" && command.id === "json")).toBe(false);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(card("animation.json").element()));
  });
  it("retains drafts after a save error and reopens saved metadata after a successful retry", async () => {
    await mount();
    await enterProject();
    await card("hero.png").dblClick();
    await page.getByRole("textbox", { name: "Tags", exact: true }).fill("pixel, hero");
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Idle pose");
    metadataError = "Could not save metadata";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("dialog").getByRole("alert"))
      .toHaveTextContent(metadataError);
    expect(document.querySelector('[data-testid="resource-center"] [role="alert"]')).toBeNull();
    await expect
      .element(page.getByRole("textbox", { name: "Notes", exact: true }))
      .toHaveValue("Idle pose");
    metadataError = null;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await closeDetails();
    await card("hero.png").dblClick();
    await expect
      .element(page.getByRole("textbox", { name: "Tags", exact: true }))
      .toHaveValue("pixel, hero");
    await expect
      .element(page.getByRole("textbox", { name: "Notes", exact: true }))
      .toHaveValue("Idle pose");
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Unsaved edit");
    await closeDetails();
    await card("hero.png").dblClick();
    await expect
      .element(page.getByRole("textbox", { name: "Notes", exact: true }))
      .toHaveValue("Idle pose");
  });
  it("keeps source navigation, export and folder reveal in the detail dialog", async () => {
    threadSummaries = {
      "source-chat": { id: "source-chat", title: "Art source", archivedAt: null },
    };
    entries[1] = {
      ...entries[1]!,
      origin: {
        kind: "drawing",
        threadId: "source-chat",
        prompt: "A pixel hero",
        model: "sample-model",
        parameters: { seed: 42 },
      },
    };
    await mount();
    await enterProject();
    await card("hero.png").dblClick();
    await expect
      .element(page.getByRole("dialog").getByText("A pixel hero", { exact: true }))
      .toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Show in folder" }).click();
    await vi.waitFor(() =>
      expect(commands.some((command) => command.op === "reveal" && command.id === "hero")).toBe(
        true,
      ),
    );
    await page.getByRole("dialog").getByRole("button", { name: "Export", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((command) => command.op === "export" && command.ids[0] === "hero")).toBe(
        true,
      ),
    );
    await page.getByRole("dialog").getByRole("button", { name: "Open source chat" }).click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: "source-chat" },
    });
  });
  it("keeps a closed dialog closed when an in-flight metadata save finishes", async () => {
    await mount();
    await enterProject();
    await card("hero.png").dblClick();
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Saved after closing");
    let finishSave: (() => void) | undefined;
    metadataPending = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Working..." }))
      .toBeDisabled();
    await closeDetails();
    finishSave?.();
    await vi.waitFor(() =>
      expect(entries.find((entry) => entry.id === "hero")?.notes).toBe("Saved after closing"),
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await card("hero.png").dblClick();
    await expect
      .element(page.getByRole("textbox", { name: "Notes", exact: true }))
      .toHaveValue("Saved after closing");
  });
  it("closes details when the displayed resource disappears", async () => {
    await mount();
    await enterProject();
    await card("hero.png").dblClick();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    entries = entries.filter((entry) => entry.id !== "hero");
    changed?.();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(checkbox("hero.png")).not.toBeInTheDocument();
  });
  it("preserves layout and scrolled browsing state through selection and preview", async () => {
    entries.push(
      ...Array.from({ length: 60 }, (_, index) =>
        make(`more-${index}`, `file-${String(index).padStart(3, "0")}.txt`),
      ),
    );
    await mount();
    await enterProject();
    await expect.element(card("file-010.txt")).toBeInTheDocument();
    element("resource-scroll").scrollTop = 120;
    const before = layout();
    await card("file-010.txt").click();
    expect(layout()).toEqual(before);
    await card("file-011.txt").click();
    expect(layout()).toEqual(before);
    await card("file-010.txt").dblClick();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(layout()).toEqual(before);
    await closeDetails();
    expect(layout()).toEqual(before);
    await expect.element(page.getByRole("textbox", { name: "Search resources" })).toHaveValue("");
    await page.getByRole("button", { name: "Clear selection" }).click();
    expect(layout()).toEqual(before);
  });
  it("preserves search, filters, pagination and selection when closing details", async () => {
    entries = [
      entries[0]!,
      ...Array.from({ length: 110 }, (_, index) => ({
        ...make(`file-${index}`, `file-${String(index).padStart(3, "0")}.txt`),
        tags: ["pixel"],
      })),
    ];
    await mount();
    await enterProject();
    await page.getByRole("textbox", { name: "Search resources" }).fill("file-");
    await page.getByRole("textbox", { name: "Filter tags" }).fill("pixel");
    await page.getByRole("combobox", { name: "Search scope" }).selectOptions("project");
    await page.getByRole("combobox", { name: "File type" }).selectOptions("document");
    await page.getByRole("combobox", { name: "Sort by" }).selectOptions("name");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await card("file-100.txt").click();
    await card("file-100.txt").dblClick();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await closeDetails();
    await expect
      .element(page.getByRole("textbox", { name: "Search resources" }))
      .toHaveValue("file-");
    await expect.element(page.getByRole("textbox", { name: "Filter tags" })).toHaveValue("pixel");
    await expect
      .element(page.getByRole("combobox", { name: "Search scope" }))
      .toHaveValue("project");
    await expect.element(page.getByRole("combobox", { name: "File type" })).toHaveValue("document");
    await expect.element(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("name");
    await expect.element(checkbox("file-100.txt")).toBeChecked();
    await expect.element(checkbox("file-000.txt")).not.toBeInTheDocument();
  });
  it("shows the preview first in a short window without autofocus scrolling down to metadata", async () => {
    await page.viewport(840, 620);
    await mount();
    await enterProject();
    await card("hero.png").dblClick();
    await expect
      .element(page.getByRole("dialog").getByRole("img", { name: "hero.png" }))
      .toBeVisible();
    const dialog = page.getByRole("dialog").element();
    await vi.waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
    const content = element("resource-details-content");
    expect(content.scrollTop).toBe(0);
    expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(620);
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Short window notes");
    await expect
      .element(page.getByRole("textbox", { name: "Notes", exact: true }))
      .toHaveValue("Short window notes");
    await closeDetails();
  });
  it.each([840, 1440])(
    "keeps long paths and actions compact with a responsive detail dialog at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      const paths = [
        "Pixel Quest/assets",
        "Pixel Quest/assets/portraits",
        "Pixel Quest/assets/portraits/core",
        "Pixel Quest/assets/portraits/core/doctor-with-a-long-folder-name",
      ];
      addDirectories(paths);
      entries[1] = { ...entries[1]!, path: `${paths.at(-1)}/hero.png` };
      entries[2] = { ...entries[2]!, path: `${paths.at(-1)}/animation.json` };
      await mount();
      await enterProject();
      for (const path of paths) await card(path.split("/").at(-1)!).click();
      await expect.element(checkbox("hero.png")).toBeVisible();
      const breadcrumb = page.getByRole("navigation", { name: "Resource path" }).element();
      expect(getComputedStyle(breadcrumb).columnGap).toBe("4px");
      expect(getComputedStyle(breadcrumb.querySelector("button")!).paddingLeft).toBe("4px");
      expect(
        [...breadcrumb.querySelectorAll("button")].every(
          (button) => !button.textContent?.includes("/"),
        ),
      ).toBe(true);
      if (width < 1024) expect(breadcrumb.scrollWidth).toBeGreaterThan(breadcrumb.clientWidth);
      const frame = page.getByTestId("resource-center").element().getBoundingClientRect();
      const importButton = page
        .getByRole("button", { name: "Import files", exact: true })
        .element()
        .getBoundingClientRect();
      expect(importButton.right).toBeLessThanOrEqual(frame.right);
      const actions = element("resource-actions");
      expect(actions.getBoundingClientRect().height).toBe(40);
      const before = layout();
      await card("hero.png").click();
      expect(layout()).toEqual(before);
      await page.screenshot({
        path: `../../../../../output/playwright/resource-center-${width}.png`,
      });
      await card("hero.png").dblClick();
      await expect.element(page.getByRole("dialog")).toBeVisible();
      await expect
        .element(page.getByRole("dialog").getByRole("img", { name: "hero.png" }))
        .toBeVisible();
      await vi.waitFor(() => {
        const style = getComputedStyle(page.getByRole("dialog").element());
        expect(style.opacity).toBe("1");
        expect(style.scale).toBe("1");
      });
      const preview = element("resource-detail-preview").getBoundingClientRect();
      const fields = element("resource-detail-fields").getBoundingClientRect();
      if (width < 1024) expect(fields.top).toBeGreaterThanOrEqual(preview.bottom);
      else {
        expect(fields.top).toBe(preview.top);
        expect(fields.width).toBe(288);
        expect(fields.left).toBe(preview.right);
      }
      expect(page.getByRole("dialog").element().getBoundingClientRect().width).toBeLessThanOrEqual(
        1152,
      );
      expect(layout()).toEqual(before);
      await page.screenshot({
        path: `../../../../../output/playwright/resource-details-${width}.png`,
      });
      await closeDetails();
      expect(layout()).toEqual(before);
    },
  );
  it("opens the right-click collection action with the actual sidechat and message origin", async () => {
    let query:
      | Parameters<NonNullable<DesktopBridge["contextMenuExtension"]>["onQuery"]>[0]
      | undefined;
    let result:
      | Parameters<NonNullable<DesktopBridge["contextMenuExtension"]>["onResult"]>[0]
      | undefined;
    window.desktopBridge!.contextMenuExtension = {
      onQuery: (listener) => {
        query = listener;
        return () => {};
      },
      respond: vi.fn(),
      onResult: (listener) => {
        result = listener;
        return () => {};
      },
    };
    await mount(
      <ResourceChatContext.Provider value="sidechat-42">
        <ResourceCollectionDialog />
        <div data-chat-find-document-id="message-7">
          <ResourceCapture source={{ name: "hero.png", path: "/tmp/hero.png" }}>
            <span>Chat image</span>
          </ResourceCapture>
        </div>
      </ResourceChatContext.Provider>,
    );
    await page.getByText("Chat image", { exact: true }).click({ button: "right" });
    const capture = document.querySelector('[data-chat-find-document-id="message-7"] span')!;
    capture.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    );
    query?.({ requestId: "native-menu", x: 20, y: 30 });
    result?.({ requestId: "native-menu", selected: true });
    await vi.waitFor(() =>
      expect(useResourceCollection.getState().sources?.[0]?.origin).toMatchObject({
        kind: "chat",
        threadId: "sidechat-42",
        messageId: "message-7",
      }),
    );
    expect(window.desktopBridge!.showContextMenu).not.toHaveBeenCalled();
  });
});
