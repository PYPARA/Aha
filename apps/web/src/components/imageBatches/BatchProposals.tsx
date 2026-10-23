import { useState } from "react";
import {
  imageBatchDiff,
  imageBatchPlanCounts,
  imageBatchTaskConfiguration,
  type ImageBatchState,
  type ImageBatchProposal,
  type ImageBatchTask,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useBatchCommand } from "./useImageBatches";

/** Readable per-field comparison; the raw task JSON stays in Diagnostic details. */
function taskFields(task: ImageBatchTask | undefined, batch: ImageBatchState) {
  if (!task) return null;
  const configuration = imageBatchTaskConfiguration(task, batch.defaults);
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
                <p>
                  {tr("Planned images")}: {imageBatchPlanCounts(batch.tasks, batch.defaults).images}{" "}
                  → {imageBatchPlanCounts(view.tasks, batch.defaults).images}
                </p>
                {[...new Set(view.warnings)].map((w) => (
                  <p key={w} className="whitespace-pre-wrap text-muted-foreground">
                    {w}
                  </p>
                ))}
                {[...diff.added, ...diff.changed, ...diff.removed].map((task) => {
                  const before = batch.tasks.find((t) => t.id === task.id),
                    after = view.tasks.find((t) => t.id === task.id);
                  const previous = taskFields(before, batch),
                    next = taskFields(after, batch);
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
