import { useState } from "react";
import {
  imageBatchDiff,
  imageBatchPlanCounts,
  type ImageBatchState,
  type ImageBatchProposal,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useBatchCommand } from "./useImageBatches";

export function BatchProposals({
  batch,
  onError,
}: {
  batch: ImageBatchState;
  onError: (error: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const [view, setView] = useState<ImageBatchProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const diff = view ? imageBatchDiff(batch.tasks, view.tasks) : null;
  const apply = async (
    operation: "apply-proposal" | "dismiss-proposal",
    proposal: ImageBatchProposal,
  ) => {
    setBusy(true);
    try {
      await command({
        operation,
        batchId: batch.id,
        version: batch.version,
        proposalId: proposal.id,
      });
      setView(null);
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
                "Applying changes updates the draft only. Generation requires a separate confirmation.",
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
                  return (
                    <section key={task.id} className="space-y-2 border-t pt-3">
                      <h3 className="font-medium">
                        {task.name} · {tr(!before ? "Added" : !after ? "Removed" : "Changed")}
                      </h3>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {[
                          { phase: "Before", value: before },
                          { phase: "After", value: after },
                        ].map(({ phase, value }) => (
                          <div key={phase} className="min-w-0">
                            <p className="text-muted-foreground">{tr(phase)}</p>
                            <pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-ui-xs">
                              {value ? JSON.stringify(value, null, 2) : "—"}
                            </pre>
                          </div>
                        ))}
                      </div>
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
                  disabled={busy || view.baseVersion !== batch.version}
                  onClick={() => void apply("apply-proposal", view)}
                >
                  {tr("Apply changes")}
                </Button>
              </div>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
