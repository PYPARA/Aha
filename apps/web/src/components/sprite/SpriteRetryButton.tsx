import { useRef, useState } from "react";
import type { SpriteRun, SpriteState } from "@synara/contracts";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { drawingApi } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { spriteRetryableRuns } from "./spriteGenerationAttempts";
export function SpriteRetryButton({
  runs,
  allRuns,
  onState,
  onModify,
}: {
  runs: readonly SpriteRun[];
  allRuns: readonly SpriteRun[];
  onState: (state: SpriteState) => void;
  onModify?: (run: SpriteRun) => void;
}) {
  const tr = useAhaTranslation();
  const eligible = spriteRetryableRuns(runs, allRuns);
  const [selection, setSelection] = useState<readonly SpriteRun[] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestId = useRef(""),
    submitting = useRef(false);
  if (!eligible.length && !selection) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!eligible.length}
        onClick={() => {
          requestId.current = crypto.randomUUID();
          setSelection(eligible);
          setError("");
        }}
      >
        {tr("Retry failed tasks")}
      </Button>
      <Dialog
        open={!!selection}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setSelection(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("Retry failed tasks")}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-y-auto p-4">
            <p className="text-sm">
              {tr("Retry uses the original submitted settings and may incur another charge.")}
            </p>
            {selection?.map((r) => (
              <div key={r.id} className="rounded border p-3 text-xs">
                <p>
                  {r.configuration?.actions
                    .filter((a) => a.enabled)
                    .map((a) => a.name)
                    .join(" · ") ?? r.context.action}
                </p>
                <p className="mt-1 wrap-anywhere text-muted-foreground">
                  {r.submissionProviderName ?? r.context.providerId} · {r.context.model} ·{" "}
                  {r.submissionParameters?.size ?? r.configuration?.parameters.size ?? "auto"} ·{" "}
                  {tr("Reference images")}:{" "}
                  {r.configuration?.references.length ?? (r.context.referenceAssetId ? 1 : 0)}
                </p>
              </div>
            ))}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {tr(error)}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {error && onModify && selection?.[0] && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const run = selection[0]!;
                    setSelection(null);
                    onModify(run);
                  }}
                >
                  {tr("Edit plan and retry")}
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => setSelection(null)}>
                {tr("Cancel")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  if (submitting.current || !selection?.length) return;
                  submitting.current = true;
                  setBusy(true);
                  setError("");
                  const first = selection[0]!;
                  void drawingApi()
                    .spriteRetryConfirm({
                      projectId: first.context.projectId,
                      threadId: first.context.threadId!,
                      runIds: selection.map((r) => r.id),
                      requestId: requestId.current,
                    })
                    .then((state) => {
                      onState(state);
                      setSelection(null);
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => {
                      submitting.current = false;
                      setBusy(false);
                    });
                }}
              >
                {tr("Retry with original settings")} ({selection?.length ?? 0})
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
