import { useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { resourceType, type ResourceEntry } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { PreviewSurface } from "~/components/ui/preview-surface";
import { ResourcePreview, humanResourceBytes } from "./ResourcePreview";
import { resourceKey } from "./resourceLibrary";

/** Preview owns no selection or metadata draft; closing restores the exact browsing context. */
export function ResourceDetailsDialog({
  entry,
  onClose,
  returnFocus,
  fallbackFocus,
}: {
  entry: ResourceEntry | null;
  onClose: () => void;
  onUpdated?: (entry: ResourceEntry) => void;
  returnFocus: RefObject<HTMLElement | null>;
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const tr = useAhaTranslation();
  const client = useQueryClient();
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        ref={popup}
        initialFocus={popup}
        finalFocus={() =>
          returnFocus.current?.isConnected
            ? returnFocus.current
            : (fallbackFocus.current ?? undefined)
        }
        bottomStickOnMobile={false}
        className="max-h-[calc(100dvh-2rem)] max-w-5xl overflow-hidden"
      >
        <DialogHeader className="shrink-0 pr-12">
          <DialogTitle className="break-all">{entry?.name}</DialogTitle>
          <DialogDescription>{tr("Resource preview")}</DialogDescription>
        </DialogHeader>
        {entry ? (
          <div
            className="min-h-0 space-y-3 overflow-y-auto p-4"
            data-testid="resource-details-content"
          >
            <PreviewSurface
              className="min-h-48 p-4"
              data-testid="resource-detail-preview"
              checker={resourceType(entry.name) === "image"}
            >
              <ResourcePreview key={`${entry.id}:${entry.hash}`} entry={entry} large />
            </PreviewSurface>
            <p className="break-all text-ui-sm text-muted-foreground">
              {entry.path} · {humanResourceBytes(entry.bytes)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void client.resetQueries({ queryKey: [...resourceKey, "preview"] })}
            >
              {tr("Reload preview")}
            </Button>
          </div>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
