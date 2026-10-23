import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  IMAGE_BATCH_MAX_STYLE_PROMPT,
  IMAGE_BATCH_MAX_STYLE_REFERENCES,
  imageBatchPlanCounts,
  imageBatchTaskConfiguration,
  type ImageBatchState,
  type ImageBatchTask,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { OptionSelect } from "../ui/option-select";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { RouteSurfaceHeader } from "../RouteSurface";
import { confirmDialog } from "../ui/confirm-dialog";
import { DrawingModelPicker, DrawingParameters } from "../drawing/DrawingPickers";
import { useImageProviders, useDrawingEvents } from "../drawing/useDrawing";
import {
  batchApi,
  useBatch,
  useBatchCommand,
  useBatchEvents,
  useBatchList,
} from "./useImageBatches";
import { BatchChat } from "./BatchChat";
import { BatchTaskEditor } from "./BatchTaskEditor";
import { BatchResults } from "./BatchResults";
import { BatchProposals } from "./BatchProposals";
import { BatchExecution } from "./BatchExecution";
import { BatchReferenceList } from "./BatchReferenceList";
import { useResourceAttachments, type ResourceReceiveResult } from "../resources/resourceLibrary";
import { uploadDrawingImage } from "../drawing/useDrawing";
import { drawingResourceError } from "@synara/contracts/resourceLibrary";

