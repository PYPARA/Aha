import type { ResourcePage } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import { MenuItem } from "~/components/ui/menu";
import { XIcon, ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { ResourceActionMenu } from "./ResourceToolbar";
import type { ResourceItemAction } from "./ResourceAssetBrowser";
export function ResourceSelectionBar({
  selectedCount,
  pageCount,
  total,
  offset,
  busy,
  actions,
  onClear,
  onSelectPage,
  onPage,
  stats,
  loading = false,
}: {
  loading?: boolean;
  stats?: ResourcePage["stats"];
  selectedCount: number;
  pageCount: number;
  total: number;
  offset: number;
  busy: boolean;
  actions: ResourceItemAction[];
  onClear: () => void;
  onSelectPage: () => void;
  onPage: (offset: number) => void;
}) {
  const tr = useAhaTranslation();
  const usage = actions.filter((action) =>
    ["chat", "drawing", "sprite", "image-batch"].includes(action.key),
  );
  return (
    <footer
      data-testid="resource-actions"
      aria-label={tr("Resource actions")}
      className="flex min-h-24 shrink-0 flex-wrap content-center items-center gap-2 border-t border-border px-3 py-2 text-ui-sm"
    >
      {selectedCount ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("Clear selection")}
            disabled={busy}
            onClick={onClear}
          >
            <XIcon />
          </Button>
          <span className="tabular-nums">
            {tr("Selected")}: {selectedCount} / {tr("This page")}: {pageCount}
          </span>
          <ResourceActionMenu
            label={tr("Use in…")}
            disabled={busy || usage.every((action) => action.disabled)}
          >
            {usage.map((action) => (
              <MenuItem key={action.key} disabled={action.disabled} onClick={action.run}>
                {action.label}
              </MenuItem>
            ))}
          </ResourceActionMenu>
          <span className="hidden gap-2 @[50rem]:inline-flex">
            {actions
              .filter((action) => ["move", "tags", "export"].includes(action.key))
              .map((action) => (
                <Button
                  key={action.key}
                  size="sm"
                  variant="outline"
                  disabled={busy || action.disabled}
                  onClick={action.run}
                >
                  {action.label}
                </Button>
              ))}
          </span>
          <ResourceActionMenu label={tr("More actions")} disabled={busy}>
            {actions.map((action) => (
              <MenuItem key={action.key} disabled={action.disabled} onClick={action.run}>
                {action.label}
              </MenuItem>
            ))}
          </ResourceActionMenu>
        </>
      ) : null}
      <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 text-ui-xs text-muted-foreground">
        <span className="tabular-nums">
          {loading ? (
            tr("Loading...")
          ) : (
            <>
              {tr("Showing")} {total ? offset + 1 : 0}–{Math.min(offset + 100, total)} /{" "}
              {tr("Total")} {total} {tr(stats?.matchedDirectories ? "items" : "Files")}
            </>
          )}
        </span>
        {stats?.matchedDirectories ? (
          <span>
            {tr("Folders")}: {stats.matchedDirectories} · {tr("Files")}: {stats.matchedFiles}
          </span>
        ) : null}
        {!selectedCount ? (
          <span className="hidden @[65rem]:inline">
            {tr("Drag blank space to select; Cmd/Ctrl toggles items, Shift selects a range.")}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!pageCount || busy || loading}
            onClick={onSelectPage}
          >
            {tr("Select this page")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={tr("Previous page")}
            disabled={offset === 0 || busy || loading}
            onClick={() => onPage(Math.max(0, offset - 100))}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="tabular-nums">
            {Math.floor(offset / 100) + 1} / {Math.max(1, Math.ceil(total / 100))}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={tr("Next page")}
            disabled={offset + 100 >= total || busy || loading}
            onClick={() => onPage(offset + 100)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </footer>
  );
}
