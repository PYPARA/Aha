import { collectResources } from "../resources/resourceLibrary";
import { drawingResourceSource, resourceContextMenu } from "../resources/ResourceCollectionDialog";
import { CentralIcon } from "~/lib/central-icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageJob, ImageJobListInput } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { MoreHorizontalIcon, RotateCcwIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuItem } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { imageUrl, useImageJobs } from "./useDrawing";

export const activeImageJob = (job: ImageJob) =>
  ["queued", "running", "saving"].includes(job.status);
export function DrawingElapsed({ job }: { job: ImageJob }) {
  const [time, setTime] = useState(Date.now());
  const active = activeImageJob(job);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <span>
      {Math.max(
        0,
        Math.round(
          ((job.finishedAt ? Date.parse(job.finishedAt) : time) -
            Date.parse(job.startedAt ?? job.createdAt)) /
            1000,
        ),
      )}
      s
    </span>
  );
}

export function DrawingGallery({
  filters,
  onOpen,
  onReuse,
  onRegenerate,
  onCancel,
  onDelete,
  onSettings,
  hasProvider,
}: {
  filters: Omit<ImageJobListInput, "cursor">;
  onOpen: (job: ImageJob) => void;
  onReuse: (job: ImageJob) => void;
  onRegenerate: (job: ImageJob) => void;
  onCancel: (job: ImageJob) => void;
  onDelete: (job: ImageJob) => void;
  onSettings: () => void;
  hasProvider: boolean;
}) {
  const tr = useAhaTranslation();
  const history = useImageJobs(filters);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = history;
  const viewport = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const jobs = history.data?.pages.flatMap((p) => p.jobs) ?? [];
  // Preserve the first visible task when live updates insert tasks above it.
  const previousData = useRef(history.data);
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    if (previousData.current !== history.data && anchor.current && root.scrollTop > 24) {
      const element = root.querySelector<HTMLElement>(`[data-job-id="${anchor.current.id}"]`);
      if (element)
        root.scrollTop +=
          element.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          anchor.current.offset;
    }
    previousData.current = history.data;
  }, [history.data]);
  useEffect(() => {
    viewport.current?.scrollTo({ top: 0 });
    anchor.current = null;
  }, [filters.query, filters.statusGroup]);
  useEffect(() => {
    if (!sentinel.current || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
      },
      { root: viewport.current, rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const groups: { day: string; label: string; jobs: ImageJob[] }[] = [];
  for (const job of jobs) {
    const date = new Date(job.createdAt),
      day = date.toLocaleDateString();
    let group = groups.at(-1);
    if (group?.day !== day) {
      group = { day, label: day === new Date().toLocaleDateString() ? tr("Today") : day, jobs: [] };
      groups.push(group);
    }
    group!.jobs.push(job);
  }
  return (
    <div
      ref={viewport}
      data-testid="drawing-gallery"
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-6 [overflow-anchor:none]"
      onScroll={() => {
        const root = viewport.current;
        if (!root || root.scrollTop < 24) {
          anchor.current = null;
          return;
        }
        const top = root.getBoundingClientRect().top;
        const first = [...root.querySelectorAll<HTMLElement>("[data-job-id]")].find(
          (el) => el.getBoundingClientRect().bottom > top,
        );
        if (first)
          anchor.current = {
            id: first.dataset.jobId!,
            offset: first.getBoundingClientRect().top - top,
          };
      }}
    >
      <div className="mx-auto w-full max-w-[1600px]">
        {history.isError && !jobs.length ? (
          <div role="alert" className="py-8 text-sm text-destructive">
            {history.error.message}
            <Button variant="ghost" onClick={() => void history.refetch()}>
              {tr("Retry")}
            </Button>
          </div>
        ) : history.isPending ? (
          <p className="py-8 text-sm text-muted-foreground">{tr("Loading...")}</p>
        ) : !jobs.length ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 py-12 text-center">
            <CentralIcon name="images-sparkle" className="mb-2 size-8 text-muted-foreground/50" />
            <h2 className="text-sm font-medium">
              {tr(
                filters.query || filters.statusGroup !== "all"
                  ? "No matching image tasks"
                  : "Start with an idea",
              )}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {tr(
                filters.query || filters.statusGroup !== "all"
                  ? "Try another prompt or status."
                  : "Describe an image, add references, or draw on a blank canvas.",
              )}
            </p>
            {!hasProvider ? (
              <Button variant="outline" size="sm" onClick={onSettings}>
                {tr("Add image provider")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.day} className="pb-4" aria-label={group.label}>
            <h2 className="py-3 text-ui-xs font-medium text-muted-foreground">{group.label}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
              {group.jobs.map((job) => (
                <article
                  key={job.id}
                  data-job-id={job.id}
                  className="group flex h-40 min-w-0 overflow-hidden rounded-2xl border border-[color:var(--surface-border)] bg-[var(--color-background-elevated-primary-opaque)] transition-colors hover:border-foreground/20"
                >
                  <button
                    type="button"
                    className="relative flex w-[42%] shrink-0 items-center justify-center overflow-hidden bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${tr("Image task details")}: ${job.prompt}`}
                    onClick={() => onOpen(job)}
                  >
                    {job.outputs[0] ? (
                      <img
                        loading="lazy"
                        src={imageUrl(job.outputs[0], "thumbnail")}
                        onContextMenuCapture={(e) =>
                          void resourceContextMenu(
                            e,
                            [
                              drawingResourceSource(
                                job.outputs[0]!,
                                imageUrl(job.outputs[0]!),
                                job,
                              ),
                            ],
                            tr,
                          )
                        }
                        alt={job.prompt}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-ui-xs text-muted-foreground">
                        <CentralIcon
                          name="images-sparkle"
                          className={activeImageJob(job) ? "size-6 animate-pulse" : "size-6"}
                        />
                        <span>{tr(job.status)}</span>
                      </div>
                    )}
                    {job.outputs.length > 1 ? (
                      <span
                        className="absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-xs text-white"
                        aria-label={tr("Image count")}
                      >
                        {job.outputs.length}
                      </span>
                    ) : null}
                    {job.outputs[0] ? (
                      <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                        {job.outputs[0].width}×{job.outputs[0].height}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col p-3">
                    <button
                      type="button"
                      className="line-clamp-2 text-left text-ui-sm leading-relaxed break-words"
                      onClick={() => onOpen(job)}
                    >
                      {job.prompt}
                    </button>
                    <p
                      className="mt-auto truncate pt-2 text-ui-xs text-muted-foreground"
                      title={`${job.providerName} · ${job.model}`}
                    >
                      {job.providerName} · {job.model}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
                      <span className={job.error ? "text-destructive" : ""}>{tr(job.status)}</span>
                      <DrawingElapsed job={job} />
                      {job.isTest ? (
                        <span className="truncate">{tr("Connection test")}</span>
                      ) : null}
                    </div>
                    {job.error ? (
                      <p role="alert" className="sr-only">
                        {job.error.message}
                      </p>
                    ) : null}
                    <div className="mt-1 flex items-center justify-end gap-0.5">
                      <Button
                        type="button"
                        variant="chrome"
                        size="icon-xs"
                        title={tr("Reuse parameters")}
                        aria-label={tr("Reuse parameters")}
                        onClick={() => onReuse(job)}
                      >
                        <RotateCcwIcon className="size-3.5" />
                      </Button>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="chrome"
                              size="icon-xs"
                              aria-label={tr("Task actions")}
                            >
                              <MoreHorizontalIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <ComposerPickerMenuPopup align="end">
                          <MenuItem onClick={() => onOpen(job)}>{tr("Details")}</MenuItem>
                          {window.desktopBridge?.resourceLibrary && job.outputs.length ? (
                            <MenuItem
                              onClick={() =>
                                collectResources(
                                  job.outputs.map((a) =>
                                    drawingResourceSource(a, imageUrl(a), job),
                                  ),
                                )
                              }
                            >
                              {tr("Add all results to resource center")}
                            </MenuItem>
                          ) : null}
                          <MenuItem onClick={() => onReuse(job)}>{tr("Reuse parameters")}</MenuItem>
                          {activeImageJob(job) ? (
                            <MenuItem onClick={() => onCancel(job)}>{tr("Cancel task")}</MenuItem>
                          ) : (
                            <MenuItem onClick={() => onRegenerate(job)}>
                              {tr("Regenerate")} · {job.parameters.n}
                            </MenuItem>
                          )}
                          <MenuItem className="text-destructive" onClick={() => onDelete(job)}>
                            {tr("Delete")}
                          </MenuItem>
                        </ComposerPickerMenuPopup>
                      </Menu>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
        <div ref={sentinel} className="h-1" />
        {history.hasNextPage ? (
          <div className="flex justify-center py-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {tr(
                history.isFetchNextPageError
                  ? "Retry"
                  : history.isFetchingNextPage
                    ? "Loading..."
                    : "Load more",
              )}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
