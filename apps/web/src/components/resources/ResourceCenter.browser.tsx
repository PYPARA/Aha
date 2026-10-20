import "../../index.css";
import type { CDPSession } from "@vitest/browser-playwright";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopBridge } from "@synara/contracts";
import {
  resourceType,
  type ResourceCommand,
  type ResourceEntry,
  type ResourceSnapshot,
  type ResourceBatchPlan,
  type ResourceQuery,
} from "@synara/contracts/resourceLibrary";
import ResourceCenter from "./ResourceCenter";
import { copy } from "~/aha/translations";
import { ResourceCollectionDialog } from "./ResourceCollectionDialog";
import {
  collectResources,
  queueResourceTransfer,
  retryResourceTransfer,
  useResourceAttachments,
  useResourceTransfer,
  useResourceCollection,
  useResourceTaskResults,
  type ResourceReceiveResult,
} from "./resourceLibrary";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn().mockResolvedValue(undefined) }));
let translated = false;
vi.mock("~/aha/AppearanceProvider", async (original) => ({
  ...(await original<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (s: string) => (translated ? (copy[s] ?? s) : s),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: async () => ({ ok: true, threadId: "new-chat" }) }),
}));
vi.mock("~/store", () => ({
  useStore: (select: (s: unknown) => unknown) => select({ sidebarThreadSummaryById: {} }),
}));
const originalBridge = window.desktopBridge;
let entries: ResourceEntry[],
  commands: ResourceCommand[],
  snapshot: ResourceSnapshot,
  metadataError: string | null;
