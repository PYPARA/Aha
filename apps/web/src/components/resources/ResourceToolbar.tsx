import type { ReactNode } from "react";
import type { ResourceQuery, ResourcePage } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  FolderIcon,
  CheckIcon,
  PanelRightCloseIcon,
  SearchIcon,
  Rows3Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "~/lib/icons";
import type { ResourceLocation } from "./resourceNavigation";
import { ResourceSelect } from "./ResourceSelect";
export function ResourceActionMenu({
  label,
  children,
  icon,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" aria-label={label} disabled={disabled}>
            {icon}
            {label}
          </Button>
        }
      />
      <ComposerPickerMenuPopup align="end">{children}</ComposerPickerMenuPopup>
    </Menu>
  );
}
export function ResourceToolbar({
  location,
  title,
  query,
  tag,
  type,
  originKind,
  onOriginKind,
  sort,
  view,
  multiple,
  inspector,
  busy,
  onNavigate,
  onToggleMultiple,
  onToggleInspector,
  onCreateFolder,
  onQuery,
  onTag,
  onType,
  onSort,
  onRecursive,
  onToggleView,
  page,
  onHistory,
  canBack,
  canForward,
  onClearFilters,
}: {
  location: ResourceLocation;
  title: string;
  query: string;
  tag: string;
  type: ResourceQuery["type"];
  originKind?: ResourceQuery["originKind"];
  onOriginKind?: (value: ResourceQuery["originKind"]) => void;
  sort: "name" | "modified";
  view: "grid" | "list";
  multiple: boolean;
  inspector: boolean;
  busy: boolean;
  onNavigate: (location: ResourceLocation) => void;
  onToggleMultiple: () => void;
  onToggleInspector: () => void;
  onCreateFolder: () => void;
  onQuery: (value: string) => void;
  onTag: (value: string) => void;
  onType: (value: ResourceQuery["type"]) => void;
  onSort: (value: "name" | "modified") => void;
  onRecursive: (value: boolean) => void;
  onToggleView: () => void;
  page?: ResourcePage | undefined;
  onHistory: (direction: -1 | 1) => void;
  canBack: boolean;
  canForward: boolean;
  onClearFilters: () => void;
}) {
  const tr = useAhaTranslation();
  const breadcrumbs = location.path
    .split("/")
    .filter(Boolean)
    .map((label, index, parts) => ({ label, path: parts.slice(0, index + 1).join("/") }));
  return (
    <div className="shrink-0 space-y-3 border-b border-border p-4">
      <div
        className="flex flex-wrap items-center gap-1 text-ui-sm"
        aria-label={tr("Resource path")}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={tr("Previous resource location")}
          disabled={!canBack}
          onClick={() => onHistory(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={tr("Next resource location")}
          disabled={!canForward}
          onClick={() => onHistory(1)}
        >
          <ChevronRightIcon />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onNavigate({ mode: "directory", path: "", recursive: false })}
        >
          {tr("Library root")}
        </Button>
        {location.mode === "directory" ? (
          breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden>/</span>
              <Button
                size="sm"
                variant="ghost"
                className="max-w-48 truncate"
                title={crumb.path}
                aria-current={crumb.path === location.path ? "page" : undefined}
                onClick={() =>
                  onNavigate({ mode: "directory", path: crumb.path, recursive: false })
                }
              >
                {crumb.label}
              </Button>
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">/ {title}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-ui-lg font-medium" title={location.path}>
            {title}
          </h2>
          <p className="text-ui-xs text-muted-foreground">
            {tr(
              location.mode !== "directory"
                ? "Entire library, including all subfolders"
                : location.recursive
                  ? "All files in this folder and its subfolders"
                  : "Direct subfolders and files",
            )}
          </p>
          {page?.stats ? (
            <p className="mt-1 text-ui-xs tabular-nums text-muted-foreground">
              {query || tag || type !== "all" || originKind
                ? `${tr("Matched files")}: ${page.stats.matchedFiles} / ${tr("Files in scope")}: ${page.stats.scopeFiles} · `
                : ""}
              {tr("Folders")}: {page.stats.matchedDirectories} · {tr("Files")}:{" "}
              {page.stats.matchedFiles}
            </p>
          ) : (
            <p className="text-ui-xs text-muted-foreground">
              {tr(page ? "Statistics unavailable" : "Loading...")}
            </p>
          )}
        </div>
        {location.mode === "directory" ? (
          <>
            <div
              role="group"
              aria-label={tr("Folder content scope")}
              className="flex flex-wrap gap-1"
            >
              <Button
                size="sm"
                variant={!location.recursive ? "secondary" : "outline"}
                aria-pressed={!location.recursive}
                onClick={() => onRecursive(false)}
              >
                {tr("Current folder")}
              </Button>
              <Button
                size="sm"
                variant={location.recursive ? "secondary" : "outline"}
                aria-pressed={location.recursive}
                onClick={() => onRecursive(true)}
              >
                {tr("All assets")}
              </Button>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={onCreateFolder}>
              <FolderIcon />
              {tr("New folder")}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant={multiple ? "secondary" : "outline"}
          aria-pressed={multiple}
          onClick={onToggleMultiple}
        >
          <CheckIcon />
          {tr("Select multiple")}
        </Button>
        <Button
          size="icon-sm"
          variant={inspector ? "secondary" : "ghost"}
          aria-label={tr(inspector ? "Hide details" : "Show details")}
          aria-pressed={inspector}
          onClick={onToggleInspector}
        >
          <PanelRightCloseIcon />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full text-ui-xs text-muted-foreground">
          {tr("Search scope")}:{" "}
          {tr(
            location.mode !== "directory"
              ? "Entire library"
              : location.recursive
                ? "Current folder and subfolders"
                : "Current folder",
          )}
        </div>
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2 top-2 z-10 size-4 text-muted-foreground" />
          <Input
            size="sm"
            aria-label={tr("Search resources")}
            placeholder={tr("Search name or path")}
            className="[&_[data-slot=input]]:pl-8"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
        <div className="w-32">
          <Input
            size="sm"
            aria-label={tr("Filter tags")}
            placeholder={tr("Filter tags")}
            value={tag}
            onChange={(event) => onTag(event.target.value)}
          />
        </div>
        <div className="w-28">
          <ResourceSelect
            label={tr("File type")}
            value={type ?? "all"}
            onChange={(value) => onType(value as ResourceQuery["type"])}
            options={["all", "image", "audio", "video", "document", "other"].map((value) => ({
              value,
              label: tr(value),
            }))}
          />
        </div>
        <div className="w-28">
          <ResourceSelect
            label={tr("Sort by")}
            value={location.mode === "recent" ? "modified" : sort}
            disabled={location.mode === "recent"}
            onChange={(value) => onSort(value as "name" | "modified")}
            options={[
              { value: "modified", label: tr("Modified") },
              { value: "name", label: tr("Name") },
            ]}
          />
        </div>
        {onOriginKind && (
          <div className="w-32">
            <ResourceSelect
              label={tr("Resource source")}
              value={originKind ?? "all"}
              onChange={(value) =>
                onOriginKind(value === "all" ? undefined : (value as ResourceQuery["originKind"]))
              }
              options={[
                { value: "all", label: tr("All sources") },
                ...["image-batch", "sprite", "drawing", "chat", "local", "game"].map((value) => ({
                  value,
                  label: tr(value),
                })),
              ]}
            />
          </div>
        )}
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={tr(view === "grid" ? "List view" : "Grid view")}
          onClick={onToggleView}
        >
          <Rows3Icon />
        </Button>
        {query || tag || type !== "all" || originKind ? (
          <Button size="sm" variant="ghost" onClick={onClearFilters}>
            {tr("Clear filters")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
