import { useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
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
import { useStore } from "~/store";
import { resourceApi, resourceKey } from "./resourceLibrary";
import { ResourcePreview, humanResourceBytes, resourceFieldClassName } from "./ResourcePreview";

function ResourceDetails({
  entry,
  onUpdated,
}: {
  entry: ResourceEntry;
  onUpdated: (entry: ResourceEntry) => void;
}) {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const threads = useStore((s) => s.sidebarThreadSummaryById);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [notes, setNotes] = useState(entry.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const nextTags = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      await resourceApi({ op: "metadata", ids: [entry.id], tags: nextTags, notes });
      onUpdated({ ...entry, tags: nextTags, notes });
      await client.invalidateQueries({
        queryKey: resourceKey,
        predicate: (q) => q.queryKey[1] !== "preview",
      });
    });
  return (
    <div
      className="min-h-0 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_288px]"
      data-testid="resource-details-content"
    >
      <div
        className="flex min-h-56 min-w-0 flex-col items-center justify-center gap-3 bg-muted/20 p-4 lg:min-h-[min(60vh,32rem)]"
        data-testid="resource-detail-preview"
      >
        <ResourcePreview entry={entry} large />
        {resourceType(entry.name) !== "image" ? (
          <p className="text-sm text-muted-foreground">{tr(resourceType(entry.name))}</p>
        ) : null}
      </div>
      <div
        className="min-w-0 space-y-4 border-t border-border p-4 lg:border-l lg:border-t-0"
        data-testid="resource-detail-fields"
      >
        <p className="break-all text-xs text-muted-foreground">
          {entry.path}
          <br />
          {humanResourceBytes(entry.bytes)} · {new Date(entry.modifiedAt).toLocaleString()}
        </p>
        <label className="block space-y-1 text-sm">
          {tr("Tags")}
          <input
            className={`${resourceFieldClassName} w-full`}
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder={tr("Separate tags with commas")}
          />
        </label>
        <label className="block space-y-1 text-sm">
          {tr("Notes")}
          <textarea
            className={`${resourceFieldClassName} min-h-24 w-full`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
            {tr(error)}
          </p>
        ) : null}
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {tr(busy ? "Working..." : "Save")}
        </Button>
        {entry.origin ? (
          <div className="space-y-2 text-xs">
            <h3 className="font-medium">{tr("Source")}</h3>
            <p>{tr(entry.origin.kind)}</p>
            {entry.origin.threadId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!threads[entry.origin.threadId]}
                onClick={() =>
                  void navigate({
                    to: "/$threadId",
                    params: { threadId: entry.origin!.threadId! as ThreadId },
                  })
                }
              >
                {tr(threads[entry.origin.threadId] ? "Open source chat" : "Source is unavailable")}
              </Button>
            ) : null}
            {entry.origin.prompt ? (
              <p className="whitespace-pre-wrap break-words">{entry.origin.prompt}</p>
            ) : null}
            {entry.origin.model ? <p>{entry.origin.model}</p> : null}
            {entry.origin.parameters ? (
              <pre className="overflow-auto rounded bg-muted p-2">
                {JSON.stringify(entry.origin.parameters, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await resourceApi({ op: "reveal", id: entry.id });
              })
            }
          >
            {tr("Show in folder")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await resourceApi({ op: "export", ids: [entry.id] });
              })
            }
          >
            {tr("Export")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ResourceDetailsDialog({
  entry,
  onClose,
  onUpdated,
  returnFocus,
}: {
  entry: ResourceEntry | null;
  onClose: () => void;
  onUpdated: (entry: ResourceEntry) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const tr = useAhaTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        ref={popupRef}
        initialFocus={popupRef}
        className="max-h-[calc(100dvh-2rem)] max-w-6xl overflow-hidden"
        finalFocus={returnFocus}
        bottomStickOnMobile={false}
      >
        <DialogHeader className="shrink-0 pr-12">
          <DialogTitle className="break-all">{entry?.name}</DialogTitle>
          <DialogDescription>
            {tr(
              entry && resourceType(entry.name) === "image" ? "Image preview" : "Resource details",
            )}
          </DialogDescription>
        </DialogHeader>
        {entry ? <ResourceDetails key={entry.id} entry={entry} onUpdated={onUpdated} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