let plan: ResourceBatchPlan | null;
let libraryChanged: (() => void) | undefined;
let batchFailures = new Set<string>();
let staleListReads = 0;
const make = (id: string, path: string, kind: ResourceEntry["kind"] = "file"): ResourceEntry => ({
  id,
  path,
  name: path.split("/").at(-1)!,
  kind,
  bytes: 1024,
  modifiedAt: Date.UTC(2026, 9, 19, 8),
  tags: [],
  notes: "",
  hash: id,
  fileKey: id,
});
const matchingEntries = (q: ResourceQuery, filtered = true) =>
  entries
    .filter(
      (entry) =>
        (q.recursive
          ? !q.path || entry.path.startsWith(q.path + "/")
          : entry.path.split("/").slice(0, -1).join("/") === q.path) &&
        (!q.kind || entry.kind === q.kind) &&
        (!filtered ||
          ((!q.query ||
            (q.searchIn === "nameAndPath" ? entry.path : entry.name)
              .toLowerCase()
              .includes(q.query.toLowerCase())) &&
            (!q.tag ||
              entry.tags.some((tag) => tag.toLowerCase().includes(q.tag!.toLowerCase()))) &&
            (!q.type ||
              q.type === "all" ||
              (entry.kind === "file" && resourceType(entry.name) === q.type)))),
    )
    .toSorted(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
        (q.sort === "modified" ? b.modifiedAt - a.modifiedAt : 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
beforeEach(async () => {
  await page.viewport(1440, 1000);
  localStorage.removeItem("aha:resources:test");
  localStorage.removeItem("aha:resource-destination");
  localStorage.removeItem("aha:resource-destination:test");
  navigate.mockClear();
  metadataError = null;
  translated = false;
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  plan = null;
  libraryChanged = undefined;
  batchFailures = new Set();
  staleListReads = 0;
  commands = [];
  entries = [
    make("project", "Game", "directory"),
    make("nested", "Game/Nested", "directory"),
    make("a", "Game/a.png"),
    make("b", "Game/Nested/b.png"),
    make("c", "Game/c.txt"),
  ];
  snapshot = {
    root: "/tmp/resources",
    libraryId: "test",
    directories: entries.filter((entry) => entry.kind === "directory"),
    count: 3,
    error: null,
    revision: 1,
    scan: {
      phase: "ready",
      lastCompletedAt: Date.now(),
      failedPath: null,
      skipped: { system: 0, temporary: 0, symbolicLinks: 0, unsupported: 0 },
    },
  };
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 20;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#7a98b4";
  context.fillRect(0, 0, 20, 20);
  const imageBytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (c) =>
    c.charCodeAt(0),
  );
  window.desktopBridge = {
    resourceLibrary: {
      request: async (command: ResourceCommand) => {
        commands.push(command);
        if (command.op === "snapshot" || command.op === "refresh" || command.op === "chooseRoot")
          return {
            ...snapshot,
            directoryStats: [{ id: null, path: "" }, ...snapshot.directories].map((d) => ({
              id: d.id,
              path: d.path,
              directFiles: matchingEntries({ path: d.path }).filter((e) => e.kind === "file")
                .length,
              directDirectories: matchingEntries({ path: d.path }).filter(
                (e) => e.kind === "directory",
              ).length,
              recursiveFiles: matchingEntries({ path: d.path, recursive: true, kind: "file" })
                .length,
            })),
          };
        if (command.op === "list") {
          const q = command.query;
          const matching = matchingEntries(q);
          return {
            entries: matching.slice(q.offset ?? 0, (q.offset ?? 0) + 100),
            total: matching.length,
            revision: staleListReads-- > 0 ? snapshot.revision! - 1 : snapshot.revision,
            stats: {
              scopeFiles: matchingEntries(q, false).filter((e) => e.kind === "file").length,
              matchedFiles: matching.filter((e) => e.kind === "file").length,
              matchedDirectories: matching.filter((e) => e.kind === "directory").length,
            },
          };
        }
        if (command.op === "locate") {
          const entry = entries.find((e) => e.id === command.id);
          if (!entry) throw new Error("Resource no longer exists. Refresh the library.");
          const parentPath = entry.path.split("/").slice(0, -1).join("/");
          const ordered = matchingEntries({ path: parentPath, sort: command.sort });
          return {
            entry,
            parentPath,
            parentId:
              entries.find((e) => e.kind === "directory" && e.path === parentPath)?.id ?? null,
            offset: Math.floor(ordered.findIndex((e) => e.id === command.id) / 100) * 100,
            revision: snapshot.revision,
          };
        }
        if (command.op === "read")
          return {
            name: entries.find((entry) => entry.id === command.id)?.name ?? "a.png",
            mimeType: command.id === "c" ? "text/plain" : "image/png",
            bytes: imageBytes,
          };
        if (command.op === "metadata") {
          if (metadataError) throw new Error(metadataError);
          entries = entries.map((entry) =>
            command.ids.includes(entry.id)
              ? { ...entry, tags: command.tags ?? entry.tags, notes: command.notes ?? entry.notes }
              : entry,
          );
          return;
        }
        if (command.op === "createDirectory") {
          const entry = make(
            "new",
            [command.parent, command.name].filter(Boolean).join("/"),
            "directory",
          );
          entries.push(entry);
          snapshot = { ...snapshot, directories: [...snapshot.directories, entry] };
          return entry;
        }
        if (command.op === "importPaths")
          return { added: 1, skipped: 0, failed: [], cancelled: false };
        if (command.op === "prepareBatch") {
          plan = {
            id: "plan",
            libraryId: "test",
            action: command.action,
            affectedCount: command.ids.length,
            items: command.ids.map((id, index) => ({
              id,
              source: entries.find((entry) => entry.id === id)!.path,
              target: `${command.target || "Game"}/${command.name || "export"}-${String(index + 1).padStart(3, "0")}`,
              status: "ready",
            })),
          };
          return plan;
        }
        if (command.op === "executeBatch")
          return {
            planId: command.planId,
            items: plan!.items.map((item) =>
              Object.assign({}, item, {
                status: batchFailures.has(item.id) ? "failed" : "succeeded",
                ...(batchFailures.has(item.id) ? { error: "The destination is occupied" } : {}),
              }),
            ),
          };
        return;
      },
      onChanged: (listener: () => void) => {
        libraryChanged = listener;
        return () => {
          libraryChanged = undefined;
        };
      },
      onProgress: () => () => {},
    },
  } as unknown as DesktopBridge;
});
afterEach(async () => {
  await cleanup();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  useResourceTransfer.setState({ pending: null, lastResult: null });
  useResourceCollection.setState({ sources: null });
  useResourceTaskResults.setState({ byLibrary: {} });
  localStorage.removeItem("aha:resources:test");
  vi.restoreAllMocks();
});
function mount(child = <ResourceCenter />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: 880, display: "flex" }}>{child}</div>
    </QueryClientProvider>,
  );
}
const asset = (name: string) =>
  page.getByTestId("resource-entries").getByRole("button", { name, exact: true });
