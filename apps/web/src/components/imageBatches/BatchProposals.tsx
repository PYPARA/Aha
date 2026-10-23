import { useState } from "react";
import {
  imageBatchDiff,
  imageBatchPlanCounts,
  imageBatchProposedDefaults,
  imageBatchTaskConfiguration,
  type ImageBatchDefaults,
  type ImageBatchState,
  type ImageBatchProposal,
  type ImageBatchTask,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useBatchCommand } from "./useImageBatches";

/** Readable per-field comparison; the raw task JSON stays in Diagnostic details. */
function taskFields(task: ImageBatchTask | undefined, defaults: ImageBatchDefaults) {
  if (!task) return null;
  const configuration = imageBatchTaskConfiguration(task, defaults);
  return {
    Name: task.name,
    "Output path": task.output ?? "—",
    "Final image prompt": task.prompt,
    Enabled: task.enabled ? "✓" : "—",
    "Image count": String(configuration.parameters.n),
    Model: configuration.model,
    Size: configuration.parameters.size ?? "—",
    Quality: configuration.parameters.quality ?? "—",
    Background: configuration.parameters.background ?? "—",
    "Reference images": String(task.references.length),
  };
}
/** Batch style and default parameters, compared the same way as task fields. */
function defaultFields(defaults: ImageBatchDefaults) {
  return {
    "Style description": defaults.stylePrompt?.trim() || "—",
    "Style reference images": String(defaults.styleReferences?.length ?? 0),
    "Default image count": String(defaults.parameters.n),
    "Default size": defaults.parameters.size ?? "—",
    "Default quality": defaults.parameters.quality ?? "—",
    "Default background": defaults.parameters.background ?? "—",
    "Default format": defaults.parameters.outputFormat ?? "—",
  };
}