export default function ImageBatchWorkbench({
  batchId,
  taskId,
  resultId,
}: {
  batchId?: string;
  taskId?: string;
  resultId?: string;
}) {
  useBatchEvents();
  useDrawingEvents();
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useBatchCommand();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<"all" | "draft" | "active" | "issues" | "archived">("all");
  const [drawer, setDrawer] = useState(false),
    [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const narrow = useMediaQuery("(max-width: 900px)");
  const list = useBatchList(query, filter),
    detail = useBatch(batchId ?? null);
  const creationId = useRef<string | null>(null);
  const showError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const select = (id: string) => {
    setDrawer(false);
    setError(null);
    void navigate({ to: "/image-batches", search: { batchId: id } });
  };
  const create = async () => {
    if (creating) return;
    setCreating(true);
    creationId.current ??= crypto.randomUUID();
    try {
      const batch = await command({
        operation: "create",
        requestId: creationId.current,
        name: tr("Untitled batch"),
      });
      creationId.current = null;
      select(batch.id);
    } catch (e) {
      showError(e);
    } finally {
      setCreating(false);
    }
  };
  const sidebar = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 p-3">
        <Button className="w-full" disabled={creating} onClick={() => void create()}>
          {tr("New batch")}
        </Button>
        <Input
          aria-label={tr("Search batches")}
          placeholder={tr("Search batches")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <OptionSelect
          label={tr("Batch filter")}
          value={filter}
          onValueChange={(v) => setFilter(v as typeof filter)}
        >
          <option value="all">{tr("All batches")}</option>
          <option value="draft">{tr("Drafts")}</option>
          <option value="active">{tr("Running")}</option>
          <option value="issues">{tr("With issues")}</option>
          <option value="archived">{tr("Archived")}</option>
        </OptionSelect>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3" aria-label={tr("Batch list")}>
        {list.isPending && (
          <p role="status" className="p-2 text-ui-sm">
            {tr("Loading...")}
          </p>
        )}
        {list.isError && (
          <p role="alert" className="p-2 text-ui-sm text-destructive">
            {list.error.message}
            <Button variant="ghost" size="sm" onClick={() => void list.refetch()}>
              {tr("Retry")}
            </Button>
          </p>
        )}
        {list.data?.pages
          .flatMap((p) => p.batches)
          .map((b) => (
            <button
              key={b.id}
              type="button"
              aria-current={batchId === b.id ? "page" : undefined}
              className={
                "mb-1 w-full rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                (batchId === b.id ? "bg-muted" : "hover:bg-muted/50")
              }
              onClick={() => select(b.id)}
            >
              <span className="block truncate text-ui font-medium">{b.name}</span>
              <span className="mt-1 block text-ui-xs text-muted-foreground">
                {b.tasks} {tr("tasks")} · {b.generated}/{b.planned} {tr("images")}
              </span>
              <span className="block text-ui-xs text-muted-foreground">
                {tr(
                  b.archived
                    ? "Archived"
                    : b.active
                      ? "Running"
                      : b.issues
                        ? "With issues"
                        : b.generated
                          ? "Results available"
                          : "Draft",
                )}
              </span>
            </button>
          ))}
        {list.data?.pages[0]?.batches.length === 0 && (
          <p className="p-3 text-ui-sm text-muted-foreground">{tr("No batches in this view.")}</p>
        )}
        {list.hasNextPage && (
          <Button
            size="sm"
            variant="ghost"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {tr("Load more")}
          </Button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <RouteSurfaceHeader>
        <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDrawer(true)}
            className={narrow ? "" : "hidden"}
          >
            {tr("Batches")}
          </Button>
          <h1 className="truncate text-ui font-medium">{tr("Batch images")}</h1>
          <span className="hidden truncate text-ui-sm text-muted-foreground sm:block">
            {detail.data?.name}
          </span>
        </div>
      </RouteSurfaceHeader>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b px-4 py-2 text-ui-sm text-destructive"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              void detail.refetch();
            }}
          >
            {tr("Refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            {tr("Dismiss")}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!narrow && <aside className="flex w-60 shrink-0 flex-col border-r">{sidebar}</aside>}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!batchId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <h2 className="text-ui-lg font-medium">
                {tr("Turn requirements into a batch of images")}
              </h2>
              <p className="max-w-lg text-ui text-muted-foreground">
                {tr(
                  "Discuss requirements, review the task list, then confirm generation. Pick the results you want to add to the resource center.",
                )}
              </p>
              <Button disabled={creating} onClick={() => void create()}>
                {tr("New batch")}
              </Button>
            </div>
          ) : detail.isPending ? (
            <p role="status" className="p-5 text-ui">
              {tr("Loading...")}
            </p>
          ) : detail.isError ? (
            <div role="alert" className="space-y-3 p-5 text-ui">
              <p>{detail.error.message}</p>
              <Button variant="outline" onClick={() => void detail.refetch()}>
                {tr("Retry")}
              </Button>
            </div>
          ) : detail.data ? (
            <BatchWorkspace
              key={detail.data.id}
              batch={detail.data}
              taskId={taskId}
              resultId={resultId}
              onError={showError}
              onRemoved={() => void navigate({ to: "/image-batches", search: {} })}
            />
          ) : null}
        </main>
      </div>
      <Sheet open={drawer && narrow} onOpenChange={setDrawer}>
        <SheetPopup side="left">
          <SheetTitle className="p-4 text-ui font-medium">{tr("Batches")}</SheetTitle>
          {sidebar}
        </SheetPopup>
      </Sheet>
    </>
  );
}