const count = () => document.querySelectorAll('[data-resource-button][aria-pressed="true"]').length;
const selectOption = async (label: string, option: string) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

function resourcePointer() {
  const connection: CDPSession = cdp();
  const frame = window.frameElement?.getBoundingClientRect();
  const scale = frame ? frame.width / window.innerWidth : 1;
  return (
    type: "mousePressed" | "mouseMoved" | "mouseReleased",
    x: number,
    y: number,
    modifiers = 0,
  ) =>
    connection.send("Input.dispatchMouseEvent", {
      type,
      x: (frame?.left ?? 0) + x * scale,
      y: (frame?.top ?? 0) + y * scale,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      modifiers,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

describe("resource center workspace", () => {
  it("selects intersecting cards with a real pointer drag from blank space", async () => {
    await mount();
    await expect.element(asset("b.png")).toBeVisible();
    const scroll = page.getByTestId("resource-scroll");
    const bounds = scroll.element().getBoundingClientRect();
    const target = asset("b.png").element().getBoundingClientRect();
    const send = resourcePointer();
    await send("mouseMoved", bounds.left + 10, bounds.top + 6);
    await send("mousePressed", bounds.left + 10, bounds.top + 6);
    await send("mouseMoved", target.right - 2, target.bottom - 2);
    await expect.element(page.getByTestId("resource-marquee")).toBeVisible();
    await page.screenshot({
      path: "../../../../../.tmp/validation/resource-center/browser-marquee.png",
    });
    await send("mouseReleased", target.right - 2, target.bottom - 2);
    await expect.poll(count).toBe(2);
    await expect.element(asset("a.png")).toHaveAttribute("aria-pressed", "true");
    await expect.element(asset("b.png")).toHaveAttribute("aria-pressed", "true");
    await expect.element(asset("c.txt")).toHaveAttribute("aria-pressed", "false");
  });
  it("appends a marquee and restores its original set on Escape", async () => {
    await mount();
    await asset("c.txt").click();
    const bounds = page.getByTestId("resource-scroll").element().getBoundingClientRect();
    const target = asset("b.png").element().getBoundingClientRect();
    const send = resourcePointer();
    await send("mousePressed", bounds.left + 10, bounds.top + 6, 4);
    await send("mouseMoved", target.right - 2, target.bottom - 2, 4);
    await expect.poll(count).toBe(3);
    await userEvent.keyboard("{Escape}");
    await send("mouseReleased", target.right - 2, target.bottom - 2);
    await expect.poll(count).toBe(1);
    await expect.element(asset("c.txt")).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByTestId("resource-marquee")).not.toBeInTheDocument();
  });
  it("auto-scrolls a captured marquee and restores selection after cancelling", async () => {
    entries.push(
      ...Array.from({ length: 77 }, (_, i) => make(`extra-${i}`, `Game/extra-${i}.png`)),
    );
    await mount();
    await expect.element(asset("extra-0.png")).toBeInTheDocument();
    const scroll = page.getByTestId("resource-scroll").element();
    const bounds = scroll.getBoundingClientRect();
    const send = resourcePointer();
    await send("mousePressed", bounds.left + 10, bounds.top + 6);
    await send("mouseMoved", bounds.left + 250, bounds.bottom - 2);
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(100);
    expect(count()).toBeGreaterThan(1);
    await userEvent.keyboard("{Escape}");
    await send("mouseReleased", bounds.left + 250, bounds.bottom - 2);
    expect(count()).toBe(0);
    expect(commands.filter((c) => c.op === "read").length).toBeLessThanOrEqual(80);
  });
  it("moves keyboard focus, limits select-all to the resource area, and opens a narrow navigation drawer", async () => {
    await page.viewport(680, 900);
    await mount();
    await asset("a.png").click();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(asset("b.png")).toHaveFocus();
    await expect.element(asset("b.png")).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Meta>}a{/Meta}");
    expect(count()).toBe(3);
    await page.getByRole("textbox", { name: "Search resources", exact: true }).fill("a");
    await userEvent.keyboard("{Meta>}a{/Meta}");
    expect(count()).toBe(0);
    await page.getByRole("textbox", { name: "Search resources", exact: true }).fill("");
    await page.getByRole("button", { name: "Show resource navigation", exact: true }).click();
    await expect.element(page.getByRole("treeitem", { name: "Game", exact: true })).toBeVisible();
  });
  it.each([
    { width: 1440, dark: false, scale: 1, view: "grid", details: false },
    { width: 1280, dark: true, scale: 1.25, view: "grid", details: true },
    { width: 1024, dark: false, scale: 1.5, view: "list", details: true },
    { width: 640, dark: true, scale: 1.5, view: "grid", details: false },
  ])(
    "keeps the workspace usable at $width pixels, $scale font scale",
    async ({ width, dark, scale, view, details }) => {
      translated = true;
      document.documentElement.classList.toggle("dark", dark);
      const style = document.documentElement.style;
      style.setProperty("--app-font-size-ui", `${13 * scale}px`);
      style.setProperty("--app-font-size-ui-sm", `${12 * scale}px`);
      style.setProperty("--app-font-size-ui-xs", `${11 * scale}px`);
      await page.viewport(width, 1000);
      await mount();
      await expect.element(asset("b.png")).toBeVisible();
      await asset("a.png").click();
      if (view === "list")
        await page.getByRole("button", { name: copy["List view"]!, exact: true }).click();
      if (details)
        await page.getByRole("button", { name: copy["Show details"]!, exact: true }).click();
      if (width < 768) {
        await page
          .getByRole("button", { name: copy["Show resource navigation"]!, exact: true })
          .click();
        await expect.element(page.getByTestId("resource-sidebar")).toBeVisible();
        await page.getByRole("button", { name: copy["Close navigation"]!, exact: true }).click();
      }
      const center = page.getByTestId("resource-center").element();
      expect(center.scrollWidth).toBeLessThanOrEqual(center.clientWidth + 1);
      const footer = page.getByTestId("resource-actions").element();
      expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
      await page.screenshot({
        path: `../../../../../.tmp/validation/resource-center/browser-${width}-${dark ? "dark" : "light"}-${Math.round(scale * 100)}.png`,
      });
    },
  );
  it("starts aggregated, without left-side file entries or permanent checkboxes", async () => {
    await mount();
    await expect.element(asset("a.png")).toBeVisible();
    await expect.element(asset("b.png")).toBeVisible();
    expect(
      document.querySelectorAll("[data-testid=resource-sidebar] [data-resource-entry-id]").length,
    ).toBe(0);
    await expect
      .element(page.getByRole("checkbox", { name: "Select a.png", exact: true }))
      .not.toBeInTheDocument();
    expect(
      commands.some(
        (command) =>
          command.op === "list" && command.query.kind === "file" && command.query.recursive,
      ),
    ).toBe(true);
    await expect
      .element(page.getByRole("button", { name: "More actions", exact: true }))
      .not.toBeInTheDocument();
  });
  it("replaces single clicks, uses Cmd/Shift, and preserves selection across views", async () => {
    await mount();
    await asset("a.png").click();
    await asset("b.png").click();
    expect(count()).toBe(1);
    await asset("b.png").click();
    expect(count()).toBe(1);
    await asset("a.png").click({ modifiers: ["Meta"] });
    expect(count()).toBe(2);
    await asset("c.txt").click({ modifiers: ["Shift"] });
    expect(count()).toBe(3);
    await page.getByRole("button", { name: "List view", exact: true }).click();
    expect(count()).toBe(3);
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    expect(count()).toBe(0);
  });
  it("provides explicit multiple mode and preserves its set through double-click preview", async () => {
    await mount();
    await page.getByRole("button", { name: "Select multiple", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select a.png", exact: true }).click();
    await asset("b.png").click();
    expect(count()).toBe(2);
    await asset("a.png").dblClick();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(count()).toBe(2);
  });
  it("keeps right-clicked existing selections and scopes the context menu", async () => {
    await mount();
    await asset("a.png").click();
    await asset("b.png").click({ modifiers: ["Meta"] });
    await asset("a.png").click({ button: "right" });
    expect(count()).toBe(2);
    await expect
      .element(page.getByRole("menuitem", { name: "Move to", exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await asset("c.txt").click({ button: "right" });
    expect(count()).toBe(1);
  });
  it("navigates projects without selecting files and remembers browsing preferences", async () => {
    await mount();
    await asset("a.png").click();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    expect(count()).toBe(0);
    await expect.element(asset("Nested")).toBeVisible();
    await expect.element(asset("b.png")).not.toBeInTheDocument();
    const saved = JSON.parse(localStorage.getItem("aha:resources:test")!);
    expect(saved.location).toMatchObject({
      mode: "directory",
      path: "Game",
      recursive: false,
      directoryId: "project",
    });
    expect(saved.selected).toBeUndefined();
  });
  it("makes folders selectable and requires double click to enter", async () => {
    await mount();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    await expect.element(asset("Nested")).toBeVisible();
    await asset("Nested").click();
    expect(count()).toBe(1);
    await expect.element(asset("a.png")).toBeVisible();
    await asset("Nested").dblClick();
    await expect.element(asset("b.png")).toBeVisible();
    expect(count()).toBe(0);
  });
  it("separates tree expansion, keyboard focus and directory navigation from resource selection", async () => {
    await mount();
    await asset("a.png").click();
    const sidebar = page.getByTestId("resource-sidebar");
    await sidebar.getByRole("button", { name: "Game", exact: true }).click();
    await expect
      .element(sidebar.getByRole("treeitem", { name: "Game/Nested", exact: true }))
      .toBeVisible();
    expect(count()).toBe(1);
    await userEvent.keyboard("{ArrowDown}");
    expect(count()).toBe(1);
    await expect.element(asset("a.png")).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Enter}");
    await expect.element(asset("b.png")).toBeVisible();
    await expect.element(asset("a.png")).not.toBeInTheDocument();
    expect(count()).toBe(0);
    await expect
      .element(sidebar.getByRole("treeitem", { name: "Game/Nested", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await sidebar.getByRole("textbox", { name: "Find folder", exact: true }).fill("Nested");
    await expect
      .element(sidebar.getByRole("treeitem", { name: "Game", exact: true }))
      .toBeVisible();
    await expect.element(asset("b.png")).toBeVisible();
    await sidebar.getByRole("textbox", { name: "Find folder", exact: true }).fill("");
    await expect
      .element(sidebar.getByRole("button", { name: "Game", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path: "../../../../../.tmp/validation/resource-center/browser-directory-navigation.png",
    });
  });
  it("virtualizes a long folder tree and keeps Home/End focus independent of activation", async () => {
    const folders = Array.from({ length: 240 }, (_, i) =>
      make(`folder-${i}`, `Folder-${String(i).padStart(3, "0")}`, "directory"),
    );
    entries.push(...folders);
    snapshot = { ...snapshot, directories: [...snapshot.directories, ...folders] };
    await mount();
    await asset("a.png").click();
    const tree = page.getByRole("tree", { name: "Projects and folders", exact: true });
    tree.element().focus();
    await userEvent.keyboard("{End}");
    await expect
      .poll(() => tree.element().querySelectorAll("[role=treeitem]").length)
      .toBeLessThan(60);
    await expect
      .element(page.getByRole("treeitem", { name: "Game", exact: true }))
      .toBeInTheDocument();
    expect(tree.element().getAttribute("aria-activedescendant")).toContain("project");
    expect(count()).toBe(1);
    await userEvent.keyboard("{Home}{ArrowDown}{Enter}");
    await expect
      .element(
        page.getByText("Drop files here, import a folder, or collect resources from a chat.", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(count()).toBe(0);
  });
  it("recalculates panels when the application font size changes", async () => {
    await page.viewport(900, 1000);
    await mount();
    await expect.element(page.getByTestId("resource-sidebar")).toBeVisible();
    document.documentElement.style.setProperty("--app-font-size-ui", "19.5px");
    await expect.element(page.getByTestId("resource-sidebar")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Show resource navigation", exact: true }).click();
    await expect
      .element(page.getByRole("tree", { name: "Projects and folders", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Show resource navigation", exact: true }))
      .toHaveFocus();
  });
  it("locates a path-search result on its correct mixed-content page and returns to the search", async () => {
    entries = [
      entries[0]!,
      entries[1]!,
      ...Array.from({ length: 201 }, (_, i) =>
        make(`page-${i}`, `Game/${String(i).padStart(3, "0")}.txt`),
      ),
    ];
    await mount();
    await page.getByRole("textbox", { name: "Search resources", exact: true }).fill("200.txt");
    await expect.element(asset("200.txt")).toBeVisible();
    await asset("200.txt").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Locate folder", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Current folder", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(asset("200.txt")).toHaveAttribute("aria-pressed", "true");
    await expect.element(asset("200.txt")).toHaveFocus();
    await expect.element(page.getByTestId("resource-actions")).toHaveTextContent("201–202");
    await expect
      .element(
        page.getByTestId("resource-sidebar").getByRole("treeitem", { name: "Game", exact: true }),
      )
      .toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Previous resource location", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Search resources", exact: true }))
      .toHaveValue("200.txt");
    await expect.element(asset("200.txt")).toBeVisible();
    expect(count()).toBe(0);
  });
  it("shows root files and accepts an explicit root import destination", async () => {
    entries.push(make("root-file", "root-file.txt"));
    await mount();
    await page.getByRole("button", { name: "Library root", exact: true }).click();
    await expect.element(asset("root-file.txt")).toBeVisible();
    await expect.element(asset("Game")).toBeVisible();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import files", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "importPaths" && c.target === "")).toBe(true),
    );
    await page
      .getByTestId("resource-sidebar")
      .getByRole("button", { name: "All resources", exact: true })
      .click();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import files", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
    await selectOption("Destination", "Library root");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.filter((c) => c.op === "importPaths" && c.target === "")).toHaveLength(2),
    );
  });
  it("searches paths only inside the explicit scope and keeps counts visible with a selection", async () => {
    await mount();
    await page.getByRole("textbox", { name: "Search resources", exact: true }).fill("Nested");
    await expect.element(asset("b.png")).toBeVisible();
    await expect.element(asset("a.png")).not.toBeInTheDocument();
    await asset("b.png").click();
    await expect.element(page.getByTestId("resource-actions")).toHaveTextContent("1–1");
    await expect.element(page.getByTestId("resource-actions")).toHaveTextContent("Selected: 1");
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    await expect
      .element(page.getByRole("textbox", { name: "Search resources", exact: true }))
      .toHaveValue("");
    await expect.element(asset("Nested")).toBeVisible();
    await expect.element(asset("b.png")).not.toBeInTheDocument();
  });
  it("keeps cached files visible after a failed scan and disables library writes", async () => {
    snapshot = {
      ...snapshot,
      error: "Access denied",
      scan: { ...snapshot.scan!, phase: "failed", failedPath: "Game/Blocked" },
    };
    await mount();
    await expect.element(asset("a.png")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("menuitem", { name: "Index status", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Game/Blocked: Access denied");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Results may be incomplete");
    await page.screenshot({
      path: "../../../../../.tmp/validation/resource-center/browser-scan-failure.png",
    });
  });
  it("shows cached files during a scan without claiming they are synchronized", async () => {
    snapshot = { ...snapshot, scan: { ...snapshot.scan!, phase: "scanning" } };
    await mount();
    await expect.element(asset("a.png")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    await expect.element(page.getByText("Synced", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("resource-sidebar"))
      .toHaveTextContent("Scanning; counts may change");
    snapshot = { ...snapshot, scan: { ...snapshot.scan!, phase: "ready" } };
    libraryChanged?.();
    await expect.element(page.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
  });
  it("rereads an outdated page revision without mixing it with newer directory statistics", async () => {
    await mount();
    await asset("a.png").click();
    snapshot = { ...snapshot, revision: 2 };
    staleListReads = 1;
    libraryChanged?.();
    await expect.element(asset("a.png")).toBeVisible();
    await expect.element(page.getByTestId("resource-actions")).toHaveTextContent("1–3");
    await expect.poll(() => staleListReads).toBeLessThan(0);
    await expect.element(asset("a.png")).toHaveAttribute("aria-pressed", "true");
    expect(commands.filter((c) => c.op === "list").length).toBeGreaterThanOrEqual(3);
  });
  it("renders the Chinese current-folder layout with both folders and files", async () => {
    translated = true;
    await mount();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    await expect.element(asset("Nested")).toBeVisible();
    await expect.element(asset("b.png")).not.toBeInTheDocument();
    await asset("a.png").click();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("button", { name: "Game", exact: true })
      .click();
    await expect.element(asset("a.png")).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: "../../../../../.tmp/validation/resource-center/browser-current-folder-zh.png",
    });
  });
  it("enters a newly created subfolder in current-folder scope", async () => {
    await mount();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Created");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Created", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Current folder", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(
        page
          .getByTestId("resource-sidebar")
          .getByRole("treeitem", { name: "Game/Created", exact: true }),
      )
      .toHaveAttribute("aria-selected", "true");
  });
  it("keeps current-folder searches scoped until All assets is chosen", async () => {
    await mount();
    await page
      .getByTestId("resource-sidebar")
      .getByRole("treeitem", { name: "Game", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Search resources", exact: true }).fill("b.png");
    await expect.element(page.getByText("No matching resources", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "All assets", exact: true }).click();
    await expect.element(asset("b.png")).toBeVisible();
  });
  it("protects dirty details and retains a failed save draft", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "Show details", exact: true }).click();
    await page
      .getByTestId("resource-inspector")
      .getByRole("textbox", { name: "Tags", exact: true })
      .fill("edited");
    await asset("b.png").click();
    await expect.element(page.getByText("Unsaved resource details", { exact: true })).toBeVisible();
    metadataError = "save failed";
    await page.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect
      .element(page.getByRole("dialog").getByRole("alert"))
      .toHaveTextContent("save failed");
    metadataError = null;
    await page.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(entries.find((entry) => entry.id === "a")?.tags).toEqual(["edited"]);
    expect(document.querySelector('[data-resource-button="b"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
  it("preserves an unsaved draft when its file disappears externally", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "Show details", exact: true }).click();
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Keep this draft");
    entries = entries.filter((entry) => entry.id !== "a");
    libraryChanged?.();
    await expect.element(asset("a.png")).not.toBeInTheDocument();
    await expect.element(page.getByText("Keep this draft", { exact: true })).toBeVisible();
    await asset("b.png").click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect.element(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("");
  });
  it("waits for a dirty draft decision before replacing a right-click selection", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "Show details", exact: true }).click();
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("draft");
    await asset("b.png").click({ button: "right" });
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Move to", exact: true }))
      .toBeVisible();
    await expect.element(asset("b.png")).toHaveAttribute("aria-pressed", "true");
    expect(count()).toBe(1);
  });
  it("previews a rename before executing the exact prepared batch", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("renamed.png");
    await page.getByRole("button", { name: "Preview changes", exact: true }).click();
    await expect
      .element(page.getByTestId("resource-batch-preview"))
      .toHaveTextContent("Game/a.png");
    expect(commands.some((c) => c.op === "executeBatch")).toBe(false);
    await page.getByRole("button", { name: "Confirm operation", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "executeBatch" && c.planId === "plan")).toBe(true),
    );
  });
  it("keeps failed items selected, retries the frozen batch, and retains its report after returning", async () => {
    batchFailures.add("b");
    await mount();
    await asset("a.png").click();
    await asset("b.png").click({ modifiers: ["Meta"] });
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("frame");
    await page.getByRole("button", { name: "Preview changes", exact: true }).click();
    await page.getByRole("button", { name: "Confirm operation", exact: true }).click();
    await expect.poll(count).toBe(1);
    await expect.element(asset("b.png")).toHaveAttribute("aria-pressed", "true");
    await page.getByText("Operation results", { exact: false }).click();
    batchFailures.clear();
    await page.getByRole("button", { name: "Retry failed items", exact: true }).click();
    await expect.poll(count).toBe(0);
    expect(
      commands.some((c) => c.op === "executeBatch" && c.planId === "plan" && c.retryFailed),
    ).toBe(true);
    await cleanup();
    await mount();
    await expect.element(page.getByText(/Operation results.*Completed: 2/)).toBeVisible();
  });
  it("does not reuse a thumbnail from another library with the same resource ID", async () => {
    await mount();
    await expect.poll(() => commands.filter((c) => c.op === "read" && c.id === "a").length).toBe(1);
    await asset("a.png").click();
    snapshot = { ...snapshot, libraryId: "second-library" };
    libraryChanged?.();
    await expect.poll(() => commands.filter((c) => c.op === "read" && c.id === "a").length).toBe(2);
    expect(count()).toBe(0);
  });
  it("defaults batch tags to addition", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "Edit tags", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Tags", exact: true })
      .fill("common");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "metadata" && c.tagMode === "add")).toBe(true),
    );
  });
  it("requires destination selection for imports from all resources", async () => {
    await mount();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import files", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
    await selectOption("Destination", "Game");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "importPaths" && c.target === "Game")).toBe(true),
    );
  });
  it("clears selection when changing pages and labels all-selection as this page", async () => {
    entries = [
      entries[0]!,
      ...Array.from({ length: 110 }, (_, i) =>
        make(`f${i}`, `Game/${String(i).padStart(3, "0")}.txt`),
      ),
    ];
    await mount();
    await expect.element(asset("000.txt")).toBeVisible();
    await page.getByRole("button", { name: "Select this page", exact: true }).click();
    expect(count()).toBe(100);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(asset("100.txt")).toBeVisible();
    expect(count()).toBe(0);
  });
  it("queues drawing reuse without starting a generation", async () => {
    await mount();
    await asset("a.png").click();
    await page.getByRole("button", { name: "Use in…", exact: true }).click();
    await page.getByRole("menuitem", { name: "Use in drawing", exact: true }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/drawing" }));
    expect(useResourceTransfer.getState().pending).toMatchObject({
      target: "drawing",
      status: "queued",
      resourceIds: ["a"],
    });
  });
  it("collects external files through the shared destination selector", async () => {
    collectResources([{ name: "sprite.png", path: "/tmp/sprite.png" }]);
    await mount(<ResourceCollectionDialog />);
    await expect
      .element(page.getByRole("button", { name: "Add to resource center", exact: true }))
      .toBeDisabled();
    await selectOption("Destination", "Game");
    await page.getByRole("button", { name: "Add to resource center", exact: true }).click();
    await vi.waitFor(() =>
      expect(commands.some((c) => c.op === "importPaths" && c.target === "Game")).toBe(true),
    );
  });
});
function Receiver({ receive }: { receive: (files: File[]) => Promise<ResourceReceiveResult> }) {
  useResourceAttachments("drawing", receive);
  return <span>receiver</span>;
}
it("claims transfers once in StrictMode and retries only rejected files", async () => {
  const receive = vi
    .fn<(files: File[]) => Promise<ResourceReceiveResult>>()
    .mockResolvedValueOnce({ accepted: [0], rejected: [{ index: 1, error: "capacity" }] })
    .mockResolvedValueOnce({ accepted: [0], rejected: [] });
  queueResourceTransfer(
    "drawing",
    [new File(["a"], "a.png"), new File(["b"], "b.png")],
    ["a", "b"],
    "test",
  );
  await mount(
    <StrictMode>
      <Receiver receive={receive} />
    </StrictMode>,
  );
  await vi.waitFor(() =>
    expect(useResourceTransfer.getState().lastResult?.rejected).toHaveLength(1),
  );
  expect(receive).toHaveBeenCalledTimes(1);
  expect(useResourceTransfer.getState().lastResult?.acceptedIds).toEqual(["a"]);
  retryResourceTransfer();
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  expect(receive.mock.calls[1]?.[0].map((file) => file.name)).toEqual(["b.png"]);
  await vi.waitFor(() =>
    expect(useResourceTransfer.getState().lastResult?.rejected).toHaveLength(0),
  );
});
