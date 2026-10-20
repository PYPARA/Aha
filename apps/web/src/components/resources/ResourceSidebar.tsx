import { useMemo, useRef, useState } from "react";
import type { ResourceEntry, ResourceSnapshot } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem } from "~/components/ui/menu";
import { Tree, type TreeRow } from "~/components/ui/tree";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { FolderIcon, ClockIcon, PlusIcon } from "~/lib/icons";
import { directoryLocation, RESOURCE_ROOT_ID, type ResourceLocation } from "./resourceNavigation";
export type ResourceDirectoryAction = "folder" | "rename" | "move" | "trash" | "reveal";
export function ResourceSidebar({
  snapshot,
  location,
  expandedIds,
  onExpandedChange,
  onNavigate,
  onNewProject,
  onManage,
  width,
  rem,
  onWidthChange,
  overlay,
  busy,
  onShowIndex,
}: {
  snapshot: ResourceSnapshot;
  location: ResourceLocation;
  expandedIds: string[];
  onExpandedChange: (ids: string[]) => void;
  onNavigate: (location: ResourceLocation) => void;
  onNewProject: () => void;
  onManage: (entry: ResourceEntry | null, action: ResourceDirectoryAction) => void;
  width: number;
  rem: number;
  onWidthChange: (width: number) => void;
  overlay: boolean;
  busy: boolean;
  onShowIndex: () => void;
}) {
  const tr = useAhaTranslation();
  const [search, setSearch] = useState("");
  const [searchCollapsed, setSearchCollapsed] = useState<string[]>([]);
  const [context, setContext] = useState<{
    id: string;
    rect: DOMRect;
    trigger: HTMLElement;
  } | null>(null);
  const resizing = useRef<{ start: number; width: number } | null>(null);
  const directories = snapshot.directories;
  const byId = useMemo(() => new Map(directories.map((d) => [d.id, d])), [directories]);
  const rootName = snapshot.root?.split(/[/\\]/).findLast(Boolean) ?? tr("Library root");
  const rows = useMemo(() => {
    const byPath = new Map(directories.map((d) => [d.path, d]));
    const children = new Map<string, ResourceEntry[]>();
    for (const d of directories) {
      const parent = d.path.split("/").slice(0, -1).join("/");
      const siblings = children.get(parent) ?? [];
      siblings.push(d);
      children.set(parent, siblings);
    }
    for (const siblings of children.values())
      siblings.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const stats = new Map(snapshot.directoryStats?.map((s) => [s.path, s.recursiveFiles]));
    const matching = new Set<string>();
    if (search)
      for (const d of directories)
        if (d.path.toLocaleLowerCase().includes(search.toLocaleLowerCase())) {
          let p = d.path;
          while (p) {
            matching.add(p);
            p = p.split("/").slice(0, -1).join("/");
          }
        }
    const result: TreeRow[] = [];
    const add = (
      path: string,
      id: string,
      name: string,
      level: number,
      parentId: string | null,
    ) => {
      const descendants = (children.get(path) ?? []).filter((d) => !search || matching.has(d.path));
      const expanded = search ? !searchCollapsed.includes(id) : expandedIds.includes(id);
      result.push({
        id,
        parentId,
        level,
        label: path || rootName,
        expanded,
        hasChildren: descendants.length > 0,
        selected:
          location.mode === "directory" &&
          (path
            ? location.directoryId === id || (!location.directoryId && location.path === path)
            : !location.path),
        content: (
          <>
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span
              className="text-ui-xs tabular-nums text-muted-foreground"
              title={tr("File count includes subfolders and ignores content filters.")}
            >
              {stats.get(path) ?? "—"}
            </span>
          </>
        ),
      });
      if (expanded)
        for (const child of descendants)
          if (!search || matching.has(child.path))
            add(
              child.path,
              child.id,
              child.name,
              level + 1,
              byPath.get(path)?.id ?? RESOURCE_ROOT_ID,
            );
    };
    add("", RESOURCE_ROOT_ID, rootName, 1, null);
    return result;
  }, [
    directories,
    snapshot.directoryStats,
    expandedIds,
    location,
    rootName,
    search,
    searchCollapsed,
    tr,
  ]);
  const entry = context ? (byId.get(context.id) ?? null) : null;
  const act = (action: ResourceDirectoryAction) => {
    onManage(entry, action);
    setContext(null);
  };
  return (
    <aside
      aria-label={tr("Resource views")}
      data-testid="resource-sidebar"
      className={`relative flex min-h-0 min-w-0 shrink-0 flex-col border-r border-border bg-background py-3 ${overlay ? "flex-1" : ""}`}
      style={{ width: overlay ? "100%" : width, maxWidth: "100%" }}
    >
      <nav className="space-y-1 px-2">
        {(
          [
            ["all", "All resources"],
            ["recent", "Recently modified"],
          ] as const
        ).map(([mode, label]) => (
          <Button
            key={mode}
            aria-label={tr(label)}
            variant={location.mode === mode ? "secondary" : "ghost"}
            className="w-full justify-start"
            aria-current={location.mode === mode ? "page" : undefined}
            onClick={() => onNavigate({ mode, path: "", recursive: false })}
          >
            {mode === "all" ? <FolderIcon /> : <ClockIcon />}
            <span className="flex-1 text-left">{tr(label)}</span>
            {mode === "all" ? (
              <span className="text-ui-xs tabular-nums text-muted-foreground">
                {snapshot.count}
              </span>
            ) : null}
          </Button>
        ))}
      </nav>
      <div className="mt-4 flex items-center justify-between px-3 text-ui-sm text-muted-foreground">
        <span>{tr("Projects and folders")}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("New project")}
          disabled={busy}
          onClick={onNewProject}
        >
          <PlusIcon />
        </Button>
      </div>
      <div className="px-2 py-2">
        <Input
          size="sm"
          aria-label={tr("Find folder")}
          placeholder={tr("Find folder")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setSearchCollapsed([]);
          }}
        />
      </div>
      <Tree
        className="mx-2"
        rows={rows}
        label={tr("Projects and folders")}
        onActivate={(id) => onNavigate(directoryLocation(byId.get(id)?.path ?? "", directories))}
        onToggle={(id) => {
          if (search)
            setSearchCollapsed((previous) =>
              previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
            );
          else
            onExpandedChange(
              expandedIds.includes(id)
                ? expandedIds.filter((value) => value !== id)
                : [...expandedIds, id],
            );
        }}
        menuLabel={(row) => `${tr("Manage folder")} ${row.label}`}
        onContextMenu={(id, rect, trigger) => setContext({ id, rect, trigger })}
      />
      {search && rows.length === 1 ? (
        <p className="px-3 py-2 text-ui-sm text-muted-foreground">{tr("No matching folders")}</p>
      ) : null}
      <div className="mt-2 border-t px-3 pt-3 text-ui-xs text-muted-foreground">
        <p className="truncate" title={snapshot.root ?? ""}>
          {rootName}
        </p>
        <Button
          size="xs"
          variant="ghost"
          className="max-w-full justify-start"
          onClick={onShowIndex}
        >
          {tr(
            snapshot.scan?.phase === "ready"
              ? "Synced"
              : snapshot.scan?.phase === "scanning" || snapshot.scan?.phase === "loading"
                ? "Scanning; counts may change"
                : snapshot.scan?.phase === "failed"
                  ? "Results may be incomplete"
                  : "Index status",
          )}{" "}
          · {snapshot.count}
        </Button>
      </div>
      {!overlay ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label={tr("Resize resource navigation")}
          aria-orientation="vertical"
          aria-valuenow={Math.round(width)}
          aria-valuemin={12 * rem}
          aria-valuemax={20 * rem}
          className="absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-col-resize focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizing.current = { start: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (resizing.current)
              onWidthChange(resizing.current.width + event.clientX - resizing.current.start);
          }}
          onPointerUp={() => {
            resizing.current = null;
          }}
          onPointerCancel={() => {
            resizing.current = null;
          }}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              onWidthChange(width + (event.key === "ArrowLeft" ? -16 : 16));
            }
          }}
        />
      ) : null}
      <Menu
        open={!!context}
        onOpenChange={(open) => {
          if (!open) setContext(null);
        }}
      >
        <ComposerPickerMenuPopup
          anchor={context ? { getBoundingClientRect: () => context.rect } : undefined}
          finalFocus={() => context?.trigger}
          align="start"
        >
          <MenuItem disabled={busy} onClick={() => act("folder")}>
            {tr("New folder")}
          </MenuItem>
          {entry ? (
            <>
              <MenuItem disabled={busy} onClick={() => act("rename")}>
                {tr("Rename")}
              </MenuItem>
              <MenuItem disabled={busy} onClick={() => act("move")}>
                {tr("Move to")}
              </MenuItem>
            </>
          ) : null}
          <MenuItem onClick={() => act("reveal")}>{tr("Show in folder")}</MenuItem>
          {entry ? (
            <MenuItem disabled={busy} onClick={() => act("trash")}>
              {tr("Move to trash")}
            </MenuItem>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </aside>
  );
}