function BatchWorkspace({
  batch,
  taskId,
  resultId,
  onError,
  onRemoved,
}: {
  batch: ImageBatchState;
  taskId?: string | undefined;
  resultId?: string | undefined;
  onError: (e: unknown) => void;
  onRemoved: () => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useBatchCommand(),
    providers = useImageProviders();
  const [tab, setTab] = useState(resultId ? "results" : taskId ? "tasks" : "brief");
  const [editor, setEditor] = useState<{ task: ImageBatchTask; base: ImageBatchState } | null>(
    null,
  );
  const [configuration, setConfiguration] = useState<ImageBatchState | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [bulkCount, setBulkCount] = useState("2");
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const [retainedResults, setRetainedResults] = useState(false);
  const focusTask = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (resultId) setTab("results");
    else if (taskId) setTab("tasks");
  }, [taskId, resultId]);
  useEffect(() => {
    if (tab === "tasks" && taskId) focusTask.current?.scrollIntoView({ block: "nearest" });
  }, [tab, taskId]);
  const counts = imageBatchPlanCounts(batch.tasks, batch.defaults);
  const hasStyle = !!batch.defaults.stylePrompt?.trim() || !!batch.defaults.styleReferences?.length;
  const pending = batch.proposals.filter((p) => p.status === "pending").length;
  const active = batch.executions.some((e) => !e.finishedAt);
  // Images sent from the Resource Center or other modules become batch style references.
  useResourceAttachments(
    "image-batch:" + batch.id,
    async (files) => {
      const result: ResourceReceiveResult = { accepted: [], rejected: [] };
      const styleReferences = [...(batch.defaults.styleReferences ?? [])];
      let bytes = 0;
      for (const [index, file] of files.entries()) {
        try {
          if (styleReferences.length >= IMAGE_BATCH_MAX_STYLE_REFERENCES)
            throw new Error(
              tr("At most {count} reference images are allowed.").replace(
                "{count}",
                String(IMAGE_BATCH_MAX_STYLE_REFERENCES),
              ),
            );
          const reason = drawingResourceError(file, { count: index, bytes });
          if (reason) throw new Error(tr(reason));
          const asset = await uploadDrawingImage(file, file.name);
          styleReferences.push({ id: crypto.randomUUID(), assetId: asset.id, documentId: null });
          bytes += file.size;
          result.accepted.push(index);
        } catch (error) {
          result.rejected.push({
            index,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (result.accepted.length) {
        await command({
          operation: "save",
          batchId: batch.id,
          version: batch.version,
          name: batch.name,
          brief: batch.brief,
          defaults: { ...batch.defaults, styleReferences },
          tasks: batch.tasks,
        });
        setConfiguration(null);
      }
      return result;
    },
    !batch.archived && !active,
  );
  const saveTasks = async (tasks: ImageBatchTask[], base = batch) => {
    await command({
      operation: "save",
      batchId: base.id,
      version: base.version,
      name: base.name,
      brief: base.brief,
      defaults: base.defaults,
      tasks,
    });
  };
  const action = (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void run()
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const lifecycle = async (operation: "archive" | "remove") => {
    if (operation === "remove") {
      if (
        !(await confirmDialog({
          title: tr('Remove batch record "{name}"?').replace("{name}", batch.name),
          description: tr(
            "The batch leaves the list. Original images and files already added to the resource center are kept, and you can still clear the originals afterwards.",
          ),
          confirmLabel: tr("Remove"),
          destructive: true,
        }))
      )
        return;
      await command({ operation, batchId: batch.id, version: batch.version });
    } else
      await command({
        operation,
        batchId: batch.id,
        version: batch.version,
        archived: !batch.archived,
      });
  };
  if (batch.removed)
    return (
      <>
        <div className="space-y-4 p-5 text-ui">
          <h2 className="font-medium">{tr("Batch record removed")}</h2>
          <p className="text-muted-foreground">
            {tr(
              "Original images are retained. Clearing originals removes batch results and source snapshots; collected resources and shared references remain.",
            )}
          </p>
          <Button variant="outline" onClick={onRemoved}>
            {tr("Back to batches")}
          </Button>
          <Button variant="outline" onClick={() => setRetainedResults(!retainedResults)}>
            {tr(retainedResults ? "Hide retained results" : "View retained results")}
          </Button>
          {(batch.executions.length > 0 || batch.sources.length > 0) && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  if (
                    !(await confirmDialog({
                      title: tr("Clear batch originals?"),
                      description: tr(
                        "Permanently deletes this removed batch's original images and source snapshots. This cannot be undone. Files already added to the resource center remain.",
                      ),
                      confirmLabel: tr("Clear originals"),
                      destructive: true,
                    }))
                  )
                    return;
                  await command({
                    operation: "clear-originals",
                    batchId: batch.id,
                    version: batch.version,
                  });
                })
              }
            >
              {tr("Clear batch originals")}
            </Button>
          )}
        </div>
        {retainedResults && <BatchResults batch={batch} readOnly onError={onError} />}
      </>
    );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium">{batch.name}</h2>
        <span className="text-ui-xs text-muted-foreground">
          {counts.tasks} {tr("tasks")} · {counts.images} {tr("planned images")}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setConfiguration(structuredClone(batch))}>
          {tr("Batch settings")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || active}
          onClick={() => action(() => lifecycle("archive"))}
        >
          {tr(batch.archived ? "Restore batch" : "Archive")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || active}
          onClick={() => action(() => lifecycle("remove"))}
        >
          {tr("Remove")}
        </Button>
      </div>
      <div
        role="tablist"
        aria-label={tr("Batch workspace")}
        className="flex shrink-0 gap-1 border-b px-3 py-2"
      >
        {[
          ["brief", "Requirements and sources"],
          ["tasks", "Task list"],
          ["results", "Generated results"],
        ].map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            id={"batch-tab-" + id}
            aria-selected={tab === id}
            aria-controls={"batch-panel-" + id}
            variant={tab === id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab(id!)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const ids = ["brief", "tasks", "results"],
                  next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : 2)) % 3]!;
                setTab(next);
                document.getElementById("batch-tab-" + next)?.focus();
              }
            }}
          >
            {tr(label!)}
            {id === "brief" && pending ? " (" + pending + ")" : ""}
          </Button>
        ))}
      </div>
      {batch.archived && (
        <p className="border-b px-4 py-2 text-ui-sm text-muted-foreground">
          {tr("This batch is archived. Restore it to generate more images.")}
        </p>
      )}
      {tab === "brief" && (
        <div
          role="tabpanel"
          id="batch-panel-brief"
          aria-labelledby="batch-tab-brief"
          className="flex min-h-0 flex-1 flex-col overflow-auto"
        >
          <BatchProposals
            batch={batch}
            onError={onError}
            onApplied={(state, review) => {
              setTab("tasks");
              if (review) setReviewVersion(state.version);
            }}
          />
          {(batch.sources.length > 0 || !!batch.sourceReports?.length) && (
            <details className="shrink-0 border-b p-4 text-ui-sm">
              <summary className="cursor-pointer">
                {tr("Source snapshots")} ({batch.sources.length})
              </summary>
              <p className="my-2 text-muted-foreground">
                {tr(
                  "Uploaded files are retained independently. The AI response reports which files were read and any failures.",
                )}
              </p>
              {batch.sources.map((s) => {
                const report = batch.sourceReports?.find((report) => report.sourceId === s.id);
                return (
                  <div className="mt-2 break-words" key={s.id}>
                    <p>
                      {s.name} · {Math.ceil(s.bytes / 1024)} KiB ·{" "}
                      {tr(
                        report?.status === "read"
                          ? "AI reported read"
                          : report?.status === "failed"
                            ? "Read failed"
                            : "Attached; not yet reported read",
                      )}
                    </p>
                    {report?.message && <p className="text-muted-foreground">{report.message}</p>}
                  </div>
                );
              })}
              {batch.sourceReports
                ?.filter(
                  (report) =>
                    report.status === "failed" &&
                    !batch.sources.some((source) => source.id === report.sourceId),
                )
                .map((report) => (
                  <p key={report.sourceId} role="alert" className="mt-2 text-destructive">
                    {tr("Read failed")}: {report.message}
                  </p>
                ))}
            </details>
          )}
          {batch.sourceThreadId && (
            <Button
              variant="ghost"
              size="sm"
              className="m-2 self-start"
              onClick={() =>
                void navigate({ to: "/$threadId", params: { threadId: batch.sourceThreadId! } })
              }
            >
              {tr("Open source conversation")}
            </Button>
          )}
          <BatchChat batch={batch} onError={onError} />
        </div>
      )}
      {tab === "tasks" && (
        <div
          role="tabpanel"
          id="batch-panel-tasks"
          aria-labelledby="batch-tab-tasks"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex flex-wrap gap-2 border-b p-3">
            <Button
              size="sm"
              disabled={busy || batch.tasks.length >= 100}
              onClick={() =>
                setEditor({
                  base: structuredClone(batch),
                  task: {
                    id: crypto.randomUUID(),
                    name: tr("New image task"),
                    prompt: "",
                    enabled: true,
                    references: [],
                    sourceIds: [],
                  },
                })
              }
            >
              {tr("Add task")}
            </Button>
            {selected.length > 0 && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      saveTasks(
                        batch.tasks.map((t) =>
                          selected.includes(t.id) ? { ...t, enabled: true } : t,
                        ),
                      ),
                    )
                  }
                >
                  {tr("Enable selected")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      saveTasks(
                        batch.tasks.map((t) =>
                          selected.includes(t.id) ? { ...t, enabled: false } : t,
                        ),
                      ),
                    )
                  }
                >
                  {tr("Disable selected")}
                </Button>
                <Input
                  className="w-16"
                  type="number"
                  min={1}
                  max={10}
                  aria-label={tr("Images per selected task")}
                  value={bulkCount}
                  onChange={(e) => setBulkCount(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !Number.isInteger(Number(bulkCount)) ||
                    Number(bulkCount) < 1 ||
                    Number(bulkCount) > 10
                  }
                  onClick={() =>
                    action(() =>
                      saveTasks(
                        batch.tasks.map((t) =>
                          selected.includes(t.id)
                            ? {
                                ...t,
                                parameters: {
                                  ...imageBatchTaskConfiguration(t, batch.defaults).parameters,
                                  n: Number(bulkCount),
                                },
                              }
                            : t,
                        ),
                      ),
                    )
                  }
                >
                  {tr("Set image count")}
                </Button>
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!batch.tasks.length && (
              <div className="space-y-3 py-10 text-center text-ui text-muted-foreground">
                <p>{tr("No tasks yet. Add a task or ask AI to prepare a task proposal.")}</p>
                <Button variant="outline" onClick={() => setTab("brief")}>
                  {tr("Open requirements")}
                </Button>
              </div>
            )}
            {batch.tasks.length > 0 && (
              <label className="mb-2 flex items-center gap-2 text-ui-xs">
                <Checkbox
                  checked={selected.length === batch.tasks.length}
                  onCheckedChange={(v) => setSelected(v ? batch.tasks.map((t) => t.id) : [])}
                />
                {tr("Select all tasks")} ({selected.length})
              </label>
            )}
            {batch.tasks.map((t, index) => {
              const c = imageBatchTaskConfiguration(t, batch.defaults);
              return (
                <div
                  key={t.id}
                  ref={t.id === taskId ? focusTask : undefined}
                  tabIndex={t.id === taskId ? 0 : undefined}
                  className="flex flex-wrap items-start gap-3 border-b px-2 py-3 text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Checkbox
                    aria-label={tr("Select task") + ": " + t.name}
                    checked={selected.includes(t.id)}
                    onCheckedChange={(v) =>
                      setSelected(v ? [...selected, t.id] : selected.filter((id) => id !== t.id))
                    }
                  />
                  <div className="min-w-0 flex-1 basis-48">
                    <button
                      type="button"
                      className="max-w-full truncate text-left font-medium underline-offset-4 hover:underline focus-visible:outline-ring"
                      onClick={() =>
                        setEditor({ task: structuredClone(t), base: structuredClone(batch) })
                      }
                    >
                      {index + 1}. {t.name}
                    </button>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-ui-sm text-muted-foreground">
                      {t.prompt || tr("No prompt")}
                    </p>
                    <p className="mt-1 text-ui-xs text-muted-foreground">
                      {c.model || tr("No model")} · {c.parameters.n} {tr("images")} ·{" "}
                      {t.references.length} {tr("references")}
                      {hasStyle && " · " + tr("Uses batch style")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <label className="mr-2 flex items-center gap-1 text-ui-xs">
                      <Checkbox
                        disabled={busy}
                        checked={t.enabled}
                        onCheckedChange={(v) =>
                          action(() =>
                            saveTasks(
                              batch.tasks.map((x) =>
                                x.id === t.id ? { ...x, enabled: v === true } : x,
                              ),
                            ),
                          )
                        }
                      />
                      {tr("Enabled")}
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={tr("Move task up") + ": " + t.name}
                      disabled={busy || index === 0}
                      onClick={() =>
                        action(() => {
                          const next = [...batch.tasks];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          return saveTasks(next);
                        })
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={tr("Move task down") + ": " + t.name}
                      disabled={busy || index === batch.tasks.length - 1}
                      onClick={() =>
                        action(() => {
                          const next = [...batch.tasks];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          return saveTasks(next);
                        })
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || batch.tasks.length >= 100}
                      onClick={() =>
                        action(() =>
                          saveTasks([
                            ...batch.tasks.slice(0, index + 1),
                            {
                              ...structuredClone(t),
                              id: crypto.randomUUID(),
                              name: tr("{name} copy").replace("{name}", t.name),
                            },
                            ...batch.tasks.slice(index + 1),
                          ]),
                        )
                      }
                    >
                      {tr("Duplicate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          if (
                            await confirmDialog({
                              title: tr('Remove task "{name}"?').replace("{name}", t.name),
                              description: tr(
                                "The task leaves the draft. Images it already generated are kept in the results.",
                              ),
                              confirmLabel: tr("Remove"),
                              destructive: true,
                            })
                          ) {
                            await saveTasks(batch.tasks.filter((x) => x.id !== t.id));
                            setSelected(selected.filter((id) => id !== t.id));
                          }
                        })
                      }
                    >
                      {tr("Remove")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="max-h-[45%] shrink-0 overflow-auto">
            <BatchExecution
              batch={batch}
              onError={onError}
              reviewVersion={reviewVersion}
              onReviewOpened={() => setReviewVersion(null)}
            />
          </div>
        </div>
      )}
      {tab === "results" && (
        <div
          role="tabpanel"
          id="batch-panel-results"
          aria-labelledby="batch-tab-results"
          className="flex min-h-0 flex-1 flex-col"
        >
          <BatchResults batch={batch} focusResultId={resultId} onError={onError} />
        </div>
      )}
      {editor && (
        <BatchTaskEditor
          task={editor.task}
          defaults={editor.base.defaults}
          sources={batch.sources}
          providers={providers.data ?? []}
          onClose={() => setEditor(null)}
          onError={onError}
          onReloadBase={async () => {
            const latest = await batchApi().get({ id: batch.id });
            const previous = editor.base.tasks.find((task) => task.id === editor.task.id),
              current = latest.tasks.find((task) => task.id === editor.task.id);
            if (
              JSON.stringify(previous) !== JSON.stringify(current) &&
              !(await confirmDialog({
                title: tr("This task changed elsewhere"),
                description: tr(
                  "Keep your local edit and overwrite this task on the latest draft? Other tasks keep their latest version.",
                ),
                confirmLabel: tr("Keep my edit"),
              }))
            )
              return;
            setEditor({ ...editor, base: latest });
          }}
          onSave={async (task) => {
            const base = editor.base;
            await saveTasks(
              base.tasks.some((t) => t.id === task.id)
                ? base.tasks.map((t) => (t.id === task.id ? task : t))
                : [...base.tasks, task],
              base,
            );
          }}
        />
      )}
      {configuration && (
        <BatchConfiguration
          batch={configuration}
          onClose={() => setConfiguration(null)}
          onError={onError}
        />
      )}
    </>
  );
}

function BatchConfiguration({
  batch,
  onClose,
  onError,
}: {
  batch: ImageBatchState;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useBatchCommand(),
    providers = useImageProviders();
  const [draft, setDraft] = useState(batch),
    [busy, setBusy] = useState(false);
  const [base, setBase] = useState(batch),
    [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tr("Batch settings")}</DialogTitle>
          <DialogDescription>
            {tr(
              "Defaults apply to tasks without an override. Confirmed executions keep their frozen parameters.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70dvh] space-y-4 overflow-auto p-4 text-ui">
          <label className="block space-y-1">
            <span>{tr("Batch name")}</span>
            <Input
              maxLength={200}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="block space-y-1">
            <span>{tr("Requirement brief")}</span>
            <Textarea
              rows={4}
              maxLength={32000}
              value={draft.brief}
              onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
            />
          </label>
          <DrawingModelPicker
            providers={providers.data ?? []}
            providerId={draft.defaults.providerId}
            model={draft.defaults.model}
            onChange={(providerId, model) =>
              setDraft({ ...draft, defaults: { ...draft.defaults, providerId, model } })
            }
            onSettings={() =>
              void navigate({ to: "/settings", search: { section: "imageProviders" } })
            }
          />
          <DrawingParameters
            parameters={draft.defaults.parameters}
            onChange={(patch) =>
              setDraft({
                ...draft,
                defaults: {
                  ...draft.defaults,
                  parameters: { ...draft.defaults.parameters, ...patch },
                },
              })
            }
          />
          <section className="space-y-3 border-t pt-4">
            <div>
              <h3 className="font-medium">{tr("Batch style")}</h3>
              <p className="text-ui-sm text-muted-foreground">
                {tr(
                  "Applied before every task prompt when you confirm generation. Leave empty to use task prompts only.",
                )}
              </p>
            </div>
            <label className="block space-y-1">
              <span>{tr("Style description")}</span>
              <Textarea
                rows={3}
                maxLength={IMAGE_BATCH_MAX_STYLE_PROMPT}
                value={draft.defaults.stylePrompt ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    defaults: { ...draft.defaults, stylePrompt: e.target.value },
                  })
                }
              />
            </label>
            <BatchReferenceList
              title={tr("Style reference images")}
              references={draft.defaults.styleReferences ?? []}
              sources={batch.sources}
              max={IMAGE_BATCH_MAX_STYLE_REFERENCES}
              disabled={busy}
              onChange={(styleReferences) =>
                setDraft((current) => ({
                  ...current,
                  defaults: { ...current.defaults, styleReferences },
                }))
              }
              onBusy={setBusy}
              onError={(cause) => setError(cause instanceof Error ? cause.message : String(cause))}
            />
          </section>
          {!providers.data?.length && (
            <p className="text-ui-sm text-muted-foreground">
              {tr("Configure an image channel before generation.")}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="px-4 pb-3 text-ui-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t p-4">
          {error && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void batchApi()
                  .get({ id: batch.id })
                  .then(async (latest) => {
                    if (
                      JSON.stringify({
                        name: base.name,
                        brief: base.brief,
                        defaults: base.defaults,
                      }) !==
                        JSON.stringify({
                          name: latest.name,
                          brief: latest.brief,
                          defaults: latest.defaults,
                        }) &&
                      !(await confirmDialog({
                        title: tr("Batch settings changed elsewhere"),
                        description: tr("Keep your local settings and use the latest task list?"),
                        confirmLabel: tr("Keep my settings"),
                      }))
                    )
                      return;
                    setBase(latest);
                    setDraft({
                      ...latest,
                      name: draft.name,
                      brief: draft.brief,
                      defaults: draft.defaults,
                    });
                    setError(null);
                  })
                  .catch((cause) =>
                    setError(tr(cause instanceof Error ? cause.message : String(cause))),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {tr("Reload base; keep my edits")}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button
            disabled={busy || !draft.name.trim()}
            onClick={() => {
              setBusy(true);
              void command({
                operation: "save",
                batchId: draft.id,
                version: base.version,
                name: draft.name,
                brief: draft.brief,
                defaults: draft.defaults,
                tasks: draft.tasks,
              })
                .then(onClose)
                .catch((cause) => {
                  setError(tr(cause instanceof Error ? cause.message : String(cause)));
                  onError(cause);
                })
                .finally(() => setBusy(false));
            }}
          >
            {tr("Save draft")}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
