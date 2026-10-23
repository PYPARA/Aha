import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  drawingResourceError,
  type ResourceBatchAction,
  type ResourceBatchPlan,
  type ResourceBatchResult,
  type ResourceEntry,
  type ResourceImportResult,
  type ResourcePage,
  type ResourceQuery,
  type ResourceSnapshot,
  type ResourceLocateResult,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useStore } from "~/store";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { FolderIcon, PlusIcon, EllipsisIcon, PanelLeftIcon, XIcon } from "~/lib/icons";
import {
  resourceApi,
  resourceKey,
  resourceFile,
  ResourceLibraryIdContext,
  useResourceLibrary,
  useResourceTransfer,
  retryResourceTransfer,
  useResourceTaskResults,
  recordResourceTask,
} from "./resourceLibrary";
import { Sheet, SheetPopup, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { ResourceIndexStatus } from "./ResourceIndexStatus";
import { ResourceSidebar } from "./ResourceSidebar";
import { ResourceAssetBrowser, type ResourceItemAction } from "./ResourceAssetBrowser";
import {
  navigateToTransferTarget,
  sendFilesToTarget,
  TransferTargetDialog,
  type TransferModule,
} from "./transferTargets";
import { ResourceDetailsDialog } from "./ResourceDetailsDialog";
import { ResourceInspector } from "./ResourceInspector";
import { ResourceOperationDialog, type ResourceOperation } from "./ResourceOperationDialog";
import { ResourceToolbar, ResourceActionMenu } from "./ResourceToolbar";
import { ResourceSelectionBar } from "./ResourceSelectionBar";
import {
  emptyResourceSelection,
  reconcileResourceSelection,
  type ResourceSelection,
} from "./resourceSelection";
import {
  directoryLocation,
  expandedResourceAncestors,
  readResourcePreferences,
  resolveResourceLocation,
  resourceQuery,
  type ResourceLocation,
} from "./resourceNavigation";
import { useResourceDraft } from "./useResourceDraft";

const EMPTY_ENTRIES: ResourceEntry[] = [];
export default function ResourceCenter() {
  const tr = useAhaTranslation();
  const library = useResourceLibrary();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!window.desktopBridge?.resourceLibrary)
    return (
      <div className="p-8 text-ui">{tr("Resource center is available in the desktop app.")}</div>
    );
  if (library.isPending || (library.data?.scan?.phase === "loading" && !library.data?.libraryId))
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center p-8 text-ui text-muted-foreground"
      >
        {tr("Loading...")}
      </div>
    );
  if (!library.data?.root || !library.data.libraryId)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-8 text-center text-ui">
        <FolderIcon className="size-10 text-muted-foreground" />
        <h1 className="text-ui-xl font-medium">{tr("Resource center")}</h1>
        <p className="max-w-md text-muted-foreground">
          {tr(
            "Choose one folder for your library. Projects become real folders, and your files remain available in Finder.",
          )}
        </p>
        {error || library.error || library.data?.error ? (
          <p role="alert" className="text-destructive">
            {tr(error ?? library.error?.message ?? library.data?.error ?? "")}
          </p>
        ) : null}
        <Button
          disabled={busy || library.isPending}
          onClick={() => {
            setBusy(true);
            setError(null);
            void resourceApi({ op: "chooseRoot" })
              .then(() => client.invalidateQueries({ queryKey: resourceKey }))
              .catch((cause) => setError(String(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {tr(library.isPending ? "Loading..." : "Choose resource folder")}
        </Button>
      </div>
    );
  return (
    <ResourceLibraryIdContext.Provider value={library.data.libraryId}>
      <ResourceWorkspace key={library.data.libraryId} snapshot={library.data} />
    </ResourceLibraryIdContext.Provider>
  );
}
function ResourceWorkspace({ snapshot }: { snapshot: ResourceSnapshot }) {
  const tr = useAhaTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const threads = useStore((state) => state.sidebarThreadSummaryById);
  const [preferences, setPreferences] = useState(() =>
    readResourcePreferences(snapshot.libraryId!, snapshot.directories),
  );
  const location = preferences.location;
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [type, setType] = useState<ResourceQuery["type"]>("all");
  const [originKind, setOriginKind] = useState<ResourceQuery["originKind"]>();
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState(emptyResourceSelection);
  const [multiple, setMultiple] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const [pendingLocate, setPendingLocate] = useState<ResourceLocateResult | null>(null);
  const restoreScroll = useRef<number | null>(null);
  const [historyIndex, setHistoryIndex] = useState(0);
  const history = useRef<
    {
      location: ResourceLocation;
      query: string;
      tag: string;
      type: ResourceQuery["type"];
      originKind: ResourceQuery["originKind"];
      sort: "name" | "modified";
      offset: number;
      scroll: number;
    }[]
  >([]);
  const [metrics, setMetrics] = useState({ width: 1024, rem: 16, fontScale: 1 });
  const [preview, setPreview] = useState<ResourceEntry | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [operation, setOperation] = useState<ResourceOperation | null>(null);
  const [transferModule, setTransferModule] = useState<TransferModule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const externalLocate = useRef(false);
  useEffect(() => {
    if (externalLocate.current) return;
    externalLocate.current = true;
    const raw = sessionStorage.getItem("aha:resource-locate");
    if (!raw) return;
    sessionStorage.removeItem("aha:resource-locate");
    void (async () => {
      const target = JSON.parse(raw) as { libraryId: string; resourceId: string };
      if (target.libraryId !== snapshot.libraryId)
        throw new Error(
          tr("The result belongs to another library. Open that library to locate it."),
        );
      const located = await resourceApi<ResourceLocateResult>({
        op: "locate",
        id: target.resourceId,
        sort: preferences.sort,
      });
      setPreferences((previous) => ({
        ...previous,
        location: {
          ...directoryLocation(located.parentPath, snapshot.directories),
          directoryId: located.parentId,
        },
      }));
      setQuery("");
      setTag("");
      setType("all");
      setOriginKind(undefined);
      setOffset(located.offset);
      setPendingLocate(located);
      setInspector(true);
    })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [snapshot.libraryId, snapshot.directories, preferences.sort, tr]);
  const [progress, setProgress] = useState("");
  const tasks = useResourceTaskResults((state) => state.byLibrary[snapshot.libraryId!]);
  const importResult = tasks?.import ?? null;
  const batchResult = tasks?.batch ?? null;
  const setImportResult = (result: typeof importResult) =>
    recordResourceTask(snapshot.libraryId!, { import: result });
  const setBatchResult = (result: typeof batchResult) =>
    recordResourceTask(snapshot.libraryId!, { batch: result });
  const transfer = useResourceTransfer((state) => state.lastResult);
  const filters = {
    ...resourceQuery(location, query, tag, type, preferences.sort, offset),
    ...(originKind ? { originKind } : {}),
  };
  const page = useQuery({
    queryKey: [...resourceKey, "list", snapshot.libraryId, filters],
    queryFn: () => resourceApi<ResourcePage>({ op: "list", query: filters }),
    enabled: !!snapshot.libraryId,
  });
  const coherent =
    snapshot.revision === undefined ||
    page.data?.revision === undefined ||
    snapshot.revision === page.data.revision;
  const entries = coherent ? (page.data?.entries ?? EMPTY_ENTRIES) : EMPTY_ENTRIES;
  const pageData = coherent ? page.data : undefined;
  const writeBlocked = !!snapshot.error || (!!snapshot.scan && snapshot.scan.phase !== "ready");
  const selectedEntries = entries.filter((entry) => selection.ids.includes(entry.id));
  const refresh = useCallback(
    () =>
      client.invalidateQueries({
        queryKey: resourceKey,
        predicate: (item) => item.queryKey[1] !== "preview",
      }),
    [client],
  );
  useEffect(() => {
    if (!coherent && !page.isFetching) void refresh();
  }, [coherent, page.isFetching, refresh]);
  const editor = useResourceDraft(
    inspector && selectedEntries.length === 1 ? selectedEntries[0]! : null,
    refresh,
  );
  const guardDraft = editor.guard;
  const navigationWidth = preferences.sidebarRem * metrics.rem;
  const contentMinimum = 28 * metrics.rem * Math.max(1, metrics.fontScale);
  const narrow = metrics.width - navigationWidth < contentMinimum;
  const sidebarVisible = !narrow || sidebarOpen;
  const inspectorOverlay =
    metrics.width - (!narrow ? navigationWidth : 0) < contentMinimum + 20 * metrics.rem;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const next = {
        width: element.clientWidth,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        fontScale:
          (parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--app-font-size-ui"),
          ) || 13) / 13,
      };
      setMetrics((previous) =>
        previous.width === next.width &&
        previous.rem === next.rem &&
        previous.fontScale === next.fontScale
          ? previous
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(document.documentElement);
    const typography = new MutationObserver(update);
    typography.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => {
      observer.disconnect();
      typography.disconnect();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`aha:resources:${snapshot.libraryId}`, JSON.stringify(preferences));
    } catch {
      /* Storage is optional. */
    }
  }, [snapshot.libraryId, preferences]);
  useEffect(
    () =>
      window.desktopBridge?.resourceLibrary?.onProgress((value) =>
        setProgress(`${value.completed} · ${value.name}`),
      ),
    [],
  );
  useEffect(() => {
    // A mutation can finish its refetch before React commits the parent's new props.
    const cached = client.getQueryData<ResourceSnapshot>([...resourceKey, "snapshot"]);
    const latest = cached?.libraryId === snapshot.libraryId ? cached : snapshot;
    if (latest.scan && latest.scan.phase !== "ready") return;
    if (latest.error) return;
    const resolved = resolveResourceLocation(location, latest.directories);
    if (
      resolved.mode !== location.mode ||
      resolved.path !== location.path ||
      resolved.directoryId !== location.directoryId
    ) {
      if (
        (location.directoryId && resolved.directoryId === location.directoryId) ||
        resolved.path === location.path
      ) {
        setPreferences((previous) => ({ ...previous, location: resolved }));
        return;
      }
      guardDraft(() => {
        setPreferences((previous) => ({ ...previous, location: resolved }));
        setSelection(emptyResourceSelection());
        setPreview(null);
        setMultiple(false);
        setOffset(0);
        setQuery("");
        setTag("");
        setType("all");
        setNotice(
          tr("The previous folder is unavailable. Showing its nearest available location."),
        );
      });
    }
  }, [snapshot, client, location, tr, guardDraft]);
  useEffect(() => {
    if (!pageData || page.isFetching) return;
    setSelection((previous) =>
      reconcileResourceSelection(
        previous,
        pageData.entries.map((entry) => entry.id),
      ),
    );
    if (!pageData.entries.length && offset > 0) {
      setOffset(Math.max(0, Math.floor(Math.max(0, pageData.total - 1) / 100) * 100));
      setSelection(emptyResourceSelection());
    }
    setPreview((previous) =>
      previous ? (pageData.entries.find((entry) => entry.id === previous.id) ?? null) : null,
    );
  }, [pageData, page.isFetching, offset]);
  useEffect(() => {
    if (location.mode !== "directory") return;
    const ancestors = expandedResourceAncestors(location.path, snapshot.directories);
    setPreferences((previous) =>
      ancestors.every((id) => previous.expandedIds.includes(id))
        ? previous
        : { ...previous, expandedIds: [...new Set([...previous.expandedIds, ...ancestors])] },
    );
  }, [location.path, location.mode, snapshot.directories]);
  useEffect(() => {
    if (!pageData || page.isFetching || offset !== (pendingLocate?.offset ?? offset)) return;
    if (pendingLocate) {
      if (pageData.revision !== undefined && pageData.revision !== pendingLocate.revision) {
        setPendingLocate(null);
        setNotice(tr("The resource changed while locating it. Try again."));
        return;
      }
      const entry = entries.find((e) => e.id === pendingLocate.entry.id);
      if (!entry) {
        setPendingLocate(null);
        setNotice(tr("Resource no longer exists. Refresh the library."));
        return;
      }
      setSelection((previous) =>
        previous.ids.length === 1 &&
        previous.ids[0] === entry.id &&
        previous.anchorId === entry.id &&
        previous.focusedId === entry.id
          ? previous
          : { ids: [entry.id], anchorId: entry.id, focusedId: entry.id },
      );
      const frame = requestAnimationFrame(() => {
        const button = scroller.current?.querySelector<HTMLElement>(
          `[data-resource-button="${CSS.escape(entry.id)}"]`,
        );
        button?.scrollIntoView({ block: "center" });
        button?.focus({ preventScroll: true });
        setPendingLocate(null);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (restoreScroll.current !== null && scroller.current) {
      scroller.current.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  }, [pageData, page.isFetching, offset, pendingLocate, entries, tr, preferences.view]);
  const resetSelection = () => {
    setSelection(emptyResourceSelection());
    setPreview(null);
    setOffset(0);
    if (selection.ids.length)
      setNotice(tr("Selection cleared because the browsing range changed."));
  };
  const changeRange = (action: () => void) =>
    editor.guard(() => {
      resetSelection();
      action();
      scroller.current?.scrollTo({ top: 0 });
    });
  const captureBrowse = () => ({
    location,
    query,
    tag,
    type,
    originKind,
    sort: preferences.sort,
    offset,
    scroll: scroller.current?.scrollTop ?? 0,
  });
  const pushHistory = (next: ResourceLocation, nextOffset = 0) => {
    history.current[historyIndex] = captureBrowse();
    history.current = history.current.slice(0, historyIndex + 1);
    history.current.push({
      location: next,
      query: "",
      tag: "",
      type: "all",
      originKind: undefined,
      sort: preferences.sort,
      offset: nextOffset,
      scroll: 0,
    });
    setHistoryIndex(historyIndex + 1);
  };
  const navigateLocation = (next: ResourceLocation) =>
    changeRange(() => {
      const cached = client.getQueryData<ResourceSnapshot>([...resourceKey, "snapshot"]);
      const directories =
        cached?.libraryId === snapshot.libraryId ? cached.directories : snapshot.directories;
      const resolved =
        next.mode === "directory"
          ? {
              ...directoryLocation(next.path, directories),
              ...(next.directoryId !== undefined ? { directoryId: next.directoryId } : {}),
              recursive: next.recursive,
            }
          : next;
      pushHistory(resolved);
      setPreferences((previous) => ({ ...previous, location: resolved }));
      setQuery("");
      setTag("");
      setType("all");
      setMultiple(false);
      setSidebarOpen(false);
      setOriginKind(undefined);
      setPendingLocate(null);
    });
  const traverseHistory = (direction: -1 | 1) =>
    editor.guard(() => {
      const target = historyIndex + direction,
        item = history.current[target];
      if (!item) return;
      history.current[historyIndex] = captureBrowse();
      const resolved = resolveResourceLocation(item.location, snapshot.directories);
      setHistoryIndex(target);
      setPreferences((previous) => ({ ...previous, location: resolved, sort: item.sort }));
      setQuery(item.query);
      setTag(item.tag);
      setType(item.type);
      setOriginKind(item.originKind);
      setOffset(item.offset);
      setSelection(emptyResourceSelection());
      setPreview(null);
      setMultiple(false);
      setPendingLocate(null);
      restoreScroll.current = item.scroll;
    });
  const locateResource = (entry: ResourceEntry) =>
    editor.guard(() => {
      void run(async () => {
        const located = await resourceApi<ResourceLocateResult>({
          op: "locate",
          id: entry.id,
          sort: preferences.sort,
        });
        await refresh();
        const next = {
          ...directoryLocation(located.parentPath, snapshot.directories),
          directoryId: located.parentId,
        };
        pushHistory(next, located.offset);
        setPreferences((previous) => ({ ...previous, location: next }));
        setQuery("");
        setTag("");
        setType("all");
        setMultiple(false);
        setOriginKind(undefined);
        setSelection(emptyResourceSelection());
        setPreview(null);
        setOffset(located.offset);
        setPendingLocate(located);
      });
    });
  const changeSelection = (next: ResourceSelection, afterChange?: () => void) => {
    const apply = () => {
      setSelection(next);
      afterChange?.();
    };
    if (next.ids.join("\0") !== selection.ids.join("\0")) editor.guard(apply);
    else apply();
  };
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    } finally {
      setBusy(false);
      setProgress("");
      await refresh();
    }
  };
  const openResource = (entry: ResourceEntry, trigger: HTMLElement) => {
    if (entry.kind === "directory") {
      navigateLocation({ mode: "directory", path: entry.path, recursive: false });
      return;
    }
    editor.guard(() => {
      if (!multiple) setSelection({ ids: [entry.id], focusedId: entry.id, anchorId: entry.id });
      previewTrigger.current = trigger;
      setPreview(entry);
    });
  };
  const applyBatchResult = (result: ResourceBatchResult, plan: ResourceBatchPlan) => {
    setBatchResult({ result, plan });
    if (result.items.every((item) => item.status === "cancelled")) return;
    const failures = result.items.filter((item) => item.status === "failed");
    const remaining = new Set(
      result.items
        .filter((item) => item.status === "failed" || item.status === "cancelled")
        .map((item) => item.id),
    );
    setSelection((previous) => ({
      ...previous,
      ids: previous.ids.filter((id) => remaining.has(id)),
    }));
    const summary = `${tr("Completed")}: ${result.items.filter((item) => item.status === "succeeded").length} · ${tr("Failed")}: ${failures.length}`;
    setNotice(summary);
    toastManager.add({
      type: failures.length || result.items.some((item) => item.error) ? "error" : "success",
      title: summary,
    });
  };
  const prepareAction = (action: ResourceBatchAction, targets = selectedEntries) =>
    editor.guard(() => {
      void run(async () => {
        const plan = await resourceApi<ResourceBatchPlan | null>({
          op: "prepareBatch",
          action,
          ids: targets.map((entry) => entry.id),
        });
        if (!plan) return;
        if (action === "export")
          setOperation({ kind: "export", entries: targets, target: "", plan });
        else {
          const result = await resourceApi<ResourceBatchResult>({
            op: "executeBatch",
            planId: plan.id,
          });
          applyBatchResult(result, plan);
        }
      });
    });
  const showOperation = (kind: ResourceOperation["kind"], targets = selectedEntries) =>
    editor.guard(() =>
      setOperation({
        kind,
        entries: targets,
        target: location.mode === "directory" ? location.path : null,
      }),
    );
  const recordImport = (
    result: ResourceImportResult,
    input: { target: string; importDirectories?: boolean | undefined },
  ) => {
    setImportResult({ result, operation: input });
    const summary = `${tr("Added")}: ${result.added} · ${tr("Skipped")}: ${result.skipped} · ${tr("Failed")}: ${result.failed.length}`;
    setNotice(summary);
    if (!result.cancelled || result.added || result.failed.length)
      toastManager.add({ type: result.failed.length ? "error" : "success", title: summary });
  };
  const requestImport = (directories: boolean, paths?: string[]) =>
    editor.guard(() => {
      const input: ResourceOperation = {
        kind: "import",
        entries: [],
        target: location.mode === "directory" ? location.path : null,
        importDirectories: directories,
        ...(paths ? { paths } : {}),
      };
      if (location.mode !== "directory") {
        setOperation(input);
        return;
      }
      void run(async () =>
        recordImport(
          await resourceApi<ResourceImportResult>({
            op: "importPaths",
            target: location.path,
            directories,
            ...(paths ? { paths } : {}),
          }),
          { ...input, target: input.target! },
        ),
      );
    });
  const sendResources = async (target: string, resources: ResourceEntry[]) => {
    if (!resources.length || resources.some((entry) => entry.kind !== "file"))
      throw new Error(tr("Choose files only for this action."));
    const files: File[] = [];
    for (const entry of resources) {
      const file = await resourceFile(entry.id);
      if (target === "drawing" || target.startsWith("image-batch:")) {
        const reason = drawingResourceError(file, {
          count: files.length,
          bytes: files.reduce((total, item) => total + item.size, 0),
        });
        if (reason) throw new Error(tr(reason));
      }
      files.push(file);
    }
    let destination = target;
    if (destination === "new") {
      const created = await handleNewChat({ fresh: true });
      if (!created.ok) throw new Error(created.error);
      if (!created.threadId) throw new Error(tr("Unable to prepare a new chat."));
      destination = created.threadId;
    }
    await sendFilesToTarget(navigate, destination, files, {
      origin: { resourceIds: resources.map((entry) => entry.id), libraryId: snapshot.libraryId! },
      newBatchName: tr("Untitled batch"),
    });
  };
  const filesOnly =
    selectedEntries.length > 0 && selectedEntries.every((entry) => entry.kind === "file");
  const actions: ResourceItemAction[] = [
    {
      key: "preview",
      label: tr("Preview"),
      disabled: selectedEntries.length !== 1,
      run: () => {
        const entry = selectedEntries[0];
        if (entry) openResource(entry, scroller.current!);
      },
    },
    {
      key: "rename",
      label: tr("Rename"),
      disabled: writeBlocked || !selectedEntries.length,
      run: () => showOperation("rename"),
    },
    {
      key: "move",
      label: tr("Move to"),
      disabled: writeBlocked || !selectedEntries.length,
      run: () => showOperation("move"),
    },
    {
      key: "tags",
      label: tr("Edit tags"),
      disabled: writeBlocked || !selectedEntries.length,
      run: () => showOperation("tags"),
    },
    {
      key: "chat",
      label: tr("Use in chat"),
      disabled: !filesOnly,
      run: () => showOperation("chat"),
    },
    {
      key: "drawing",
      label: tr("Use in drawing"),
      disabled: !filesOnly,
      run: () =>
        editor.guard(() => {
          void run(() => sendResources("drawing", selectedEntries));
        }),
    },
    {
      key: "sprite",
      label: tr("Use in sprite"),
      disabled: !filesOnly,
      run: () => editor.guard(() => setTransferModule("sprite")),
    },
    {
      key: "image-batch",
      label: tr("Use in batch"),
      disabled: !filesOnly,
      run: () => editor.guard(() => setTransferModule("image-batch")),
    },
    {
      key: "export",
      label: tr("Export"),
      disabled: writeBlocked || !selectedEntries.length,
      run: () => prepareAction("export"),
    },
    {
      key: "reveal",
      label: tr("Show in folder"),
      disabled: selectedEntries.length !== 1,
      run: () => {
        void run(() => resourceApi({ op: "reveal", id: selectedEntries[0]!.id }));
      },
    },
    {
      key: "trash",
      label: tr("Move to trash"),
      disabled: writeBlocked || !selectedEntries.length,
      run: () => prepareAction("trash"),
    },
  ];
  actions.push({
    key: "locate",
    label: tr("Locate folder"),
    disabled: selectedEntries.length !== 1 || selectedEntries[0]?.kind !== "file",
    run: () => {
      if (selectedEntries[0]) locateResource(selectedEntries[0]);
    },
  });
  const renderSidebar = (overlay: boolean) => (
    <ResourceSidebar
      snapshot={snapshot}
      location={location}
      expandedIds={preferences.expandedIds}
      onExpandedChange={(expandedIds) =>
        setPreferences((previous) => ({ ...previous, expandedIds }))
      }
      busy={busy || writeBlocked}
      onNavigate={navigateLocation}
      onNewProject={() => showOperation("project", [])}
      onManage={(entry, action) => {
        if (action === "folder")
          editor.guard(() =>
            setOperation({ kind: "folder", entries: [], target: entry?.path ?? "" }),
          );
        else if (action === "trash" && entry) prepareAction("trash", [entry]);
        else if (action === "reveal")
          void run(() => resourceApi({ op: "reveal", ...(entry ? { id: entry.id } : {}) }));
        else if (entry) showOperation(action === "move" ? "move" : "rename", [entry]);
      }}
      width={navigationWidth}
      rem={metrics.rem}
      onWidthChange={(value) =>
        setPreferences((previous) => ({
          ...previous,
          sidebarRem: Math.max(12, Math.min(20, value / metrics.rem)),
        }))
      }
      overlay={overlay}
      onShowIndex={() => setIndexOpen(true)}
    />
  );
  const title =
    location.mode === "all"
      ? tr("All resources")
      : location.mode === "recent"
        ? tr("Recently modified")
        : location.path.split("/").at(-1) || tr("Library root");
  return (
    <div
      ref={root}
      className="@container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="resource-center"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {narrow ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("Show resource navigation")}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((previous) => !previous)}
          >
            <PanelLeftIcon />
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 text-ui font-medium">{tr("Resource center")}</h1>
        <ResourceActionMenu
          label={tr("Import")}
          icon={<PlusIcon />}
          disabled={busy || writeBlocked}
        >
          <MenuItem onClick={() => requestImport(false)}>{tr("Import files")}</MenuItem>
          <MenuItem onClick={() => requestImport(true)}>{tr("Import folder")}</MenuItem>
        </ResourceActionMenu>
        <ResourceActionMenu label={tr("Library")} icon={<EllipsisIcon />} disabled={busy}>
          <MenuItem disabled={writeBlocked} onClick={() => showOperation("project", [])}>
            {tr("New project")}
          </MenuItem>
          <MenuItem onClick={() => void refresh()}>{tr("Refresh list")}</MenuItem>
          <MenuItem onClick={() => setIndexOpen(true)}>{tr("Index status")}</MenuItem>
          <MenuItem
            disabled={snapshot.scan?.phase === "loading" || snapshot.scan?.phase === "scanning"}
            onClick={() =>
              editor.guard(() => {
                void run(async () => {
                  await resourceApi({ op: "refresh" });
                  await client.resetQueries({ queryKey: [...resourceKey, "preview"] });
                });
              })
            }
          >
            {tr("Rescan library")}
          </MenuItem>
          <MenuItem
            onClick={() =>
              editor.guard(() => {
                void run(() => resourceApi({ op: "chooseRoot" }));
              })
            }
          >
            {tr("Switch library")}
          </MenuItem>
        </ResourceActionMenu>
      </header>
      {snapshot.scan && snapshot.scan.phase !== "ready" ? (
        <div role="status" className="border-b bg-muted/50 px-4 py-2 text-ui-sm">
          {tr(
            snapshot.scan.phase === "failed"
              ? "Results may be incomplete"
              : "Scanning; counts may change",
          )}
        </div>
      ) : null}
      {error || snapshot.error || page.error ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/5 p-3 text-ui-sm text-destructive"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {tr(error ?? snapshot.error ?? page.error?.message ?? "")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void run(() => resourceApi({ op: "refresh" }));
            }}
          >
            {tr("Retry")}
          </Button>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {sidebarVisible ? (
          narrow ? (
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetPopup
                side="left"
                className="max-w-[20rem]"
                showCloseButton={false}
                finalFocus={() =>
                  root.current?.querySelector<HTMLButtonElement>(
                    '[aria-label="' + tr("Show resource navigation") + '"]',
                  ) ?? undefined
                }
              >
                <SheetHeader className="flex-row items-center justify-between p-3">
                  <SheetTitle className="text-ui-lg">{tr("Projects and folders")}</SheetTitle>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr("Close navigation")}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <XIcon />
                  </Button>
                </SheetHeader>
                {renderSidebar(true)}
              </SheetPopup>
            </Sheet>
          ) : (
            renderSidebar(false)
          )
        ) : null}
        <main
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (busy || writeBlocked) return;
            const paths = Array.from(event.dataTransfer.files).flatMap((file) => {
              const path = window.desktopBridge?.getPathForFile?.(file);
              return path ? [path] : [];
            });
            if (paths.length) requestImport(false, paths);
          }}
        >
          <ResourceToolbar
            location={location}
            title={title}
            query={query}
            tag={tag}
            type={type}
            originKind={originKind}
            onOriginKind={(value) => changeRange(() => setOriginKind(value))}
            sort={preferences.sort}
            view={preferences.view}
            multiple={multiple}
            inspector={inspector}
            busy={busy || writeBlocked}
            page={pageData}
            onHistory={traverseHistory}
            canBack={historyIndex > 0}
            canForward={historyIndex < history.current.length - 1}
            onClearFilters={() =>
              changeRange(() => {
                setQuery("");
                setTag("");
                setType("all");
                setOriginKind(undefined);
              })
            }
            onNavigate={navigateLocation}
            onToggleMultiple={() => setMultiple((previous) => !previous)}
            onToggleInspector={() => editor.guard(() => setInspector((previous) => !previous))}
            onCreateFolder={() => showOperation("folder", [])}
            onQuery={(value) => changeRange(() => setQuery(value))}
            onTag={(value) => changeRange(() => setTag(value))}
            onType={(value) => changeRange(() => setType(value))}
            onSort={(sort) =>
              changeRange(() => setPreferences((previous) => ({ ...previous, sort })))
            }
            onRecursive={(recursive) =>
              changeRange(() =>
                setPreferences((previous) => ({
                  ...previous,
                  location: { ...previous.location, recursive },
                })),
              )
            }
            onToggleView={() => {
              restoreScroll.current = scroller.current?.scrollTop ?? 0;
              setPreferences((previous) => ({
                ...previous,
                view: previous.view === "grid" ? "list" : "grid",
              }));
            }}
          />
          {busy ? (
            <div
              role="status"
              className="flex shrink-0 items-center gap-2 bg-muted/50 px-4 py-2 text-ui-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {tr("Working...")} {progress}
              </span>
              {progress ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void resourceApi({ op: "cancelImport" })}
                >
                  {tr("Cancel import")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {batchResult ? (
            <details className="mx-4 mt-2 shrink-0 rounded-lg border border-border text-ui-sm">
              <summary className="px-3 py-2">
                {tr("Operation results")} · {tr("Completed")}:{" "}
                {batchResult.result.items.filter((item) => item.status === "succeeded").length} ·{" "}
                {tr("Failed")}:{" "}
                {batchResult.result.items.filter((item) => item.status === "failed").length}
              </summary>
              <div className="max-h-40 space-y-2 overflow-auto border-t p-3">
                {batchResult.result.items.map((item) => (
                  <p
                    key={item.id}
                    className={`break-all ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {item.source} → {item.target ?? ""} · {tr(item.status)}
                    {item.error ? ` · ${tr(item.error)}` : ""}
                  </p>
                ))}
                <div className="flex gap-2">
                  {batchResult.result.items.some((item) => item.status === "failed") ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void run(async () =>
                          applyBatchResult(
                            await resourceApi<ResourceBatchResult>({
                              op: "executeBatch",
                              planId: batchResult.plan.id,
                              retryFailed: true,
                            }),
                            batchResult.plan,
                          ),
                        );
                      }}
                    >
                      {tr("Retry failed items")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setBatchResult(null)}>
                    {tr("Close")}
                  </Button>
                </div>
              </div>
            </details>
          ) : null}
          {importResult ? (
            <details className="mx-4 mt-2 shrink-0 rounded-lg border border-border text-ui-sm">
              <summary className="px-3 py-2">
                {tr("Added")}: {importResult.result.added} · {tr("Skipped")}:{" "}
                {importResult.result.skipped} · {tr("Failed")}: {importResult.result.failed.length}
                {importResult.result.cancelled ? ` · ${tr("Cancelled")}` : ""}
              </summary>
              <div className="max-h-36 space-y-2 overflow-auto border-t p-3">
                {importResult.result.failed.map((item) => (
                  <p className="break-all text-destructive" key={item.path ?? item.name}>
                    {item.name}: {tr(item.error)}
                  </p>
                ))}
                {importResult.result.failed.some((item) => item.path) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      const input = importResult.operation;
                      void run(async () =>
                        recordImport(
                          await resourceApi<ResourceImportResult>({
                            op: "importPaths",
                            target: input.target,
                            paths: importResult.result.failed.flatMap((item) =>
                              item.path ? [item.path] : [],
                            ),
                            directories: input.importDirectories,
                          }),
                          input,
                        ),
                      );
                    }}
                  >
                    {tr("Retry failed imports")}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setImportResult(null)}>
                  {tr("Close")}
                </Button>
              </div>
            </details>
          ) : null}
          {transfer?.libraryId && transfer.libraryId === snapshot.libraryId ? (
            <div
              role="status"
              className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-2 text-ui-sm"
            >
              <span>
                {tr("Resource transfer")}: {transfer.acceptedIds.length} {tr("accepted")} ·{" "}
                {transfer.rejected.length} {tr("failed")}
              </span>
              {transfer.rejected.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      const target = retryResourceTransfer();
                      if (target) await navigateToTransferTarget(navigate, target);
                    });
                  }}
                >
                  {tr("Retry failed items")}
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={tr("Dismiss transfer result")}
                onClick={() => useResourceTransfer.setState({ lastResult: null })}
              >
                <XIcon />
              </Button>
              {transfer.rejected.map((item) => (
                <span key={item.id} className="basis-full break-all text-destructive">
                  {tr(item.error)}
                </span>
              ))}
            </div>
          ) : null}
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {page.isPending || !coherent ? (
              <div
                role="status"
                className="flex min-h-0 flex-1 items-center justify-center p-8 text-ui text-muted-foreground"
              >
                {tr("Loading...")}
              </div>
            ) : !entries.length ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center text-ui text-muted-foreground">
                <FolderIcon className="size-9" />
                <p>
                  {tr(
                    query || tag || type !== "all"
                      ? "No matching resources"
                      : "Drop files here, import a folder, or collect resources from a chat.",
                  )}
                </p>
                {query || tag || type !== "all" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() =>
                        changeRange(() => {
                          setQuery("");
                          setTag("");
                          setType("all");
                        })
                      }
                    >
                      {tr("Clear filters")}
                    </Button>
                    {location.mode === "directory" ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          changeRange(() => {
                            const next: ResourceLocation = {
                              mode: "all",
                              path: "",
                              recursive: false,
                            };
                            pushHistory(next);
                            setPreferences((previous) => ({ ...previous, location: next }));
                            setMultiple(false);
                          })
                        }
                      >
                        {tr("Search entire library")}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button variant="outline" onClick={() => requestImport(false)}>
                    {tr("Import files")}
                  </Button>
                )}
              </div>
            ) : (
              <ResourceAssetBrowser
                entries={entries}
                selection={selection}
                onSelectionChange={changeSelection}
                multiple={multiple}
                view={preferences.view}
                onOpen={openResource}
                onExitMultiple={() => setMultiple(false)}
                disabled={busy || editor.saving}
                scrollRef={scroller}
                actions={actions}
                showPaths={location.mode !== "directory" || location.recursive || !!query}
                onDragStartBlocked={() => {
                  if (!editor.dirty) return false;
                  editor.guard(() => setSelection(emptyResourceSelection()));
                  return true;
                }}
              />
            )}
            {inspector ? (
              <ResourceInspector
                readOnly={writeBlocked}
                entries={selectedEntries}
                editor={editor}
                overlay={inspectorOverlay}
                onClose={() => editor.guard(() => setInspector(false))}
                onPreview={openResource}
                onLocate={locateResource}
                onReveal={(entry) => {
                  void run(() => resourceApi({ op: "reveal", id: entry.id }));
                }}
              />
            ) : null}
          </div>
          <ResourceSelectionBar
            loading={!pageData}
            stats={pageData?.stats}
            selectedCount={selection.ids.length}
            pageCount={entries.length}
            total={pageData?.total ?? 0}
            offset={offset}
            busy={busy}
            actions={actions}
            onClear={() => changeSelection(emptyResourceSelection())}
            onSelectPage={() =>
              changeSelection({ ...selection, ids: entries.map((entry) => entry.id) })
            }
            onPage={(next) =>
              editor.guard(() => {
                setOffset(next);
                setSelection(emptyResourceSelection());
                setNotice(tr("Selection cleared because the browsing range changed."));
                scroller.current?.scrollTo({ top: 0 });
              })
            }
          />
          <span role="status" aria-live="polite" className="sr-only">
            {notice}
          </span>
        </main>
      </div>
      <ResourceDetailsDialog
        entry={preview}
        onClose={() => {
          setPreview(null);
          if (!previewTrigger.current?.isConnected)
            scroller.current?.focus({ preventScroll: true });
        }}
        onUpdated={() => {
          void refresh();
        }}
        returnFocus={previewTrigger}
        fallbackFocus={scroller}
      />
      {indexOpen ? (
        <ResourceIndexStatus
          snapshot={snapshot}
          onClose={() => setIndexOpen(false)}
          onRescan={() => {
            void run(() => resourceApi({ op: "refresh" }));
          }}
        />
      ) : null}
      {transferModule ? (
        <TransferTargetDialog
          module={transferModule}
          count={selectedEntries.length}
          onClose={() => setTransferModule(null)}
          onSend={(target) => sendResources(target, selectedEntries)}
        />
      ) : null}
      {operation ? (
        <ResourceOperationDialog
          key={`${operation.kind}:${operation.entries.map((entry) => entry.id).join(",")}:${operation.target}`}
          operation={operation}
          directories={snapshot.directories}
          threads={Object.values(threads)
            .filter((thread) => !thread.archivedAt)
            .map((thread) => ({ id: thread.id, title: thread.title }))}
          onClose={() => setOperation(null)}
          onChanged={refresh}
          onCompleted={(ids) => {
            setSelection((previous) => ({
              ...previous,
              ids: previous.ids.filter((id) => !ids.includes(id)),
            }));
            toastManager.add({ type: "success", title: `${tr("Completed")}: ${ids.length}` });
          }}
          onNewProject={() => setOperation({ kind: "project", entries: [], target: "" })}
          onCreated={(entry) => {
            if (!entry.path) {
              setOperation({ kind: "project", entries: [], target: "" });
              return;
            }
            navigateLocation({
              mode: "directory",
              path: entry.path,
              directoryId: entry.id,
              recursive: false,
            });
          }}
          onImport={(result, input) => recordImport(result, { ...input, target: input.target! })}
          onBatch={applyBatchResult}
          onChat={sendResources}
        />
      ) : null}
      <Dialog
        open={editor.confirmLeave}
        onOpenChange={(open) => {
          if (!open) editor.cancelLeave();
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("Unsaved resource details")}</DialogTitle>
            <DialogDescription>
              {tr("Save your changes before continuing, or discard them.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 p-4">
            {editor.error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {tr(editor.error)}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={editor.saving} onClick={editor.cancelLeave}>
                {tr("Cancel")}
              </Button>
              <Button variant="outline" disabled={editor.saving} onClick={editor.leave}>
                {tr("Discard changes")}
              </Button>
              <Button disabled={editor.saving} onClick={() => void editor.saveAndLeave()}>
                {tr(editor.saving ? "Saving..." : "Save and continue")}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
