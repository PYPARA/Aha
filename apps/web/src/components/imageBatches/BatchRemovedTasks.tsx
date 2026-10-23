import { useState } from "react";
import { imageBatchRemovedTasks, type ImageBatchState } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { confirmDialog } from "../ui/confirm-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { outputGroup } from "./resultNames";
import { useBatchCommand } from "./useImageBatches";

/** Brings removed tasks back at their old positions; they return disabled unless chosen otherwise. */
export function BatchRemovedTasks({
  batch,
  onClose,
}: {
  batch: ImageBatchState;
  onClose: () => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const removed = imageBatchRemovedTasks(batch);
  const [selected, setSelected] = useState(() => removed.map((r) => r.task.id));
  const [keepDisabled, setKeepDisabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = [...new Set(removed.map((r) => outputGroup(r.task.output)))].map((id) => ({
    id,
    items: removed.filter((r) => outputGroup(r.task.output) === id),
  }));
  const save = (tasks: ImageBatchState["tasks"]) =>
    command({
      operation: "save",
      batchId: batch.id,
      version: batch.version,
      name: batch.name,
      brief: batch.brief,
      defaults: batch.defaults,
      tasks,
    });
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void action()
      .then(onClose)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const restore = async () => {
    const next = [...batch.tasks];
    for (const { task, index } of removed
      .filter((r) => selected.includes(r.task.id))
      .toSorted((a, b) => a.index - b.index))
      next.splice(Math.min(index, next.length), 0, {
        ...task,
        enabled: keepDisabled ? false : task.enabled,
      });
    await save(next);
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
          <DialogTitle>{tr("Restore removed tasks")}</DialogTitle>
          <DialogDescription>
            {tr(
              "{count} tasks were removed from the task list. Restored tasks return to their earlier positions.",
            ).replace("{count}", String(removed.length))}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui">
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={selected.length === removed.length && removed.length > 0}
              disabled={busy}
              onCheckedChange={(v) => setSelected(v ? removed.map((r) => r.task.id) : [])}
            />
            {tr("Select all tasks")} ({selected.length})
          </label>
          <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
            {groups.map((group) => (
              <div key={group.id}>
                {groups.length > 1 && (
                  <label className="flex items-center gap-2 py-1 text-ui-sm font-medium">
                    <Checkbox
                      checked={group.items.every((r) => selected.includes(r.task.id))}
                      disabled={busy}
                      onCheckedChange={(v) =>
                        setSelected(
                          v
                            ? [...new Set([...selected, ...group.items.map((r) => r.task.id)])]
                            : selected.filter((id) => !group.items.some((r) => r.task.id === id)),
                        )
                      }
                    />
                    {group.id || tr("Ungrouped")}
                    <span className="text-ui-xs font-normal text-muted-foreground">
                      {group.items.length}
                    </span>
                  </label>
                )}
                {group.items.map(({ task }) => (
                  <label
                    key={task.id}
                    className={
                      "flex items-center gap-2 py-1 text-ui-sm" + (groups.length > 1 ? " pl-6" : "")
                    }
                  >
                    <Checkbox
                      checked={selected.includes(task.id)}
                      disabled={busy}
                      onCheckedChange={(v) =>
                        setSelected(
                          v ? [...selected, task.id] : selected.filter((id) => id !== task.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{task.name}</span>
                    {task.output && (
                      <span className="truncate text-ui-xs text-muted-foreground">
                        {task.output}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={keepDisabled}
              disabled={busy}
              onCheckedChange={(v) => setKeepDisabled(v === true)}
            />
            {tr("Restore as disabled")}
          </label>
          {error && (
            <p role="alert" className="text-ui-sm text-destructive">
              {tr(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="mr-auto"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (
                  await confirmDialog({
                    title: tr("Clear removed tasks?"),
                    description: tr(
                      "They can no longer be restored. Images they already generated stay in the results.",
                    ),
                    confirmLabel: tr("Clear"),
                    destructive: true,
                  })
                )
                  await command({
                    operation: "clear-removed-tasks",
                    batchId: batch.id,
                    version: batch.version,
                  });
              })
            }
          >
            {tr("Clear list")}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={busy || !selected.length} onClick={() => run(restore)}>
            {tr("Restore selected")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
