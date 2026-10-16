import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { ResourceEntry } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PlusIcon } from "~/lib/icons";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";
import { ResourceTreeFiles, type ResourceTreeFileActions } from "./ResourceTreeFiles";

const WIDTH_STORAGE_KEY = "aha:resource-tree-width";
const DEFAULT_WIDTH = 208;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const CONTENT_MIN_WIDTH = 360;
const KEYBOARD_STEP = 16;
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");

function clampWidth(width: number, containerWidth = MAX_WIDTH + CONTENT_MIN_WIDTH) {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, containerWidth - CONTENT_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

function readWidth() {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    const width = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(width) ? clampWidth(width) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function storeWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Preferences are best effort; browsing and resizing work without storage.
  }
}

export function ResourceDirectoryTree({
  directories,
  current,
  root,
  busy,
  onNavigate,
  onNewProject,
  onRevealRoot,
  libraryId,
  selected,
  onFileClick,
  onFileDoubleClick,
}: {
  directories: ResourceEntry[];
  current: string;
  root: string;
  busy: boolean;
  onNavigate: (path: string) => void;
  onNewProject: () => void;
  onRevealRoot: () => void;
  libraryId: string | null;
} & ResourceTreeFileActions) {
  const tr = useAhaTranslation();
  const treeId = useId();
  const columnRef = useRef<HTMLElement>(null);
  const finishResizeRef = useRef<(() => void) | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [containerWidth, setContainerWidth] = useState(MAX_WIDTH + CONTENT_MIN_WIDTH);
  const [expanded, setExpanded] = useState(
    () => new Set(directories.filter((d) => !parentPath(d.path)).map((d) => d.id)),
  );
  const seenIds = useRef(new Set(directories.map((d) => d.id)));
  const lastNavigation = useRef<string | null>(null);
  const children = useMemo(() => {
    const result = new Map<string, ResourceEntry[]>();
    for (const directory of directories) {
      const parent = parentPath(directory.path);
      const siblings = result.get(parent) ?? [];
      siblings.push(directory);
      result.set(parent, siblings);
    }
    for (const siblings of result.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [directories]);

  const expandPath = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const directory of directories)
        if (path === directory.path || path.startsWith(`${directory.path}/`))
          next.add(directory.id);
      return next;
    });
  };

  useEffect(() => {
    const ids = new Set(directories.map((d) => d.id));
    const newProjects = directories.filter(
      (d) => !parentPath(d.path) && !seenIds.current.has(d.id),
    );
    const navigated = current !== lastNavigation.current;
    seenIds.current = ids;
    setExpanded((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      for (const project of newProjects) next.add(project.id);
      // Refresh must not reopen a branch the user explicitly collapsed.
      if (navigated) {
        for (const directory of directories)
          if (current === directory.path || current.startsWith(`${directory.path}/`))
            next.add(directory.id);
      }
      return next;
    });
    if (!current || directories.some((d) => d.path === current)) lastNavigation.current = current;
  }, [current, directories]);

  useLayoutEffect(() => {
    const container = columnRef.current?.parentElement;
    if (!container) return;
    const measure = () => setContainerWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => finishResizeRef.current?.(), []);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const column = columnRef.current;
    if (!column || event.button !== 0) return;
    event.preventDefault();
    finishResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    let lastWidth: number | null = null;
    const overlay = createPanelResizeOverlay();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let detach: (() => void) | null = null;
    const finish = () => {
      detach?.();
      removePanelResizeOverlay(overlay);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (lastWidth !== null) storeWidth(lastWidth);
      finishResizeRef.current = null;
    };
    finishResizeRef.current = finish;
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (move) => {
        if (move.clientX === startX && lastWidth === null) return;
        lastWidth = clampWidth(
          startWidth + move.clientX - startX,
          column.parentElement?.clientWidth,
        );
        setPreferredWidth(lastWidth);
      },
      onRelease: finish,
      onAbort: finish,
    });
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampWidth(clampWidth(preferredWidth, containerWidth) + step, containerWidth);
    setPreferredWidth(next);
    storeWidth(next);
  };

  const tree = (parent: string, depth = 0): ReactNode =>
    children.get(parent)?.map((directory) => {
      const isExpanded = expanded.has(directory.id);
      return (
        <div key={directory.id}>
          <div
            className={`flex min-w-0 items-center rounded-lg hover:bg-muted ${current === directory.path ? "bg-muted font-medium" : ""}`}
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${tr(isExpanded ? "Collapse folder" : "Expand folder")} ${directory.name}`}
              aria-expanded={isExpanded}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(directory.id)) next.delete(directory.id);
                  else next.add(directory.id);
                  return next;
                })
              }
            >
              {isExpanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={directory.path}
              aria-current={current === directory.path ? "page" : undefined}
              onClick={() => {
                expandPath(directory.path);
                onNavigate(directory.path);
              }}
            >
              <FolderIcon className="size-4 shrink-0" />
              <span className="truncate">{directory.name}</span>
            </button>
          </div>
          {isExpanded ? (
            <>
              {tree(directory.path, depth + 1)}
              <ResourceTreeFiles
                path={directory.path}
                depth={depth + 1}
                libraryId={libraryId}
                selected={selected}
                onFileClick={onFileClick}
                onFileDoubleClick={onFileDoubleClick}
              />
            </>
          ) : null}
        </div>
      );
    });

  const width = clampWidth(preferredWidth, containerWidth);
  return (
    <aside
      ref={columnRef}
      className="relative min-h-0 shrink-0"
      style={{ width }}
      data-testid="resource-tree"
    >
      <nav
        id={treeId}
        aria-label={tr("Resource folders")}
        className="h-full overflow-y-auto overflow-x-hidden p-3"
      >
        <Button
          className="mb-3 w-full justify-start"
          variant="outline"
          disabled={busy}
          onClick={onNewProject}
        >
          <PlusIcon className="size-4" />
          {tr("New project")}
        </Button>
        <button
          type="button"
          className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${!current ? "bg-muted font-medium" : "hover:bg-muted"}`}
          onClick={() => onNavigate("")}
          aria-current={!current ? "page" : undefined}
        >
          {tr("All projects")}
        </button>
        {tree("")}
        <button
          type="button"
          className="mt-4 w-full break-all px-2 text-left text-xs text-muted-foreground"
          title={root}
          onClick={onRevealRoot}
        >
          {root}
        </button>
      </nav>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={tr("Resize resource folders")}
        aria-controls={treeId}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={clampWidth(MAX_WIDTH, containerWidth)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
        className="group absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize bg-transparent outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border hover:before:w-0.5 hover:before:bg-ring focus-visible:before:w-0.5 focus-visible:before:bg-ring"
      />
    </aside>
  );
}
