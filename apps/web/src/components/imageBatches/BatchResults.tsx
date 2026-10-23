import { useEffect, useRef, useState } from "react";
import type { ImageBatchResult, ImageBatchState } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { confirmDialog } from "../ui/confirm-dialog";
import { OptionSelect } from "../ui/option-select";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { PreviewSurface } from "../ui/preview-surface";
import { imageUrl, drawingApi } from "../drawing/useDrawing";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import {
  fetchImageFile,
  sendFilesToTarget,
  TransferTargetDialog,
} from "../resources/transferTargets";
import { useBatchCommand, useBatchResults } from "./useImageBatches";
import { ReferenceTargetDialog } from "./BatchReferenceTargets";
import { outputGroup, resultFileNames, resultSizeMismatch } from "./resultNames";
import {
  collectResources,
  resourceApi,
  resourceKey,
  useResourceLibrary,
} from "../resources/resourceLibrary";
import {
  emptyResourceSelection,
  selectResource,
  reconcileResourceSelection,
} from "../resources/resourceSelection";
import type { ResourceLocateResult, ResourceLinkState } from "@synara/contracts/resourceLibrary";

export function BatchResults({
  batch,
  focusResultId,
  initialTaskId = "",
  onError,
  readOnly = false,
}: {
  batch: ImageBatchState;
  focusResultId?: string | undefined;
  /** Opens filtered to one task, e.g. from a task row's thumbnail. */
  initialTaskId?: string;
  onError: (e: unknown) => void;
  readOnly?: boolean;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useBatchCommand();
  const [filter, setFilter] = useState<"all" | "adopted" | "unadopted" | "uncollected">("all");
  const [taskId, setTaskId] = useState(initialTaskId);
  const [selection, setSelection] = useState(emptyResourceSelection);
  const [multiple, setMultiple] = useState(false);
  const [spriteTarget, setSpriteTarget] = useState(false);
  const [preview, setPreview] = useState<ImageBatchResult[]>([]);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const focusedLink = useRef<string | null>(null);
  const page = useBatchResults({ batchId: batch.id, filter, ...(taskId ? { taskId } : {}) });
  const results = page.data?.pages.flatMap((p) => p.results) ?? [];
  const collected = results.filter((result) => result.collection);
  const library = useResourceLibrary(!!collected.length);
  const links = useQuery({
    queryKey: [
      ...resourceKey,
      "batch-results",
      batch.id,
      collected.map((result) => result.id),
      library.data?.revision,
    ],
    enabled: !!window.desktopBridge?.resourceLibrary && !!collected.length,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          collected.map(
            async (result) =>
              [
                result.id,
                await resourceApi<ResourceLinkState>({
                  op: "resourceState",
                  libraryId: result.collection!.libraryId,
                  id: result.collection!.resourceId,
                }),
              ] as const,
          ),
        ),
      ),
    retry: false,
  });
  // Results follow the task list: task order, grouped by the first folder of the output path.
  const order = new Map(batch.tasks.map((t, i) => [t.id, i]));
  const sorted = results.toSorted(
    (a, b) =>
      (order.get(a.taskId) ?? Infinity) - (order.get(b.taskId) ?? Infinity) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.attemptId.localeCompare(b.attemptId) ||
      a.position - b.position,
  );
  const foldered = sorted.some((r) => outputGroup(r.output));
  const groups = foldered
    ? [...new Set(sorted.map((r) => outputGroup(r.output)))].map((id) => ({
        id,
        results: sorted.filter((r) => outputGroup(r.output) === id),
      }))
    : [{ id: "", results: sorted }];
  const visibleIds = groups.flatMap((group) => group.results.map((result) => result.id));
  useEffect(() => {
    setSelection((previous) => reconcileResourceSelection(previous, visibleIds));
  }, [visibleIds.join(",")]);
  const chosen = results.filter((r) => selection.ids.includes(r.id));
  // Names come from the whole view, so the name on a card is the name that is exported.
  const names = resultFileNames(results);
  const [referenceFor, setReferenceFor] = useState<ImageBatchResult[] | null>(null);
  const [adoptedOffer, setAdoptedOffer] = useState<{
    result: ImageBatchResult;
    taskIds: string[];
  } | null>(null);
  const adopt = (values: ImageBatchResult[], adopted: boolean) =>
    perform(async () => {
      await command({
        operation: "adopt",
        batchId: batch.id,
        resultIds: values.map((r) => r.id),
        adopted,
      });
      // After adopting a sample, offer it as the reference for the rest of its output folder.
      const sample = values.length === 1 && adopted ? values[0]! : null;
      const group = sample ? outputGroup(sample.output) : "";
      const taskIds = group
        ? batch.tasks
            .filter((t) => t.id !== sample!.taskId && outputGroup(t.output) === group)
            .filter((t) => !t.references.some((ref) => ref.assetId === sample!.asset.id))
            .map((t) => t.id)
        : [];
      setAdoptedOffer(sample && !readOnly ? { result: sample, taskIds } : null);
    });
  useEffect(() => {
    setSelection(emptyResourceSelection());
  }, [filter, taskId]);
  useEffect(() => {
    if (focusedLink.current === focusResultId) return;
    if (focusResultId && results.some((r) => r.id === focusResultId)) {
      focusedLink.current = focusResultId;
      setSelection({ ids: [focusResultId], focusedId: focusResultId, anchorId: focusResultId });
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-batch-result="${CSS.escape(focusResultId)}"]`)
          ?.scrollIntoView({ block: "center" }),
      );
    } else if (focusResultId && page.hasNextPage && !page.isFetchingNextPage)
      void page.fetchNextPage();
  }, [
    focusResultId,
    results.length,
    page.hasNextPage,
    page.isFetchingNextPage,
    page.fetchNextPage,
  ]);
  const perform = (run: () => Promise<unknown>) => void run().catch(onError);
  const showPreview = (values: ImageBatchResult[], trigger: HTMLElement) => {
    previewTrigger.current = trigger;
    setPreview(values);
  };
  const collect = () => {
    collectResources(
      chosen.map((r) => ({
        ...names.get(r.id)!,
        url: imageUrl(r.asset),
        assetId: r.asset.id,
        origin: {
          kind: "image-batch",
          batchId: r.batchId,
          taskId: r.taskId,
          attemptId: r.attemptId,
          resultId: r.id,
          jobId:
            batch.executions.flatMap((e) => e.attempts).find((a) => a.id === r.attemptId)?.jobId ??
            undefined,
          prompt: r.prompt,
          model: r.model,
          parameters: { ...r.parameters },
        },
      })),
    );
  };
  const useInDrawing = async (r: ImageBatchResult) => {
    const id = sessionStorage.getItem("drawing:window:v1") ?? crypto.randomUUID();
    sessionStorage.setItem("drawing:window:v1", id);
    const existing = await drawingApi().getDraft({ id });
    if (existing && (existing.prompt.trim() || existing.inputAssetIds.length)) {
      if (
        !(await confirmDialog({
          title: tr("Replace the drawing draft?"),
          description: tr(
            "The current drawing prompt and reference images are replaced by this result. The batch result itself is kept.",
          ),
          confirmLabel: tr("Replace draft"),
        }))
      )
        return;
    }
    const attempt = batch.executions.flatMap((e) => e.attempts).find((a) => a.id === r.attemptId);
    await drawingApi().upsertDraft({
      id,
      prompt: r.prompt,
      providerId: attempt?.providerId ?? null,
      model: r.model,
      parameters: { ...r.parameters, n: 1 },
      inputAssetIds: [r.asset.id],
      inputReferences: [{ id: crypto.randomUUID(), assetId: r.asset.id, documentId: null }],
      maskAssetId: null,
      updatedAt: new Date().toISOString(),
    });
    await navigate({ to: "/drawing" });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="w-36">
          <OptionSelect
            label={tr("Result filter")}
            value={filter}
            onValueChange={(v) => setFilter(v as typeof filter)}
          >
            <option value="all">{tr("All results")}</option>
            <option value="adopted">{tr("Adopted")}</option>
            <option value="unadopted">{tr("Not adopted")}</option>
            <option value="uncollected">{tr("Not collected")}</option>
          </OptionSelect>
        </div>
        <div className="w-44">
          <OptionSelect label={tr("Result task")} value={taskId} onValueChange={setTaskId}>
            <option value="">{tr("All tasks")}</option>
            {[
              ...new Map(
                batch.executions.flatMap((e) => e.attempts).map((a) => [a.taskId, a.taskName]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </OptionSelect>
        </div>
        <span className="text-ui-xs text-muted-foreground">
          {page.data?.pages[0]?.total ?? "—"} {tr("images")}
        </span>
        <Button
          size="sm"
          variant={multiple ? "secondary" : "outline"}
          onClick={() => setMultiple(!multiple)}
        >
          {tr("Multiple selection")}
        </Button>
      </div>
      {adoptedOffer && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-ui-sm"
        >
          <p className="min-w-0 flex-1">
            {adoptedOffer.taskIds.length
              ? tr("Use this sample as the reference for the other {count} tasks in {group}?")
                  .replace("{count}", String(adoptedOffer.taskIds.length))
                  .replace("{group}", outputGroup(adoptedOffer.result.output))
              : tr("Adopted. You can use it as a reference for later tasks.")}
          </p>
          {adoptedOffer.taskIds.length > 0 && (
            <Button
              size="sm"
              onClick={() =>
                perform(async () => {
                  const ids = adoptedOffer.taskIds;
                  const assetId = adoptedOffer.result.asset.id;
                  const max = 16 - (batch.defaults.styleReferences?.length ?? 0);
                  const full = batch.tasks.find(
                    (t) => ids.includes(t.id) && t.references.length >= max,
                  );
                  if (full)
                    throw new Error(
                      tr('"{name}" would exceed {count} reference images.')
                        .replace("{name}", full.name)
                        .replace("{count}", String(max)),
                    );
                  await command({
                    operation: "save",
                    batchId: batch.id,
                    version: batch.version,
                    name: batch.name,
                    brief: batch.brief,
                    defaults: batch.defaults,
                    tasks: batch.tasks.map((t) =>
                      ids.includes(t.id)
                        ? {
                            ...t,
                            enabled: true,
                            references: [
                              ...t.references,
                              { id: crypto.randomUUID(), assetId, documentId: null },
                            ],
                          }
                        : t,
                    ),
                  });
                  setAdoptedOffer(null);
                })
              }
            >
              {tr("Set as reference and enable")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReferenceFor([adoptedOffer.result])}
          >
            {tr("Choose tasks…")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdoptedOffer(null)}>
            {tr("Not now")}
          </Button>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelection(emptyResourceSelection());
        }}
      >
        {page.isPending ? (
          <p role="status" className="text-ui">
            {tr("Loading...")}
          </p>
        ) : page.isError ? (
          <p role="alert" className="text-ui text-destructive">
            {page.error.message}
            <Button variant="ghost" onClick={() => void page.refetch()}>
              {tr("Retry")}
            </Button>
          </p>
        ) : !results.length ? (
          <div className="py-12 text-center text-ui text-muted-foreground">
            {tr("No image results in this view.")}
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.id} className="mb-5 space-y-2">
            {foldered && (
              <h3 className="text-ui font-medium">
                {group.id || tr("Ungrouped")}{" "}
                <span className="text-ui-xs font-normal text-muted-foreground">
                  {group.results.length} {tr("images")}
                </span>
              </h3>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-3">
              {group.results.map((r) => (
                <div
                  key={r.id}
                  className={
                    "min-w-0 rounded-lg border " +
                    (selection.ids.includes(r.id)
                      ? "border-foreground/50 bg-muted"
                      : "border-transparent hover:bg-muted/50")
                  }
                >
                  <button
                    type="button"
                    aria-label={tr("Select result") + ": " + r.taskName + " " + (r.position + 1)}
                    aria-pressed={selection.ids.includes(r.id)}
                    data-batch-result={r.id}
                    className="w-full min-w-0 rounded-lg p-2 pb-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={(e) =>
                      setSelection(selectResource(selection, r.id, visibleIds, e, multiple))
                    }
                    onDoubleClick={(e) => showPreview([r], e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key === " ") {
                        e.preventDefault();
                        showPreview([r], e.currentTarget);
                      }
                      if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
                        e.preventDefault();
                        const index = visibleIds.indexOf(r.id),
                          next =
                            e.key === "Home"
                              ? visibleIds[0]
                              : e.key === "End"
                                ? visibleIds.at(-1)
                                : visibleIds[index + (e.key === "ArrowRight" ? 1 : -1)];
                        if (next) {
                          setSelection(selectResource(selection, next, visibleIds, e));
                          document
                            .querySelector<HTMLButtonElement>(
                              `[data-batch-result="${CSS.escape(next)}"]`,
                            )
                            ?.focus();
                        }
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
                        e.preventDefault();
                        setSelection({ ids: visibleIds, focusedId: r.id, anchorId: r.id });
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSelection(emptyResourceSelection());
                      }
                    }}
                  >
                    <PreviewSurface checker className="aspect-square w-full rounded-md">
                      <img
                        src={imageUrl(r.asset, "thumbnail")}
                        alt={r.taskName}
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    </PreviewSurface>
                    <span className="mt-2 block truncate text-ui-sm" title={r.taskName}>
                      {r.output ? names.get(r.id)?.name : `${r.taskName} · ${r.position + 1}`}
                    </span>
                    <span className="block truncate text-ui-xs text-muted-foreground">
                      {r.output && r.taskName + " · "}
                      {r.asset.width}×{r.asset.height}
                      {r.adopted && " · " + tr("Adopted")}
                    </span>
                    {resultSizeMismatch(r) && (
                      <span className="block truncate text-ui-xs text-warning">
                        {tr("Requested {size}").replace("{size}", resultSizeMismatch(r)!)}
                      </span>
                    )}
                    {r.collection && (
                      <span className="block text-ui-xs text-muted-foreground">
                        {tr(
                          links.data?.[r.id]?.status === "removed"
                            ? "Removed from resource center"
                            : links.data?.[r.id]?.status === "other-library"
                              ? "Collected in another library"
                              : links.data?.[r.id]?.status === "unavailable"
                                ? "Resource is unavailable"
                                : "Collected",
                        )}
                      </span>
                    )}
                  </button>
                  {!readOnly && (
                    // Visible, not hover-only: adopting and reusing a sample are the main next steps.
                    <div className="flex flex-wrap gap-1 px-2 pb-2">
                      <Button
                        size="xs"
                        variant={r.adopted ? "secondary" : "outline"}
                        aria-label={
                          tr(r.adopted ? "Unmark adopted" : "Mark adopted") + ": " + r.taskName
                        }
                        onClick={() => adopt([r], !r.adopted)}
                      >
                        {tr(r.adopted ? "Unmark adopted" : "Mark adopted")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={tr("Use as task reference") + ": " + r.taskName}
                        onClick={() => setReferenceFor([r])}
                      >
                        {tr("Use as reference")}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
        {page.hasNextPage && (
          <Button
            className="mt-4"
            variant="outline"
            disabled={page.isFetchingNextPage}
            onClick={() => void page.fetchNextPage()}
          >
            {tr("Load more")}
          </Button>
        )}
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t p-3 text-ui-xs">
          <span>
            {tr("Selected")}: {chosen.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => showPreview(chosen.slice(0, 2), e.currentTarget)}
          >
            {tr(chosen.length > 1 ? "Compare candidates" : "Preview")}
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => adopt(chosen, !chosen.every((r) => r.adopted))}
            >
              {tr(chosen.every((r) => r.adopted) ? "Unmark adopted" : "Mark adopted")}
            </Button>
          )}
          <Button size="sm" onClick={collect} disabled={!window.desktopBridge?.resourceLibrary}>
            {tr("Add to resource center")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              perform(async () => {
                for (const r of chosen)
                  await downloadUrlAsBlob({
                    url: imageUrl(r.asset),
                    filename: names.get(r.id)!.name,
                    credentials: "include",
                  });
              })
            }
          >
            {tr("Export selected")}
          </Button>
          {chosen.length === 1 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => perform(() => useInDrawing(chosen[0]!))}
            >
              {tr("Continue in drawing")}
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" variant="ghost" onClick={() => setReferenceFor(chosen)}>
              {tr("Use as task reference")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSpriteTarget(true)}>
            {tr("Use in sprite")}
          </Button>
        </div>
      )}
      {referenceFor && (
        <ReferenceTargetDialog
          batch={batch}
          results={referenceFor}
          initialTaskIds={
            adoptedOffer && referenceFor[0] === adoptedOffer.result ? adoptedOffer.taskIds : []
          }
          onClose={() => {
            setReferenceFor(null);
            setAdoptedOffer(null);
          }}
        />
      )}
      {spriteTarget && (
        <TransferTargetDialog
          module="sprite"
          count={chosen.length}
          onClose={() => setSpriteTarget(false)}
          onSend={async (target) =>
            sendFilesToTarget(
              navigate,
              target,
              await Promise.all(
                chosen.map((r) => fetchImageFile(imageUrl(r.asset), names.get(r.id)!.name)),
              ),
            )
          }
        />
      )}
      <Dialog
        open={preview.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setPreview([]);
            requestAnimationFrame(() => previewTrigger.current?.focus());
          }
        }}
      >
        <DialogPopup className={preview.length > 1 ? "max-w-5xl" : "max-w-3xl"}>
          <DialogHeader>
            <DialogTitle>
              {tr(preview.length > 1 ? "Compare candidates" : "Image result details")}
            </DialogTitle>
            <DialogDescription>
              {tr("Original results are retained in this batch.")}
            </DialogDescription>
          </DialogHeader>
          <div
            className={
              "grid max-h-[75dvh] gap-4 overflow-auto p-4 " +
              (preview.length > 1 ? "md:grid-cols-2" : "")
            }
          >
            {preview.map((r) => (
              <div key={r.id} className="min-w-0 space-y-3">
                <PreviewSurface checker className="h-72">
                  <img
                    src={imageUrl(r.asset)}
                    alt={r.taskName}
                    className="h-full w-full object-contain"
                  />
                </PreviewSurface>
                <h3 className="text-ui font-medium">
                  {r.taskName} · {r.position + 1}
                </h3>
                <p className="break-all text-ui-xs text-muted-foreground">
                  {r.model} · {r.asset.width}×{r.asset.height} ·{" "}
                  {new Date(r.createdAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap text-ui-sm">{r.prompt}</p>
                {r.collection && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      perform(async () => {
                        await resourceApi<ResourceLocateResult>({
                          op: "locate",
                          id: r.collection!.resourceId,
                        });
                        sessionStorage.setItem("aha:resource-locate", JSON.stringify(r.collection));
                        await navigate({ to: "/resources" });
                      })
                    }
                  >
                    {tr("Locate in resource center")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