export function BatchProposals({
  batch,
  onError,
  onApplied,
}: {
  batch: ImageBatchState;
  onError: (error: unknown) => void;
  /** Called with the applied state; review asks the workspace to open the generation check. */
  onApplied?: (state: ImageBatchState, review: boolean) => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const [view, setView] = useState<ImageBatchProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const diff = view ? imageBatchDiff(batch.tasks, view.tasks) : null;
  // Removing tasks is the one change that loses work, so it is called out before applying.
  const removedBy = (proposal: ImageBatchProposal) =>
    imageBatchDiff(batch.tasks, proposal.tasks).removed.length;
  const proposed = view ? imageBatchProposedDefaults(batch.defaults, view) : batch.defaults;
  const previousDefaults = defaultFields(batch.defaults),
    nextDefaults = defaultFields(proposed);
  const changedDefaults = (Object.keys(nextDefaults) as (keyof typeof nextDefaults)[]).filter(
    (field) => previousDefaults[field] !== nextDefaults[field],
  );
  const apply = async (
    operation: "apply-proposal" | "dismiss-proposal",
    proposal: ImageBatchProposal,
    review = false,
  ) => {
    setBusy(true);
    try {
      const state = await command({
        operation,
        batchId: batch.id,
        version: batch.version,
        proposalId: proposal.id,
      });
      setView(null);
      if (operation === "apply-proposal") onApplied?.(state, review);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {batch.proposals
        .filter((p) => p.status === "pending")
        .map((p) => (
          <div key={p.id} className="space-y-2 border-b p-4 text-ui-sm">
            <p className="font-medium">{tr("Pending changes")}</p>
            <p className="whitespace-pre-wrap">{p.summary}</p>
            {removedBy(p) > 0 && (
              <p role="alert" className="text-destructive">
                {tr("Applying removes {count} tasks from the task list.").replace(
                  "{count}",
                  String(removedBy(p)),
                )}
              </p>
            )}
            {p.defaults && (
              <p className="text-muted-foreground">
                {tr("Also changes the batch style or default parameters.")}
              </p>
            )}
            {[...new Set(p.warnings)].map((w) => (
              <p key={w} className="whitespace-pre-wrap text-muted-foreground">
                {w}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setView(p)}>
                {tr("Preview changes")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void apply("dismiss-proposal", p)}
              >
                {tr("Dismiss")}
              </Button>
            </div>
          </div>
        ))}
      <Dialog
        open={!!view}
        onOpenChange={(open) => {
          if (!open && !busy) setView(null);
        }}
      >
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{tr("Review task changes")}</DialogTitle>
            <DialogDescription>
              {tr(
                "Applying updates the task list. Generation still needs your confirmation in the next step.",
              )}
            </DialogDescription>
          </DialogHeader>
          {view && diff && (
            <>
              <div className="max-h-[65dvh] space-y-4 overflow-auto p-4 text-ui-sm">
                <p className="whitespace-pre-wrap">{view.summary}</p>
                <p>
                  {tr("Added")}: {diff.added.length} · {tr("Changed")}: {diff.changed.length} ·{" "}
                  {tr("Removed")}: {diff.removed.length}
                  {diff.reordered ? " · " + tr("Order changed") : ""}
                </p>
                {diff.removed.length > 0 && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 p-2 text-destructive"
                  >
                    {tr(
                      "Applying removes {count} tasks from the task list. Removed tasks can be restored from the task list afterwards.",
                    ).replace("{count}", String(diff.removed.length))}
                  </p>
                )}
                <p>
                  {tr("Planned images")}: {imageBatchPlanCounts(batch.tasks, batch.defaults).images}{" "}
                  → {imageBatchPlanCounts(view.tasks, proposed).images}
                </p>
                {changedDefaults.length > 0 && (
                  <section className="space-y-2 border-t pt-3">
                    <h3 className="font-medium">{tr("Batch style and defaults")}</h3>
                    <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr_1fr]">
                      <span className="hidden sm:block" />
                      <span className="hidden text-muted-foreground sm:block">{tr("Before")}</span>
                      <span className="hidden text-muted-foreground sm:block">{tr("After")}</span>
                      {changedDefaults.map((field) => (
                        <div key={field} className="contents">
                          <dt className="text-muted-foreground">{tr(field)}</dt>
                          <dd className="whitespace-pre-wrap break-words">
                            {previousDefaults[field]}
                          </dd>
                          <dd className="whitespace-pre-wrap break-words">{nextDefaults[field]}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
                {[...new Set(view.warnings)].map((w) => (
                  <p key={w} className="whitespace-pre-wrap text-muted-foreground">
                    {w}
                  </p>
                ))}
                {[...diff.added, ...diff.changed, ...diff.removed].map((task) => {
                  const before = batch.tasks.find((t) => t.id === task.id),
                    after = view.tasks.find((t) => t.id === task.id);
                  const previous = taskFields(before, batch.defaults),
                    next = taskFields(after, proposed);
                  const fields = Object.keys(next ?? previous ?? {}).filter(
                    (field) =>
                      !previous ||
                      !next ||
                      previous[field as keyof typeof previous] !== next[field as keyof typeof next],
                  ) as (keyof NonNullable<typeof next>)[];
                  return (
                    <section key={task.id} className="space-y-2 border-t pt-3">
                      <h3 className="font-medium">
                        {task.name} · {tr(!before ? "Added" : !after ? "Removed" : "Changed")}
                      </h3>
                      {previous && next ? (
                        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr_1fr]">
                          <span className="hidden sm:block" />
                          <span className="hidden text-muted-foreground sm:block">
                            {tr("Before")}
                          </span>
                          <span className="hidden text-muted-foreground sm:block">
                            {tr("After")}
                          </span>
                          {fields.map((field) => (
                            <div key={field} className="contents">
                              <dt className="text-muted-foreground">{tr(field)}</dt>
                              <dd className="whitespace-pre-wrap break-words">{previous[field]}</dd>
                              <dd className="whitespace-pre-wrap break-words">{next[field]}</dd>
                            </div>
                          ))}
                          {!fields.length && (
                            <p className="text-muted-foreground sm:col-span-3">
                              {tr("Only settings without a summary changed.")}
                            </p>
                          )}
                        </dl>
                      ) : (
                        // Added or removed tasks have one side only.
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                          {fields.map((field) => (
                            <div key={field} className="contents">
                              <dt className="text-muted-foreground">{tr(field)}</dt>
                              <dd className="whitespace-pre-wrap break-words">
                                {(next ?? previous)?.[field]}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      <details className="text-ui-xs text-muted-foreground">
                        <summary className="cursor-pointer">{tr("Diagnostic details")}</summary>
                        <pre className="overflow-auto whitespace-pre-wrap break-all font-mono">
                          {JSON.stringify({ before, after }, null, 2)}
                        </pre>
                      </details>
                    </section>
                  );
                })}
                {view.baseVersion !== batch.version && (
                  <p role="alert" className="text-destructive">
                    {tr(
                      "The draft changed after this proposal. Ask AI to read the current version and submit updated changes.",
                    )}
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t p-4">
                <Button variant="ghost" disabled={busy} onClick={() => setView(null)}>
                  {tr("Cancel")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || view.baseVersion !== batch.version}
                  onClick={() => void apply("apply-proposal", view)}
                >
                  {tr("Apply only")}
                </Button>
                <Button
                  disabled={busy || view.baseVersion !== batch.version}
                  onClick={() => void apply("apply-proposal", view, true)}
                >
                  {tr("Apply and review generation")}
                </Button>
              </div>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
