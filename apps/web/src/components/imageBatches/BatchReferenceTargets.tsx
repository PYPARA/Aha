import { useState } from "react";
import type { ImageBatchResult, ImageBatchState } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useBatchCommand } from "./useImageBatches";

/** Adds selected results as references to chosen tasks: the second round of a staged batch. */
export function ReferenceTargetDialog({
  batch,
  results,
  onClose,
}: {
  batch: ImageBatchState;
  results: readonly ImageBatchResult[];
  onClose: () => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const [selected, setSelected] = useState<string[]>([]);
  const [enable, setEnable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = 16 - (batch.defaults.styleReferences?.length ?? 0);
  const apply = async () => {
    const tasks = batch.tasks.map((task) => {
      if (!selected.includes(task.id)) return task;
      const added = results
        .map((r) => r.asset.id)
        .filter((id, i, all) => all.indexOf(id) === i)
        .filter((id) => !task.references.some((r) => r.assetId === id))
        .map((assetId) => ({ id: crypto.randomUUID(), assetId, documentId: null }));
      if (task.references.length + added.length > max)
        throw new Error(
          tr('"{name}" would exceed {count} reference images.')
            .replace("{name}", task.name)
            .replace("{count}", String(max)),
        );
      return {
        ...task,
        enabled: enable ? true : task.enabled,
        references: [...task.references, ...added],
      };
    });
    await command({
      operation: "save",
      batchId: batch.id,
      version: batch.version,
      name: batch.name,
      brief: batch.brief,
      defaults: batch.defaults,
      tasks,
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tr("Use as task reference")}</DialogTitle>
          <DialogDescription>
            {tr(
              "{count} images will be added to the reference images of the chosen tasks.",
            ).replace("{count}", String(results.length))}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui">
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={selected.length === batch.tasks.length && selected.length > 0}
              disabled={busy}
              onCheckedChange={(v) => setSelected(v ? batch.tasks.map((t) => t.id) : [])}
            />
            {tr("Select all tasks")} ({selected.length})
          </label>
          <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
            {batch.tasks.map((task, index) => (
              <label key={task.id} className="flex items-center gap-2 py-1 text-ui-sm">
                <Checkbox
                  checked={selected.includes(task.id)}
                  disabled={busy}
                  onCheckedChange={(v) =>
                    setSelected(
                      v ? [...selected, task.id] : selected.filter((id) => id !== task.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {index + 1}. {task.name}
                </span>
                <span className="text-ui-xs text-muted-foreground">
                  {task.references.length} {tr("references")}
                  {!task.enabled && " · " + tr("Disabled")}
                </span>
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={enable}
              disabled={busy}
              onCheckedChange={(v) => setEnable(v === true)}
            />
            {tr("Enable the chosen tasks")}
          </label>
          <p className="text-ui-xs text-muted-foreground">
            {tr("This only updates the draft. Nothing is generated until you confirm generation.")}
          </p>
          {error && (
            <p role="alert" className="text-ui-sm text-destructive">
              {tr(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => {
              setBusy(true);
              setError(null);
              void apply()
                .then(onClose)
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {tr("Add references")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
