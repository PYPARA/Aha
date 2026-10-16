import { Fragment, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
import {
  type ResourceEntry,
  type ResourcePage,
  type ResourceQuery,
  type ResourceImportResult,
  type ResourceCommand,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { FolderIcon, SearchIcon, XIcon } from "~/lib/icons";
import { useStore } from "~/store";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import {
  resourceApi,
  resourceKey,
  resourceFile,
  useResourceLibrary,
  useResourceTransfer,
} from "./resourceLibrary";
import { ResourceDirectoryTree } from "./ResourceDirectoryTree";
import { ResourceDetailsDialog } from "./ResourceDetailsDialog";
import {
  ResourcePreview as Preview,
  humanResourceBytes as humanBytes,
  resourceFieldClassName as field,
} from "./ResourcePreview";
export default function ResourceCenter() {
  const tr = useAhaTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const library = useResourceLibrary();
  const { handleNewChat } = useHandleNewChat();
  const threads = useStore((s) => s.sidebarThreadSummaryById);
  const [current, setCurrent] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [scope, setScope] = useState("folder");
  const [type, setType] = useState<ResourceQuery["type"]>("all");
  const [sort, setSort] = useState<ResourceQuery["sort"]>("modified");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ResourceEntry | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const breadcrumbRef = useRef<HTMLElement | null>(null);
  const firstClick = useRef<{ id: string; selected: string[] } | null>(null);
  const treeFirstClick = useRef<{ id: string; selected: string[] } | null>(null);
  const treeTarget = useRef<{
    entry: ResourceEntry;
    offset: number;
    trigger: HTMLElement;
    open: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ResourceImportResult | null>(null);
  const [modal, setModal] = useState<
    "project" | "folder" | "rename" | "move" | "tags" | "chat" | null
  >(null);
  const [value, setValue] = useState("");
  const [destination, setDestination] = useState("");
  const dirs = library.data?.directories ?? [];
  const breadcrumbs = current
    .split("/")
    .filter(Boolean)
    .map((label, index, segments) => ({ label, path: segments.slice(0, index + 1).join("/") }));
  const filters: ResourceQuery = {
    path: scope === "all" ? "" : scope === "project" ? (current.split("/")[0] ?? "") : current,
    recursive: !!query || !!tag || type !== "all" || scope !== "folder",
    query,
    tag,
    type,
    sort,
    offset,
  };
  const page = useQuery({
    queryKey: [...resourceKey, "list", filters],
    queryFn: () => resourceApi<ResourcePage>({ op: "list", query: filters }),
    enabled: !!library.data?.root,
  });
  useEffect(
    () =>
      window.desktopBridge?.resourceLibrary?.onProgress((p) =>
        setProgress(`${p.completed} · ${p.name}`),
      ),
    [],
  );
  useEffect(() => {
    setOffset(treeTarget.current?.offset ?? 0);
    setSelected([]);
    firstClick.current = null;
  }, [current, query, tag, type, sort, scope]);
  useEffect(() => {
    const breadcrumb = breadcrumbRef.current;
    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth - breadcrumb.clientWidth;
  }, [current]);
  useEffect(() => setSelected([]), [offset]);
  useEffect(() => {
    if (
      library.data &&
      !library.data.error &&
      current &&
      !library.data.directories.some((d) => d.path === current)
    )
      setCurrent("");
  }, [library.data, current]);
  useEffect(() => {
    setCurrent("");
    setSelected([]);
    setDetail(null);
    firstClick.current = null;
    treeFirstClick.current = null;
    treeTarget.current = null;
  }, [library.data?.libraryId]);
  const openDetails = (entry: ResourceEntry, trigger: HTMLElement) => {
    detailTrigger.current = trigger;
    setDetail(entry);
  };
  const navigateFolder = (path: string) => {
    treeTarget.current = null;
    treeFirstClick.current = null;
    setCurrent(path);
    setDetail(null);
  };
  const toggleSelection = (id: string) =>
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  const locateTreeFile = (
    entry: ResourceEntry,
    pageOffset: number,
    trigger: HTMLElement,
    open: boolean,
  ) => {
    treeTarget.current = { entry, offset: pageOffset, trigger, open };
    setDetail(null);
    setCurrent(entry.path.split("/").slice(0, -1).join("/"));
    setQuery("");
    setTag("");
    setScope("folder");
    setType("all");
    setSort("name");
    setOffset(pageOffset);
  };
  const clickTreeFile = (
    entry: ResourceEntry,
    pageOffset: number,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (event.detail > 1) return;
    const parent = entry.path.split("/").slice(0, -1).join("/");
    if (
      current === parent &&
      scope === "folder" &&
      !query &&
      !tag &&
      type === "all" &&
      !page.isPending &&
      page.data?.entries.some((item) => item.id === entry.id)
    ) {
      treeFirstClick.current = event.detail === 1 ? { id: entry.id, selected } : null;
      toggleSelection(entry.id);
    } else {
      treeFirstClick.current = null;
      locateTreeFile(entry, pageOffset, event.currentTarget, false);
    }
  };
  const doubleClickTreeFile = (
    entry: ResourceEntry,
    pageOffset: number,
    trigger: HTMLElement,
    restoreSelection = true,
  ) => {
    if (restoreSelection && treeFirstClick.current?.id === entry.id)
      setSelected(treeFirstClick.current.selected);
    treeFirstClick.current = null;
    if (treeTarget.current?.entry.id === entry.id) treeTarget.current.open = true;
    else if (
      current === entry.path.split("/").slice(0, -1).join("/") &&
      page.data?.entries.some((item) => item.id === entry.id)
    )
      openDetails(entry, trigger);
    else locateTreeFile(entry, pageOffset, trigger, true);
  };
  useEffect(() => {
    if (page.data)
      setDetail((previous) =>
        previous ? (page.data.entries.find((e) => e.id === previous.id) ?? null) : null,
      );
  }, [page.data]);
  useEffect(() => {
    const target = treeTarget.current;
    if (
      !target ||
      current !== target.entry.path.split("/").slice(0, -1).join("/") ||
      query ||
      tag ||
      scope !== "folder" ||
      type !== "all" ||
      sort !== "name"
    )
      return;
    // Filter/navigation resets run first; apply the tree's page after those resets.
    if (offset !== target.offset) {
      setOffset(target.offset);
      return;
    }
    if (page.isPending) return;
    if (page.error) {
      treeTarget.current = null;
      return;
    }
    const entry = page.data?.entries.find((item) => item.id === target.entry.id);
    treeTarget.current = null;
    if (!entry) return;
    setSelected([entry.id]);
    const card = document.querySelector<HTMLElement>(
      `[data-resource-entry-id="${CSS.escape(entry.id)}"]`,
    );
    card?.scrollIntoView({ block: "nearest" });
    if (target.open) openDetails(entry, target.trigger);
  }, [current, query, tag, scope, type, sort, offset, page.data, page.isPending, page.error]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
      await client.invalidateQueries({
        queryKey: resourceKey,
        predicate: (q) => q.queryKey[1] !== "preview",
      });
    }
  };
  const execute = (command: ResourceCommand) =>
    run(async () => {
      await resourceApi(command);
    });
  const open = (mode: NonNullable<typeof modal>) => {
    setModal(mode);
    setValue(
      mode === "rename" && selected.length === 1
        ? (page.data?.entries.find((e) => e.id === selected[0])?.name ?? "")
        : "",
    );
    setDestination(mode === "chat" ? "new" : current);
  };
  const importFiles = (paths?: string[], directories = false) =>
    run(async () => {
      setResult(null);
      setResult(
        await resourceApi<ResourceImportResult>({
          op: "importPaths",
          target: current,
          ...(paths ? { paths } : {}),
          directories,
        }),
      );
    });
  const transfer = async (target: string) => {
    const files = await Promise.all(selected.map(resourceFile));
    if (
      target === "drawing" &&
      files.some(
        (f) =>
          !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 20 * 1024 * 1024,
      )
    )
      throw new Error("Choose PNG, JPEG or WebP images up to 20 MiB each.");
    if (useResourceTransfer.getState().pending)
      throw new Error("Finish the previous resource transfer first.");
    let id = target;
    if (id === "new") {
      const created = await handleNewChat({ fresh: true });
      if (!created.ok) throw new Error(created.error);
      if (!created.threadId) throw new Error("Unable to prepare a new chat.");
      id = created.threadId;
    }
    useResourceTransfer.setState({ pending: { target: id, files } });
    if (id === "drawing") await navigate({ to: "/drawing" });
    else await navigate({ to: "/$threadId", params: { threadId: id as ThreadId } });
  };
  const submitModal = () =>
    run(async () => {
      if (modal === "project" || modal === "folder") {
        const created = await resourceApi<ResourceEntry>({
          op: "createDirectory",
          parent: modal === "project" ? "" : current,
          name: value,
        });
        await client.invalidateQueries({ queryKey: [...resourceKey, "snapshot"] });
        navigateFolder(created.path);
      }
      if (modal === "rename") await resourceApi({ op: "rename", ids: selected, name: value });
      if (modal === "move") await resourceApi({ op: "move", ids: selected, target: destination });
      if (modal === "tags")
        await resourceApi({ op: "metadata", ids: selected, tags: value.split(",") });
      if (modal === "chat") await transfer(destination);
      setModal(null);
      setSelected([]);
    });
  const selectedEntries = page.data?.entries.filter((e) => selected.includes(e.id)) ?? [];
  const filesOnly = selectedEntries.length > 0 && selectedEntries.every((e) => e.kind === "file");
  if (!window.desktopBridge?.resourceLibrary)
    return <div className="p-8">{tr("Resource center is available in the desktop app.")}</div>;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="resource-center"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h1 className="text-sm font-semibold">{tr("Resource center")}</h1>
          <p className="text-xs text-muted-foreground">
            {tr("Collect, organize and reuse your creative files.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void execute({ op: "refresh" })}>
            {tr("Refresh")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void execute({ op: "chooseRoot" })}
          >
            {tr(library.data?.root ? "Switch library" : "Choose resource folder")}
          </Button>
        </div>
      </header>
      {error || library.error || library.data?.error || page.error ? (
        <div
          role="alert"
          className="shrink-0 whitespace-pre-wrap border-b border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {tr(error ?? library.data?.error ?? library.error?.message ?? page.error?.message ?? "")}
        </div>
      ) : null}
      {!library.data?.root ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto p-8 text-center">
          <FolderIcon className="mt-auto size-12 shrink-0 text-muted-foreground" />
          <h2 className="text-lg font-medium">{tr("A home for your creative resources")}</h2>
          <p className="max-w-lg text-sm text-muted-foreground">
            {tr(
              "Choose one folder for your library. Projects become real folders, and your files remain available in Finder.",
            )}
          </p>
          <Button
            className="mb-auto"
            disabled={busy}
            onClick={() => void execute({ op: "chooseRoot" })}
          >
            {tr("Choose resource folder")}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ResourceDirectoryTree
            key={library.data.libraryId}
            directories={dirs}
            current={current}
            root={library.data.root}
            busy={busy}
            onNavigate={navigateFolder}
            onNewProject={() => open("project")}
            onRevealRoot={() => void execute({ op: "reveal" })}
            libraryId={library.data.libraryId}
            selected={selected}
            onFileClick={clickTreeFile}
            onFileDoubleClick={doubleClickTreeFile}
          />
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            onDragOver={(e) => {
              if (current) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (busy || !current) return;
              const paths = [...e.dataTransfer.files].flatMap((f) => {
                const p = window.desktopBridge?.getPathForFile?.(f);
                return p ? [p] : [];
              });
              if (paths.length) void importFiles(paths);
            }}
          >
            <div className="shrink-0 space-y-3 border-b border-border p-4">
              <div className="flex items-center gap-2">
                <nav
                  ref={breadcrumbRef}
                  aria-label={tr("Resource path")}
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1"
                    onClick={() => navigateFolder("")}
                    aria-current={!current ? "page" : undefined}
                  >
                    {tr("All projects")}
                  </Button>
                  {breadcrumbs.map((crumb) => (
                    <Fragment key={crumb.path}>
                      <span aria-hidden="true" className="text-sm text-muted-foreground">
                        /
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-1"
                        onClick={() => navigateFolder(crumb.path)}
                        aria-current={current === crumb.path ? "page" : undefined}
                      >
                        {crumb.label}
                      </Button>
                    </Fragment>
                  ))}
                </nav>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !current}
                    onClick={() => open("folder")}
                  >
                    {tr("New folder")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !current}
                    onClick={() => void importFiles(undefined, true)}
                  >
                    {tr("Import folder")}
                  </Button>
                  <Button size="sm" disabled={busy || !current} onClick={() => void importFiles()}>
                    {tr("Import files")}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="relative min-w-40 flex-1">
                  <SearchIcon className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <input
                    aria-label={tr("Search resources")}
                    placeholder={tr("Search resources")}
                    className={`${field} w-full pl-9`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <input
                  aria-label={tr("Filter tags")}
                  placeholder={tr("Filter tags")}
                  className={`${field} w-32`}
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                />
                <select
                  className={field}
                  aria-label={tr("Search scope")}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="folder">{tr("Current folder")}</option>
                  <option value="project">{tr("Current project")}</option>
                  <option value="all">{tr("Entire library")}</option>
                </select>
                <select
                  className={field}
                  aria-label={tr("File type")}
                  value={type}
                  onChange={(e) => setType(e.target.value as ResourceQuery["type"])}
                >
                  {["all", "image", "audio", "video", "document", "other"].map((t) => (
                    <option key={t} value={t}>
                      {tr(t)}
                    </option>
                  ))}
                </select>
                <select
                  className={field}
                  aria-label={tr("Sort by")}
                  value={sort}
                  onChange={(e) => setSort(e.target.value as ResourceQuery["sort"])}
                >
                  <option value="modified">{tr("Modified")}</option>
                  <option value="name">{tr("Name")}</option>
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setView(view === "grid" ? "list" : "grid")}
                >
                  {tr(view === "grid" ? "List view" : "Grid view")}
                </Button>
              </div>
              <div
                className="flex h-10 items-center gap-2 overflow-x-auto whitespace-nowrap text-sm"
                aria-label={tr("Resource actions")}
                data-testid="resource-actions"
              >
                <span className="w-28 shrink-0 tabular-nums">
                  {selected.length} {tr("selected")}
                </span>
                {(["rename", "move", "tags", "chat"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant="outline"
                    disabled={busy || !selected.length || (mode === "chat" && !filesOnly)}
                    onClick={() => open(mode)}
                  >
                    {tr(
                      {
                        rename: "Rename",
                        move: "Move to",
                        tags: "Edit tags",
                        chat: "Use in chat",
                      }[mode],
                    )}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !filesOnly}
                  onClick={() => void run(() => transfer("drawing"))}
                >
                  {tr("Use in drawing")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !selected.length}
                  onClick={() => void execute({ op: "export", ids: selected })}
                >
                  {tr("Export")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !selected.length}
                  onClick={() =>
                    void run(async () => {
                      await resourceApi({ op: "trash", ids: selected });
                      setSelected([]);
                      setDetail(null);
                    })
                  }
                >
                  {tr("Move to trash")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!selected.length}
                  onClick={() => setSelected([])}
                >
                  {tr("Clear selection")}
                </Button>
              </div>
            </div>
            {busy ? (
              <div
                role="status"
                className="flex items-center justify-between bg-muted/40 px-4 py-2 text-sm"
              >
                <span>
                  {tr("Working...")} {progress}
                </span>
                {progress ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void resourceApi({ op: "cancelImport" })}
                  >
                    {tr("Cancel import")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {result ? (
              <div role="status" className="mx-4 mt-3 rounded-lg border border-border p-3 text-sm">
                <div className="flex justify-between">
                  <span>
                    {tr("Added")}: {result.added} · {tr("Skipped")}: {result.skipped} ·{" "}
                    {tr("Failed")}: {result.failed.length}
                    {result.cancelled ? ` · ${tr("Cancelled")}` : ""}
                  </span>
                  <button aria-label={tr("Close")} onClick={() => setResult(null)}>
                    <XIcon className="size-4" />
                  </button>
                </div>
                {result.failed.length ? (
                  <details>
                    <summary>{tr("Import errors")}</summary>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !result.failed.some((f) => f.path)}
                      onClick={() =>
                        void importFiles(result.failed.flatMap((f) => (f.path ? [f.path] : [])))
                      }
                    >
                      {tr("Retry failed imports")}
                    </Button>
                    {result.failed.map((f) => (
                      <p key={`${f.path ?? f.name}:${f.error}`}>
                        {f.name}: {tr(f.error)}
                      </p>
                    ))}
                  </details>
                ) : null}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="resource-scroll">
              {page.isPending ? (
                <p className="text-sm text-muted-foreground">{tr("Loading...")}</p>
              ) : !page.data?.entries.length ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {tr(
                    current
                      ? "Drop files here, import a folder, or collect resources from a chat."
                      : "Create a project to start collecting resources.",
                  )}
                </div>
              ) : (
                <div
                  data-testid="resource-entries"
                  className={
                    view === "grid"
                      ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
                      : "flex flex-col gap-1"
                  }
                >
                  {page.data.entries.map((entry) => (
                    <article
                      key={entry.id}
                      data-resource-entry-id={entry.id}
                      className={`group relative overflow-hidden rounded-xl border ${selected.includes(entry.id) ? "border-primary bg-primary/5" : "border-border bg-muted/10"} ${view === "list" ? "flex items-center" : ""}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected([entry.id]);
                        firstClick.current = null;
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${tr("Select")} ${entry.name}`}
                        className={
                          view === "grid" ? "absolute left-2 top-2 z-10 size-4" : "ml-3 size-4"
                        }
                        checked={selected.includes(entry.id)}
                        onChange={() => {
                          firstClick.current = null;
                          toggleSelection(entry.id);
                        }}
                      />
                      <button
                        className={
                          view === "grid"
                            ? "block w-full text-left"
                            : "flex min-w-0 flex-1 items-center text-left"
                        }
                        title={tr(
                          entry.kind === "file"
                            ? "Click to select, double-click for details"
                            : "Open folder",
                        )}
                        onClick={(event) => {
                          if (entry.kind === "directory") {
                            navigateFolder(entry.path);
                          } else if (event.detail <= 1) {
                            firstClick.current =
                              event.detail === 1 ? { id: entry.id, selected } : null;
                            toggleSelection(entry.id);
                          }
                        }}
                        onDoubleClick={(event) => {
                          if (entry.kind === "file") {
                            // A native double-click includes a first click that already toggled selection.
                            if (firstClick.current?.id === entry.id)
                              setSelected(firstClick.current.selected);
                            firstClick.current = null;
                            openDetails(entry, event.currentTarget);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (entry.kind === "file" && event.key === "Enter") {
                            event.preventDefault();
                            firstClick.current = null;
                            openDetails(entry, event.currentTarget);
                          }
                        }}
                      >
                        <span
                          className={
                            view === "grid"
                              ? "flex h-36 items-center justify-center bg-muted/20"
                              : "flex size-12 shrink-0 items-center justify-center"
                          }
                        >
                          <Preview entry={entry} />
                        </span>
                        <span className="block min-w-0 p-3">
                          <span className="block truncate text-sm font-medium" title={entry.name}>
                            {entry.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {entry.kind === "directory" ? tr("Folder") : humanBytes(entry.bytes)}
                            {entry.tags.length ? ` · ${entry.tags.join(", ")}` : ""}
                          </span>
                        </span>
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <footer className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
              <span>
                {page.data?.total ?? 0} {tr("resources")}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  {tr("Previous")}
                </Button>
                <span className="self-center">{Math.floor(offset / 100) + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset + 100 >= (page.data?.total ?? 0)}
                  onClick={() => setOffset(offset + 100)}
                >
                  {tr("Next")}
                </Button>
              </div>
            </footer>
          </main>
        </div>
      )}
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {tr(
                {
                  project: "New project",
                  folder: "New folder",
                  rename: "Rename",
                  move: "Move to",
                  tags: "Edit tags",
                  chat: "Use in chat",
                }[modal ?? "project"],
              )}
            </DialogTitle>
            <DialogDescription>
              {tr(
                modal === "chat"
                  ? "Add files to the draft without sending a message."
                  : "Organize files in your resource library.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-4">
            {modal === "move" || modal === "chat" ? (
              <select
                className={`${field} w-full`}
                aria-label={tr("Destination")}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {modal === "chat" ? (
                  <>
                    <option value="new">{tr("New chat")}</option>
                    {Object.values(threads)
                      .filter((t) => !t.archivedAt)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                  </>
                ) : (
                  <>
                    <option value="">{tr("Choose a project or folder.")}</option>
                    {dirs.map((d) => (
                      <option key={d.id} value={d.path}>
                        {d.path}
                      </option>
                    ))}
                  </>
                )}
              </select>
            ) : (
              <input
                className={`${field} w-full`}
                aria-label={tr("Name")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            )}
            {modal === "rename" && selected.length > 1 ? (
              <div className="text-xs text-muted-foreground">
                <p>{tr("Preview")}</p>
                {selectedEntries.slice(0, 8).map((e, i) => (
                  <p key={e.id}>
                    {value}-{String(i + 1).padStart(3, "0")}
                    {e.kind === "file" ? (/\.[^.]+$/u.exec(e.name)?.[0] ?? "") : ""}
                  </p>
                ))}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {tr(error)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setModal(null)}>
                {tr("Cancel")}
              </Button>
              <Button
                disabled={
                  busy ||
                  (modal === "move" || modal === "chat"
                    ? !destination
                    : modal !== "tags" && !value.trim())
                }
                onClick={() => void submitModal()}
              >
                {tr("Confirm")}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
      <ResourceDetailsDialog
        entry={detail}
        onClose={() => setDetail(null)}
        onUpdated={(entry) =>
          setDetail((previous) => (previous?.id === entry.id ? entry : previous))
        }
        returnFocus={detailTrigger}
      />
    </div>
  );
}
