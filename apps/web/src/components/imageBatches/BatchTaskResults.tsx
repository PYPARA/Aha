import { useState } from "react";
import {
  imageBatchMissingCount,
  type ImageBatchResult,
  type ImageBatchState,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { PreviewSurface } from "../ui/preview-surface";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { imageUrl } from "../drawing/useDrawing";
import { ReferenceTargetDialog } from "./BatchReferenceTargets";
import { TaskStatus, attemptInFlight, latestTaskAttempts } from "./BatchTaskStatus";
import { outputGroup, resultFileNames, resultSizeMismatch } from "./resultNames";
import { useBatchCommand, useBatchResults } from "./useImageBatches";

/**
 * One task's candidates beside the task list, so checking a result does not leave the list.
 * Regenerating uses the task's current settings; filling missing images reuses the last attempt.
 */
export function BatchTaskResults({
  batch,
  taskId,
  onClose,
  onEdit,
  onRegenerate,
  onFillMissing,
  onOpenAll,
  onError,
}: {
  batch: ImageBatchState;
  taskId: string | null;
  onClose: () => void;
  onEdit: (taskId: string) => void;
  onRegenerate: (taskId: string) => void;
  onFillMissing: (attemptId: string) => void;
  onOpenAll: (taskId: string) => void;
  onError: (cause: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const [referenceFor, setReferenceFor] = useState<ImageBatchResult[] | null>(null);
  const task = batch.tasks.find((t) => t.id === taskId);
  const page = useBatchResults({ batchId: batch.id, ...(taskId ? { taskId } : {}) });
  const results = taskId ? (page.data?.pages.flatMap((p) => p.results) ?? []) : [];
  const names = resultFileNames(results);
  const attempt = taskId ? latestTaskAttempts(batch).get(taskId) : undefined;
  const missing = attempt ? imageBatchMissingCount(batch, attempt) : 0;
  const idle =
    !batch.executions.some((e) => !e.finishedAt) && !(attempt && attemptInFlight(attempt.status));
  const group = outputGroup(task?.output);
  return (
    <Sheet open={!!taskId} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" className="w-full max-w-md">
        <SheetTitle className="border-b p-4 text-ui font-medium">
          {task?.name ?? tr("Task")}
        </SheetTitle>
        {task && (
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-ui-sm">
            <div className="space-y-1">
              <TaskStatus attempt={attempt} />
              {task.output && <p className="text-ui-xs text-muted-foreground">{task.output}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!idle} onClick={() => onRegenerate(task.id)}>
                {tr("Regenerate")}
              </Button>
              {attempt && missing > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!idle}
                  onClick={() => onFillMissing(attempt.id)}
                >
                  {tr("Fill missing images")} ({missing})
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onEdit(task.id)}>
                {tr("Edit task")}
              </Button>
            </div>
            <p className="text-ui-xs text-muted-foreground">
              {tr(
                "Regenerate uses the task's current prompt and settings. Edit the task first to change them.",
              )}
            </p>
            {page.isPending ? (
              <p role="status">{tr("Loading...")}</p>
            ) : !results.length ? (
              <p className="text-muted-foreground">{tr("No image results in this view.")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {results.map((r) => (
                  <div key={r.id} className="min-w-0 space-y-1">
                    <PreviewSurface checker className="aspect-square w-full rounded-md">
                      <img
                        src={imageUrl(r.asset, "thumbnail")}
                        alt={r.taskName}
                        className="h-full w-full object-contain"
                      />
                    </PreviewSurface>
                    <p className="truncate">
                      {r.output ? names.get(r.id)?.name : `${r.taskName} · ${r.position + 1}`}
                    </p>
                    <p className="truncate text-ui-xs text-muted-foreground">
                      {r.asset.width}×{r.asset.height}
                      {r.adopted && " · " + tr("Adopted")}
                    </p>
                    {resultSizeMismatch(r) && (
                      <p className="truncate text-ui-xs text-warning">
                        {tr("Requested {size}").replace("{size}", resultSizeMismatch(r)!)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="xs"
                        variant={r.adopted ? "secondary" : "outline"}
                        onClick={() =>
                          void command({
                            operation: "adopt",
                            batchId: batch.id,
                            resultIds: [r.id],
                            adopted: !r.adopted,
                            exclusive: !r.adopted,
                          }).catch(onError)
                        }
                      >
                        {tr(r.adopted ? "Unmark adopted" : "Mark adopted")}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setReferenceFor([r])}>
                        {tr("Use as reference")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {page.hasNextPage && (
              <Button
                size="sm"
                variant="ghost"
                disabled={page.isFetchingNextPage}
                onClick={() => void page.fetchNextPage()}
              >
                {tr("Load more")}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onOpenAll(task.id)}>
              {tr("Open in Generated results")}
            </Button>
          </div>
        )}
        {referenceFor && task && (
          <ReferenceTargetDialog
            batch={batch}
            results={referenceFor}
            initialTaskIds={
              group
                ? batch.tasks
                    .filter((t) => t.id !== task.id && outputGroup(t.output) === group)
                    .map((t) => t.id)
                : []
            }
            onClose={() => setReferenceFor(null)}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}
