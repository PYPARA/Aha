import type { ResourceSnapshot } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
export function ResourceIndexStatus({
  snapshot,
  onClose,
  onRescan,
}: {
  snapshot: ResourceSnapshot;
  onClose: () => void;
  onRescan: () => void;
}) {
  const tr = useAhaTranslation(),
    scan = snapshot.scan;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("Index status")}</DialogTitle>
          <DialogDescription>
            {tr(
              scan?.phase === "ready"
                ? "Synced"
                : scan?.phase === "failed"
                  ? "Results may be incomplete"
                  : scan
                    ? "Scanning; counts may change"
                    : "Statistics unavailable",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui-sm">
          <p className="break-all">{snapshot.root}</p>
          <p>
            {tr("Files")}: {snapshot.count} · {tr("Folders")}: {snapshot.directories.length}
          </p>
          <p>
            {tr("Last successful scan")}:{" "}
            {scan?.lastCompletedAt ? new Date(scan.lastCompletedAt).toLocaleString() : "—"}
          </p>
          {scan ? (
            <dl className="grid grid-cols-[1fr_auto] gap-2">
              <dt>{tr("Skipped system files")}</dt>
              <dd>{scan.skipped.system}</dd>
              <dt>{tr("Skipped temporary files")}</dt>
              <dd>{scan.skipped.temporary}</dd>
              <dt>{tr("Skipped symbolic links")}</dt>
              <dd>{scan.skipped.symbolicLinks}</dd>
              <dt>{tr("Skipped unsupported entries")}</dt>
              <dd>{scan.skipped.unsupported}</dd>
            </dl>
          ) : null}
          {snapshot.error ? (
            <p role="alert" className="break-all text-destructive">
              {scan?.failedPath || snapshot.root}: {tr(snapshot.error)}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {tr(
              "Counts describe the committed index and ignore content filters. Symbolic links are not followed.",
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {tr("Close")}
            </Button>
            <Button
              disabled={scan?.phase === "scanning" || scan?.phase === "loading"}
              onClick={onRescan}
            >
              {tr("Rescan library")}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
