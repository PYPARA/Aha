import type { MouseEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ResourceEntry, ResourcePage } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { FileIcon } from "~/lib/icons";
import { resourceApi, resourceKey } from "./resourceLibrary";

export interface ResourceTreeFileActions {
  selected: string[];
  onFileClick: (entry: ResourceEntry, offset: number, event: MouseEvent<HTMLButtonElement>) => void;
  onFileDoubleClick: (
    entry: ResourceEntry,
    offset: number,
    trigger: HTMLButtonElement,
    restoreSelection?: boolean,
  ) => void;
}

// Fetch direct children only while their folder is expanded. The directory snapshot
// supplies folder rows; these pages supply files without reading any file contents.
export function ResourceTreeFiles({
  path,
  depth,
  libraryId,
  selected,
  onFileClick,
  onFileDoubleClick,
}: ResourceTreeFileActions & { path: string; depth: number; libraryId: string | null }) {
  const tr = useAhaTranslation();
  const files = useInfiniteQuery({
    queryKey: [...resourceKey, "tree-files", libraryId, path],
    queryFn: async ({ pageParam }) => ({
      ...(await resourceApi<ResourcePage>({
        op: "list",
        query: { path, recursive: false, sort: "name", offset: pageParam },
      })),
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.entries.length > 0 && lastOffset + lastPage.entries.length < lastPage.total
        ? lastOffset + lastPage.entries.length
        : undefined,
    retry: false,
  });
  const paddingLeft = 4 + depth * 14 + 20;
  return (
    <>
      {files.data?.pages.map((page) =>
        page.entries
          .filter((entry) => entry.kind === "file")
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.path}
              aria-label={entry.name}
              aria-pressed={selected.includes(entry.id)}
              className={`flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${selected.includes(entry.id) ? "bg-muted font-medium" : ""}`}
              style={{ paddingLeft }}
              onClick={(event) => onFileClick(entry, page.offset, event)}
              onDoubleClick={(event) => onFileDoubleClick(entry, page.offset, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onFileDoubleClick(entry, page.offset, event.currentTarget, false);
                }
              }}
            >
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
          )),
      )}
      {files.isPending ? (
        <p role="status" className="py-1 text-xs text-muted-foreground" style={{ paddingLeft }}>
          {tr("Loading...")}
        </p>
      ) : null}
      {files.isError ? (
        <div className="py-1 text-xs text-destructive" style={{ paddingLeft }}>
          <p role="alert" className="break-words">
            {tr(files.error.message)}
          </p>
          <button
            type="button"
            className="py-1 underline"
            onClick={() =>
              void (files.isFetchNextPageError ? files.fetchNextPage() : files.refetch())
            }
          >
            {tr("Retry")}
          </button>
        </div>
      ) : null}
      {files.hasNextPage ? (
        <button
          type="button"
          className="w-full py-1.5 pr-2 text-left text-xs text-muted-foreground hover:text-foreground"
          style={{ paddingLeft }}
          disabled={files.isFetchingNextPage}
          onClick={() => void files.fetchNextPage()}
        >
          {tr(files.isFetchingNextPage ? "Loading..." : "Load more")}
        </button>
      ) : null}
    </>
  );
}
