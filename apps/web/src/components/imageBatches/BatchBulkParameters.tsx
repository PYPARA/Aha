import { useState } from "react";
import {
  imageBatchTaskConfiguration,
  type ImageBatchDefaults,
  type ImageBatchTask,
  type ImageGenerationParameters,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DrawingParameters } from "../drawing/DrawingPickers";

/** Sets only the parameters the user touched on every selected task; others keep their values. */
export function BatchBulkParameters({
  tasks,
  defaults,
  onApply,
  onClose,
}: {
  tasks: readonly ImageBatchTask[];
  defaults: ImageBatchDefaults;
  onApply: (patch: Partial<ImageGenerationParameters>) => Promise<void>;
  onClose: () => void;
}) {
  const tr = useAhaTranslation();
  const [patch, setPatch] = useState<Partial<ImageGenerationParameters>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = imageBatchTaskConfiguration(tasks[0]!, defaults).parameters;
  const changed = Object.keys(patch) as (keyof ImageGenerationParameters)[];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tr("Set parameters for selected tasks")}</DialogTitle>
          <DialogDescription>
            {tr(
              "{count} tasks. Only the parameters you change are applied; the others keep each task's own values.",
            ).replace("{count}", String(tasks.length))}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui">
          <DrawingParameters
            parameters={{ ...base, ...patch }}
            onChange={(next) => setPatch((current) => ({ ...current, ...next }))}
          />
          <p className="text-ui-sm text-muted-foreground">
            {changed.length
              ? tr("Will change") +
                ": " +
                changed.map((key) => tr(PARAMETER_LABELS[key])).join(", ")
              : tr("No parameter changed yet.")}
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
            disabled={busy || !changed.length}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onApply(patch)
                .then(onClose)
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {tr("Apply to selected")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const PARAMETER_LABELS: Record<keyof ImageGenerationParameters, string> = {
  n: "Image count",
  size: "Size",
  quality: "Quality",
  outputFormat: "Format",
  background: "Background",
};
