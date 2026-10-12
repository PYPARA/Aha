import { cn } from "~/lib/utils";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
import {
  resourceType,
  type ResourceEntry,
  type ResourcePage,
  type ResourceQuery,
  type ResourceReadResult,
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
import { FolderIcon, FileIcon, SearchIcon, XIcon, PlusIcon } from "~/lib/icons";
import { useStore } from "~/store";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import {
  resourceApi,
  resourceKey,
  resourceFile,
  useResourceLibrary,
  useResourceTransfer,
} from "./resourceLibrary";
const field =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const humanBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
function Preview({ entry, large = false }: { entry: ResourceEntry; large?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: [...resourceKey, "preview", entry.id, entry.hash, large],
    queryFn: () => resourceApi<ResourceReadResult>({ op: "read", id: entry.id, thumbnail: !large }),
    enabled: entry.kind === "file" && resourceType(entry.name) === "image",
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!preview.data) return;
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(preview.data.bytes)], { type: preview.data.mimeType }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [preview.data]);
  return url ? (
    <img
      src={url}
      alt={entry.name}
      className={
        large ? "max-h-[65vh] max-w-full object-contain" : "h-full w-full object-contain p-2"
      }
      loading="lazy"
    />
  ) : entry.kind === "directory" ? (
    <FolderIcon className="size-10 text-muted-foreground" />
  ) : (
    <FileIcon className="size-9 text-muted-foreground" />
  );
}
export default function ResourceCenter({ headerClassName }: { headerClassName?: string } = {}) {
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
  const [fullPreview, setFullPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ResourceImportResult | null>(null);
  const [modal, setModal] = useState<
    "project" | "folder" | "rename" | "move" | "tags" | "chat" | null
  >(null);
  const [value, setValue] = useState("");
  const [destination, setDestination] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
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
    setOffset(0);
    setSelected([]);
  }, [current, query, tag, type, sort, scope]);
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
  }, [library.data?.libraryId]);
  const openDetails = (entry: ResourceEntry) => {
    setDetail(entry);
    setNotes(entry.notes);
    setTags(entry.tags.join(", "));
  };
  useEffect(() => {
    if (page.data)
      setDetail((previous) =>
        previous ? (page.data.entries.find((e) => e.id === previous.id) ?? null) : null,
      );
  }, [page.data]);
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
        setCurrent(created.path);
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
  const tree = (parent: string, depth = 0): React.ReactNode =>
    dirs
      .filter((d) => d.path.split("/").slice(0, -1).join("/") === parent)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((d) => (
        <div key={d.id}>
          <button
            className={`flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left text-sm hover:bg-muted ${current === d.path ? "bg-muted font-medium" : ""}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => {
              setCurrent(d.path);
              setDetail(null);
            }}
          >
            <FolderIcon className="size-4 shrink-0" />
            <span className="truncate">{d.name}</span>
          </button>
          {tree(d.path, depth + 1)}
        </div>
      ));
  if (!window.desktopBridge?.resourceLibrary)
    return <div className="p-8">{tr("Resource center is available in the desktop app.")}</div>;
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-testid="resource-center"
    >
      <header
        className={cn(
          "drag-region flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4",
          headerClassName,
        )}
      >
        <div>
          <h1 className="text-sm font-semibold">{tr("Resource center")}</h1>
          <p className="text-xs text-muted-foreground">
            {tr("Collect, organize and reuse your creative files.")}
          </p>
        </div>
        <div className="flex gap-2 [-webkit-app-region:no-drag]">
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
          className="whitespace-pre-wrap border-b border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {tr(error ?? library.data?.error ?? library.error?.message ?? page.error?.message ?? "")}
        </div>
      ) : null}
      {!library.data?.root ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <FolderIcon className="size-12 text-muted-foreground" />
          <h2 className="text-lg font-medium">{tr("A home for your creative resources")}</h2>
          <p className="max-w-lg text-sm text-muted-foreground">
            {tr(
              "Choose one folder for your library. Projects become real folders, and your files remain available in Finder.",
            )}
          </p>
          <Button disabled={busy} onClick={() => void execute({ op: "chooseRoot" })}>
            {tr("Choose resource folder")}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-52 shrink-0 overflow-y-auto border-r border-border p-3">
            <Button
              className="mb-3 w-full justify-start"
              variant="outline"
              disabled={busy}
              onClick={() => open("project")}
            >
              <PlusIcon className="size-4" />
              {tr("New project")}
            </Button>
            <button
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${!current ? "bg-muted font-medium" : "hover:bg-muted"}`}
              onClick={() => {
                setCurrent("");
                setDetail(null);
              }}
            >
              {tr("All projects")}
            </button>
            {tree("")}
            <button
              className="mt-4 w-full break-all px-2 text-left text-xs text-muted-foreground"
              title={library.data.root}
              onClick={() => void execute({ op: "reveal" })}
            >
              {library.data.root}
            </button>
          </aside>
          <main
            className="flex min-w-0 flex-1 flex-col"
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
            <div className="space-y-3 border-b border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCurrent("")}>
                  {tr("All projects")}
                </Button>
                {breadcrumbs.map((crumb) => (
                  <Button
                    key={crumb.path}
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrent(crumb.path)}
                  >
                    / {crumb.label}
                  </Button>
                ))}
                <div className="ml-auto flex gap-2">
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
              {selected.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    {selected.length} {tr("selected")}
                  </span>
                  {(["rename", "move", "tags", "chat"] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="sm"
                      variant="outline"
                      disabled={busy || (mode === "chat" && !filesOnly)}
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
                    disabled={busy}
                    onClick={() => void execute({ op: "export", ids: selected })}
                  >
                    {tr("Export")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
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
                  <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                    {tr("Clear selection")}
                  </Button>
                </div>
              ) : null}
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
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                  className={
                    view === "grid"
                      ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
                      : "flex flex-col gap-1"
                  }
                >
                  {page.data.entries.map((entry) => (
                    <article
                      key={entry.id}
                      className={`group relative overflow-hidden rounded-xl border ${selected.includes(entry.id) ? "border-primary bg-primary/5" : "border-border bg-muted/10"} ${view === "list" ? "flex items-center" : ""}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected([entry.id]);
                        openDetails(entry);
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${tr("Select")} ${entry.name}`}
                        className={
                          view === "grid" ? "absolute left-2 top-2 z-10 size-4" : "ml-3 size-4"
                        }
                        checked={selected.includes(entry.id)}
                        onChange={(e) =>
                          setSelected((old) =>
                            e.target.checked
                              ? [...old, entry.id]
                              : old.filter((id) => id !== entry.id),
                          )
                        }
                      />
                      <button
                        className={
                          view === "grid"
                            ? "block w-full text-left"
                            : "flex min-w-0 flex-1 items-center text-left"
                        }
                        onClick={() => {
                          if (entry.kind === "directory") {
                            setCurrent(entry.path);
                            setDetail(null);
                          } else openDetails(entry);
                        }}
                        onDoubleClick={() => {
                          if (entry.kind === "file" && resourceType(entry.name) === "image") {
                            openDetails(entry);
                            setFullPreview(true);
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
            <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
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
          {detail ? (
            <aside className="w-72 shrink-0 space-y-4 overflow-y-auto border-l border-border p-4">
              <div className="flex justify-between gap-2">
                <h2 className="break-all text-sm font-semibold">{detail.name}</h2>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={tr("Close")}
                  onClick={() => setDetail(null)}
                >
                  <XIcon />
                </Button>
              </div>
              <button
                className="flex h-48 w-full items-center justify-center rounded-lg bg-muted/30"
                onClick={() => setFullPreview(true)}
                disabled={detail.kind !== "file" || resourceType(detail.name) !== "image"}
              >
                <Preview entry={detail} />
              </button>
              <p className="break-all text-xs text-muted-foreground">
                {detail.path}
                <br />
                {humanBytes(detail.bytes)} · {new Date(detail.modifiedAt).toLocaleString()}
              </p>
              <label className="block space-y-1 text-sm">
                {tr("Tags")}
                <input
                  className={`${field} w-full`}
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder={tr("Separate tags with commas")}
                />
              </label>
              <label className="block space-y-1 text-sm">
                {tr("Notes")}
                <textarea
                  className={`${field} min-h-24 w-full`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await resourceApi({
                      op: "metadata",
                      ids: [detail.id],
                      tags: tags.split(","),
                      notes,
                    });
                    setDetail({
                      ...detail,
                      tags: tags
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                      notes,
                    });
                  })
                }
              >
                {tr("Save")}
              </Button>
              {detail.origin ? (
                <div className="space-y-2 text-xs">
                  <h3 className="font-medium">{tr("Source")}</h3>
                  <p>{tr(detail.origin.kind)}</p>
                  {detail.origin.threadId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!threads[detail.origin.threadId]}
                      onClick={() =>
                        void navigate({
                          to: "/$threadId",
                          params: { threadId: detail.origin!.threadId! as ThreadId },
                        })
                      }
                    >
                      {tr(
                        threads[detail.origin.threadId]
                          ? "Open source chat"
                          : "Source is unavailable",
                      )}
                    </Button>
                  ) : null}
                  {detail.origin.prompt ? (
                    <p className="whitespace-pre-wrap">{detail.origin.prompt}</p>
                  ) : null}
                  {detail.origin.model ? <p>{detail.origin.model}</p> : null}
                  {detail.origin.parameters ? (
                    <pre className="overflow-auto rounded bg-muted p-2">
                      {JSON.stringify(detail.origin.parameters, null, 2)}
                    </pre>
                  ) : null}
                </div>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void execute({ op: "reveal", id: detail.id })}
              >
                {tr("Show in folder")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void execute({ op: "export", ids: [detail.id] })}
              >
                {tr("Export")}
              </Button>
            </aside>
          ) : null}
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
      <Dialog open={fullPreview && !!detail} onOpenChange={setFullPreview}>
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>{tr("Image preview")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-center p-4">
            {detail ? <Preview entry={detail} large /> : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
