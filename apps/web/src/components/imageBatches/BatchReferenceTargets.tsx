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
import { OptionSelect } from "../ui/option-select";
import { SearchInput } from "../ui/search-input";
import { outputGroup } from "./resultNames";
import { useBatchCommand } from "./useImageBatches";
import { IMAGE_BATCH_MAX_STYLE_REFERENCES } from "@synara/contracts";

/**
 * Adds selected results as references: to chosen tasks (the second round of a staged batch), or to
 * the batch style so every task gets them. The scope is an explicit choice in the dialog.
 */
export function ReferenceTargetDialog({
  batch,
  results,
  initialTaskIds = [],
  onClose,
}: {
  batch: ImageBatchState;
  results: readonly ImageBatchResult[];
  /** Tasks ticked when the dialog opens, e.g. the rest of an adopted sample's folder. */
  initialTaskIds?: readonly string[];
  onClose: () => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const [scope, setScope] = useState<"tasks" | "style">("tasks");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = batch.tasks.filter(
    (t) => !needle || (t.name + " " + (t.output ?? "")).toLowerCase().includes(needle),
  );
  const groups = [...new Set(shown.map((t) => outputGroup(t.output)))].map((id) => ({
    id,
    tasks: shown.filter((t) => outputGroup(t.output) === id),
  }));
  const [selected, setSelected] = useState<string[]>(() => [...initialTaskIds]);
  const [enable, setEnable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = 16 - (batch.defaults.styleReferences?.length ?? 0);
  const assetIds = [...new Set(results.map((r) => r.asset.id))];
  const apply = async () => {
    if (scope === "style") {
      const current = batch.defaults.styleReferences ?? [];
      const added = assetIds
        .filter((id) => !current.some((r) => r.assetId === id))
        .map((assetId) => ({ id: crypto.randomUUID(), assetId, documentId: null }));
      if (current.length + added.length > IMAGE_BATCH_MAX_STYLE_REFERENCES)
        throw new Error(
          tr("At most {count} reference images are allowed.").replace(
            "{count}",
            String(IMAGE_BATCH_MAX_STYLE_REFERENCES),
          ),
        );
      await command({
        operation: "save",
        batchId: batch.id,
        version: batch.version,
        name: batch.name,
        brief: batch.brief,
        defaults: { ...batch.defaults, styleReferences: [...current, ...added] },
        tasks: batch.tasks,
      });
      return;
    }
    const tasks = batch.tasks.map((task) => {
      if (!selected.includes(task.id)) return task;
      const added = assetIds
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
              scope === "style"
                ? "{count} images will be added to the batch style reference images."
                : "{count} images will be added to the reference images of the chosen tasks.",
            ).replace("{count}", String(results.length))}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui">
          <div className="w-64">
            <OptionSelect
              label={tr("Reference scope")}
              value={scope}
              disabled={busy}
              onValueChange={(v) => setScope(v as typeof scope)}
            >
              <option value="tasks">{tr("Chosen tasks only")}</option>
              <option value="style">{tr("Batch style (every task)")}</option>
            </OptionSelect>
          </div>
          {scope === "style" ? (
            <p className="text-ui-sm text-muted-foreground">
              {tr(
                "Added to the batch style reference images. At confirmation they are placed before every task's own references, including tasks added later.",
              )}
            </p>
          ) : (
            <>
              <SearchInput
                aria-label={tr("Search tasks")}
                placeholder={tr("Search tasks")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
                {groups.map((group) => (
                  <div key={group.id}>
                    {groups.length > 1 && (
                      <label className="flex items-center gap-2 py-1 text-ui-sm font-medium">
                        <Checkbox
                          checked={group.tasks.every((t) => selected.includes(t.id))}
                          disabled={busy}
                          onCheckedChange={(v) =>
                            setSelected(
                              v
                                ? [...new Set([...selected, ...group.tasks.map((t) => t.id)])]
                                : selected.filter((id) => !group.tasks.some((t) => t.id === id)),
                            )
                          }
                        />
                        {group.id || tr("Ungrouped")}
                        <span className="text-ui-xs font-normal text-muted-foreground">
                          {group.tasks.length}
                        </span>
                      </label>
                    )}
                    {group.tasks.map((task) => (
                      <label
                        key={task.id}
                        className={
                          "flex items-center gap-2 py-1 text-ui-sm" +
                          (groups.length > 1 ? " pl-6" : "")
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
                        <span className="min-w-0 flex-1 truncate">
                          {batch.tasks.indexOf(task) + 1}. {task.name}
                        </span>
                        <span className="text-ui-xs text-muted-foreground">
                          {task.references.length} {tr("references")}
                          {!task.enabled && " · " + tr("Disabled")}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <p className="text-ui-xs text-muted-foreground">
                {tr("Selected")}: {selected.length}
              </p>
              <label className="flex items-center gap-2 text-ui-sm">
                <Checkbox
                  checked={enable}
                  disabled={busy}
                  onCheckedChange={(v) => setEnable(v === true)}
                />
                {tr("Enable the chosen tasks")}
              </label>
            </>
          )}
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
            disabled={busy || (scope === "tasks" && !selected.length)}
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
