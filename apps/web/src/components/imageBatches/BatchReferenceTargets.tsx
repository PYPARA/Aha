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
import { outputGroup, outputStem } from "./resultNames";
import { imageUrl } from "../drawing/useDrawing";
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
  // Matching by file name pairs each image with the same-named task in another folder, e.g.
  // heroes/ember.png → portraits/ember.png, so one selection fans out to the right tasks.
  const sourceFolders = new Set(results.map((r) => outputGroup(r.output)));
  const pairsFor = (folder: string) =>
    results
      .filter((r) => r.output)
      .map((result) => ({
        result,
        task: batch.tasks.find(
          (t) =>
            outputGroup(t.output) === folder && outputStem(t.output) === outputStem(result.output),
        ),
      }));
  const matchFolders = [...new Set(batch.tasks.map((t) => outputGroup(t.output)))]
    .filter((folder) => folder && !sourceFolders.has(folder))
    .map((folder) => ({ folder, count: pairsFor(folder).filter((p) => p.task).length }))
    .toSorted((a, b) => b.count - a.count);
  const [matchFolder, setMatchFolder] = useState(matchFolders[0]?.folder ?? "");
  const pairs = matchFolder ? pairsFor(matchFolder) : [];
  const [scope, setScope] = useState<"tasks" | "match" | "style">(() =>
    results.length > 1 && (matchFolders[0]?.count ?? 0) > 0 ? "match" : "tasks",
  );
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
  // The samples' own tasks are done; leaving them enabled would generate them again next run.
  const sourceTasks = [...new Set(results.map((r) => r.taskId))].filter((id) =>
    batch.tasks.some((t) => t.id === id && t.enabled),
  );
  const [retire, setRetire] = useState(true);
  // Images each task receives under the current scope.
  const assetsFor = (taskId: string) =>
    scope === "match"
      ? pairs.filter((p) => p.task?.id === taskId).map((p) => p.result.asset.id)
      : selected.includes(taskId)
        ? [...new Set(results.map((r) => r.asset.id))]
        : [];
  const retired = (id: string) => retire && sourceTasks.includes(id) && !assetsFor(id).length;
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
        tasks: batch.tasks.map((task) =>
          retire && sourceTasks.includes(task.id) ? { ...task, enabled: false } : task,
        ),
      });
      return;
    }
    const tasks = batch.tasks.map((task) => {
      if (retired(task.id)) return { ...task, enabled: false };
      const incoming = assetsFor(task.id);
      if (!incoming.length) return task;
      const added = incoming
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
                : scope === "match"
                  ? "{count} images will each be added to the same-named task."
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
              {matchFolders.length > 0 && <option value="match">{tr("Match by file name")}</option>}
              <option value="style">{tr("Batch style (every task)")}</option>
            </OptionSelect>
          </div>
          {scope === "style" ? (
            <p className="text-ui-sm text-muted-foreground">
              {tr(
                "Added to the batch style reference images. At confirmation they are placed before every task's own references, including tasks added later.",
              )}
            </p>
          ) : scope === "match" ? (
            <>
              <div className="w-64">
                <OptionSelect
                  label={tr("Target folder")}
                  value={matchFolder}
                  disabled={busy}
                  onValueChange={setMatchFolder}
                >
                  {matchFolders.map(({ folder, count }) => (
                    <option key={folder} value={folder}>
                      {folder} ({count})
                    </option>
                  ))}
                </OptionSelect>
              </div>
              <p className="text-ui-xs text-muted-foreground">
                {tr(
                  "Each image goes only to the task with the same file name in the target folder.",
                )}
              </p>
              <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2 text-ui-sm">
                {pairs.map(({ result, task }) => (
                  <li key={result.id} className="flex items-center gap-2">
                    <img
                      src={imageUrl(result.asset, "thumbnail")}
                      alt=""
                      className="size-8 shrink-0 rounded bg-muted object-contain"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {result.output} →{" "}
                      {task ? (
                        task.output
                      ) : (
                        <span className="text-muted-foreground">
                          {tr("No task with this name")}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2 text-ui-sm">
                <Checkbox
                  checked={enable}
                  disabled={busy}
                  onCheckedChange={(v) => setEnable(v === true)}
                />
                {tr("Enable the chosen tasks")}
              </label>
            </>
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
          {sourceTasks.length > 0 && (
            <label className="flex items-center gap-2 text-ui-sm">
              <Checkbox
                checked={retire}
                disabled={busy}
                onCheckedChange={(v) => setRetire(v === true)}
              />
              {tr("Disable the sample's own task ({count}) so it is not generated again").replace(
                "{count}",
                String(sourceTasks.length),
              )}
            </label>
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
            disabled={
              busy ||
              (scope === "tasks" && !selected.length) ||
              (scope === "match" && !pairs.some((p) => p.task))
            }
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
