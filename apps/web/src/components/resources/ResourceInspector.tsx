import { resourceType, type ResourceEntry } from "@synara/contracts/resourceLibrary";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { batchApi, batchKey } from "../imageBatches/useImageBatches";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useStore } from "~/store";
import { WorkAreaPanel } from "~/components/ui/work-area-panel";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { PreviewSurface } from "~/components/ui/preview-surface";
import { ResourcePreview, humanResourceBytes } from "./ResourcePreview";
import type { useResourceDraft } from "./useResourceDraft";

export function ResourceInspector({
  entries,
  editor,
  onClose,
  overlay,
  onPreview,
  onReveal,
  onLocate,
  readOnly = false,
}: {
  readOnly?: boolean;
  entries: ResourceEntry[];
  editor: ReturnType<typeof useResourceDraft>;
  onClose: () => void;
  overlay: boolean;
  onPreview: (entry: ResourceEntry, trigger: HTMLElement) => void;
  onReveal: (entry: ResourceEntry) => void;
  onLocate: (entry: ResourceEntry) => void;
}) {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const threads = useStore((state) => state.sidebarThreadSummaryById);
  const entry = entries.length === 1 ? entries[0]! : null;
  const client = useQueryClient(),
    batchId = entry?.origin?.kind === "image-batch" ? entry.origin.batchId : undefined;
  useEffect(
    () =>
      batchId
        ? batchApi().onEvent((event) => {
            if (event.type === "snapshot" || event.batchId === batchId)
              void client.invalidateQueries({ queryKey: batchKey });
          })
        : undefined,
    [batchId, client],
  );
  const batchResult = useQuery({
    queryKey: [...batchKey, "result", entry?.origin?.resultId],
    enabled: entry?.origin?.kind === "image-batch" && !!entry.origin.resultId,
    queryFn: () => batchApi().result({ id: entry!.origin!.resultId! }),
    retry: false,
  });
  return (
    <WorkAreaPanel
      title={tr("Details")}
      closeLabel={tr("Close details")}
      onClose={onClose}
      overlay={overlay}
      width="20rem"
      className="max-w-full"
    >
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-ui"
        data-testid="resource-inspector"
      >
        {!entry ? (
          <>
            {editor.dirty ? (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-border p-3 text-ui-sm"
              >
                <p>
                  {tr(
                    "The resource changed outside Aha. Your unsaved draft is preserved until you save or discard it.",
                  )}
                </p>
                <p className="break-words">{editor.draft.tags}</p>
                <p className="whitespace-pre-wrap break-words">{editor.draft.notes}</p>
              </div>
            ) : null}
            <p className="font-medium">
              {entries.length
                ? `${entries.length} ${tr("selected")}`
                : tr("Select a resource to inspect it.")}
            </p>
            {entries.length ? (
              <p className="text-ui-sm text-muted-foreground">
                {humanResourceBytes(entries.reduce((total, item) => total + item.bytes, 0))} ·{" "}
                {tr("Use the selection toolbar to organize these resources.")}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <PreviewSurface
              className="h-48"
              checker={entry.kind === "file" && resourceType(entry.name) === "image"}
            >
              <ResourcePreview entry={entry} />
            </PreviewSurface>
            <div>
              <h3 className="break-all font-medium">{entry.name}</h3>
              <p className="mt-1 break-all text-ui-xs text-muted-foreground">
                {entry.path}
                <br />
                {humanResourceBytes(entry.bytes)} · {new Date(entry.modifiedAt).toLocaleString()}
              </p>
            </div>
            {entry.kind === "file" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => onPreview(entry, event.currentTarget)}
              >
                {tr("Preview")}
              </Button>
            ) : null}
            <label className="block space-y-1.5">
              <span>{tr("Tags")}</span>
              <Input
                aria-label={tr("Tags")}
                value={editor.draft.tags}
                disabled={editor.saving}
                onChange={(event) =>
                  editor.setDraft((previous) => ({ ...previous, tags: event.target.value }))
                }
                placeholder={tr("Separate tags with commas")}
              />
            </label>
            <label className="block space-y-1.5">
              <span>{tr("Notes")}</span>
              <Textarea
                aria-label={tr("Notes")}
                value={editor.draft.notes}
                disabled={editor.saving}
                onChange={(event) =>
                  editor.setDraft((previous) => ({ ...previous, notes: event.target.value }))
                }
              />
            </label>
            {editor.error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {tr(editor.error)}
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={readOnly || !editor.dirty || editor.saving}
              onClick={() => void editor.save()}
            >
              {tr(editor.saving ? "Saving..." : "Save")}
            </Button>
            {entry.origin ? (
              <section className="space-y-2 text-ui-sm">
                <h4 className="font-medium">{tr("Source")}</h4>
                <p>{tr(entry.origin.kind)}</p>
                {entry.origin.kind === "image-batch" && entry.origin.batchId && (
                  <>
                    <p>
                      {tr("System selection")}:{" "}
                      {tr(
                        batchResult.isPending
                          ? "Loading..."
                          : batchResult.data?.adopted
                            ? "Adopted"
                            : batchResult.isError
                              ? "Source is unavailable"
                              : "Not adopted",
                      )}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        editor.guard(() => {
                          void navigate({
                            to: "/image-batches",
                            search: {
                              batchId: entry.origin!.batchId!,
                              ...(entry.origin!.taskId ? { taskId: entry.origin!.taskId } : {}),
                              ...(entry.origin!.resultId
                                ? { resultId: entry.origin!.resultId }
                                : {}),
                            },
                          });
                        })
                      }
                    >
                      {tr("Open image batch")}
                    </Button>
                  </>
                )}
                {entry.origin.kind === "model3d" && entry.origin.projectId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      editor.guard(() => {
                        void navigate({
                          to: "/model3d",
                          search: { projectId: entry.origin!.projectId! },
                        });
                      })
                    }
                  >
                    {tr("Open 3D project")}
                  </Button>
                ) : null}
                {entry.origin.kind === "sprite" && entry.origin.projectId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/sprite-animation",
                        search: { projectId: entry.origin!.projectId! },
                      })
                    }
                  >
                    {tr("Open sprite project")}
                  </Button>
                ) : null}
                {entry.origin.threadId ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!threads[entry.origin.threadId]}
                    onClick={() =>
                      editor.guard(() => {
                        void navigate({
                          to: "/$threadId",
                          params: { threadId: entry.origin!.threadId! as ThreadId },
                        });
                      })
                    }
                  >
                    {tr(
                      threads[entry.origin.threadId] ? "Open source chat" : "Source is unavailable",
                    )}
                  </Button>
                ) : null}
                {entry.origin.model ? <p>{entry.origin.model}</p> : null}
                {entry.origin.prompt ? (
                  <p className="whitespace-pre-wrap break-words">{entry.origin.prompt}</p>
                ) : null}
              </section>
            ) : null}
            {entry.kind === "file" ? (
              <Button variant="outline" size="sm" onClick={() => onLocate(entry)}>
                {tr("Locate folder")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => onReveal(entry)}>
              {tr("Show in folder")}
            </Button>
          </>
        )}
      </div>
    </WorkAreaPanel>
  );
}
