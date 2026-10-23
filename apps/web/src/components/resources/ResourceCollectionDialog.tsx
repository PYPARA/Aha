import {
  installResourceContextMenuExtension,
  registerResourceMenuAction,
} from "~/lib/resourceContextMenuExtension";
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ResourceEntry,
  ResourceImportResult,
  ResourceOrigin,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ResourceDestinationSelect } from "./ResourceDestinationSelect";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import {
  collectResources,
  ResourceChatContext,
  fetchResource,
  resourceApi,
  resourceKey,
  useResourceCollection,
  useResourceLibrary,
  type ResourceSource,
} from "./resourceLibrary";
import { useBatchCollectionWorker } from "./useBatchCollectionWorker";
import type { ResourceCollectionOperation } from "@synara/contracts/resourceLibrary";
import { ensureNativeApi } from "~/nativeApi";

export function ResourceCollectButton({ sources }: { sources: ResourceSource[] }) {
  const threadId = useContext(ResourceChatContext);
  const tr = useAhaTranslation();
  if (typeof window === "undefined" || !window.desktopBridge?.resourceLibrary) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        collectResources(withChatOrigin(sources, e.currentTarget, threadId));
      }}
    >
      {tr("Add to resource center")}
    </Button>
  );
}
export function ResourceCapture({
  source,
  children,
}: {
  source: ResourceSource;
  children: ReactNode;
}) {
  const threadId = useContext(ResourceChatContext);
  const tr = useAhaTranslation();
  if (typeof window === "undefined" || !window.desktopBridge?.resourceLibrary)
    return <>{children}</>;
  return (
    <span
      className="inline-flex max-w-full flex-col items-start"
      onContextMenuCapture={(e) => void resourceContextMenu(e, [source], tr, threadId)}
    >
      {children}
      <ResourceCollectButton sources={[source]} />
    </span>
  );
}
export function resourceContextMenu(
  event: MouseEvent,
  sources: ResourceSource[],
  tr: (text: string) => string,
  threadId?: string,
) {
  if (typeof window === "undefined" || !window.desktopBridge?.resourceLibrary) return;
  const enriched = withChatOrigin(sources, event.currentTarget, threadId);
  registerResourceMenuAction(
    event.currentTarget,
    { x: event.clientX, y: event.clientY },
    {
      label: tr("Add to resource center"),
      run: () => collectResources(enriched),
    },
  );
}
function withChatOrigin(
  sources: ResourceSource[],
  element: EventTarget & Element,
  threadId?: string,
): ResourceSource[] {
  const messageId = element.closest<HTMLElement>("[data-chat-find-document-id]")?.dataset
    .chatFindDocumentId;
  return sources.map((source) => {
    if (source.origin && source.origin.kind !== "chat") return source;
    const origin: ResourceOrigin = { kind: "chat", ...source.origin };
    if (threadId) origin.threadId = threadId;
    if (messageId && !origin.messageId) origin.messageId = messageId;
    return { ...source, origin };
  });
}
export function drawingResourceSource(
  asset: { name: string; url: string },
  url: string,
  job?: { id: string; prompt: string; model: string; parameters: object },
): ResourceSource {
  const origin: ResourceOrigin = {
    kind: "drawing",
    ...(job
      ? {
          jobId: job.id,
          batchId: job.id,
          prompt: job.prompt,
          model: job.model,
          parameters: { ...job.parameters },
        }
      : {}),
  };
  return { name: asset.name, url, origin };
}
export function ResourceCollectionDialog() {
  const collections = useBatchCollectionWorker();
  useEffect(() => {
    if (window.desktopBridge?.resourceLibrary)
      return installResourceContextMenuExtension(window.desktopBridge);
  }, []);
  const tr = useAhaTranslation();
  const sources = useResourceCollection((s) => s.sources);
  const isOpen = !!sources;
  const library = useResourceLibrary(isOpen);
  const client = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      initialized.current = null;
      return;
    }
    if (!library.data) return;
    const key = library.data.libraryId ?? "unconfigured";
    if (initialized.current === key) return;
    initialized.current = key;
    setError(null);
    try {
      const last = JSON.parse(
        localStorage.getItem(`aha:resource-destination:${key}`) ??
          localStorage.getItem("aha:resource-destination") ??
          "null",
      ) as {
        libraryId: string;
        id: string | null;
      } | null;
      const dir =
        last?.libraryId === library.data.libraryId
          ? library.data.directories.find((e) => e.id === last.id)
          : undefined;
      setTarget(
        last?.libraryId === library.data.libraryId && last.id === null ? "" : (dir?.path ?? null),
      );
    } catch {
      setTarget(null);
    }
  }, [isOpen, library.data]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await client.invalidateQueries({
        queryKey: resourceKey,
        predicate: (q) => q.queryKey[1] !== "preview",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const collect = () =>
    run(async () => {
      if (
        !sources ||
        target === null ||
        !library.data?.root ||
        (target !== "" && !library.data.directories.some((e) => e.path === target))
      )
        throw new Error("Choose a project or folder.");
      if (
        sources.every(
          (source) => source.origin?.kind === "image-batch" || source.origin?.kind === "model3d",
        )
      ) {
        const directoryId =
          target === ""
            ? null
            : library.data.directories.find((entry) => entry.path === target)!.id;
        const operationId = crypto.randomUUID();
        const batchIds = [
          ...new Set(
            sources.flatMap((source) => (source.origin!.batchId ? [source.origin!.batchId] : [])),
          ),
        ];
        const items = sources.map((source) => {
          const resultId =
            source.origin?.kind === "model3d"
              ? source.origin.projectId + "_" + source.origin.versionId
              : source.origin?.resultId;
          if (!source.assetId || !resultId) throw new Error("Batch original is unavailable.");
          return {
            resultId,
            assetId: source.assetId,
            name: source.name,
            ...(source.folder ? { folder: source.folder } : {}),
            origin: source.origin!,
          };
        });
        try {
          for (const batchId of batchIds) {
            await ensureNativeApi().imageBatches.command({
              operation: "collection-start",
              batchId,
              operationId,
              resultIds: sources
                .filter((source) => source.origin!.batchId === batchId)
                .map((source) => source.origin!.resultId!),
            });
          }
          await resourceApi<ResourceCollectionOperation>({
            op: "prepareCollection",
            id: operationId,
            libraryId: library.data.libraryId!,
            directoryId,
            items,
          });
        } catch (cause) {
          // A lost prepare reply may already have created the durable desktop operation.
          // Release retention only after proving there is no copy that could still run.
          const recorded = await resourceApi<ResourceCollectionOperation[]>({
            op: "listCollections",
          }).catch(() => null);
          if (!recorded?.some((operation) => operation.id === operationId)) {
            if (recorded)
              for (const batchId of batchIds)
                await ensureNativeApi()
                  .imageBatches.command({ operation: "collection-finish", batchId, operationId })
                  .catch(() => {});
            throw cause;
          }
        }
        try {
          localStorage.setItem(
            `aha:resource-destination:${library.data.libraryId}`,
            JSON.stringify({ libraryId: library.data.libraryId, id: directoryId }),
          );
        } catch {
          /* Destination preference must not obscure an accepted copy operation. */
        }
        useResourceCollection.setState({ sources: null });
        await collections.refetch();
        return;
      }
      let added = 0,
        skipped = 0;
      const failed: ResourceSource[] = [];
      const failures: string[] = [];
      for (const source of sources) {
        try {
          const result = source.path
            ? await resourceApi<ResourceImportResult>({
                op: "importPaths",
                target,
                paths: [source.path],
                ...(source.origin ? { origin: source.origin } : {}),
              })
            : await resourceApi<ResourceImportResult>({
                op: "importBytes",
                target,
                ...(await fetchResource(source)),
                ...(source.origin ? { origin: source.origin } : {}),
              });
          added += result.added;
          skipped += result.skipped;
          if (result.failed.length) {
            failed.push(source);
            failures.push(...result.failed.map((f) => f.error));
          }
        } catch (e) {
          failed.push(source);
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
      const id = target === "" ? null : library.data.directories.find((e) => e.path === target)!.id;
      try {
        localStorage.setItem(
          `aha:resource-destination:${library.data.libraryId}`,
          JSON.stringify({ libraryId: library.data.libraryId, id }),
        );
      } catch {
        /* storage may be disabled */
      }
      toastManager.add({
        type: "info",
        title: `${tr("Added")}: ${added} · ${tr("Skipped")}: ${skipped}`,
      });
      if (failed.length) {
        useResourceCollection.setState({ sources: failed });
        throw new Error(failures.join("\n"));
      }
      useResourceCollection.setState({ sources: null });
    });
  return (
    <>
      {collections.isError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-t px-4 py-2 text-ui-sm text-destructive"
        >
          <p className="min-w-0 flex-1">
            {tr("Resource copy receipts could not be read. Originals are retained.")}{" "}
            {collections.error.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => void collections.refetch()}>
            {tr("Retry")}
          </Button>
        </div>
      )}
      {collections.data
        ?.filter((operation) =>
          operation.items.some((item) => !["linked", "superseded"].includes(item.status)),
        )
        .map((operation) => (
          <div
            key={operation.id}
            role="status"
            className="flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2 text-ui-xs"
          >
            <span>
              {tr("Saving creative assets")}:{" "}
              {operation.items.filter((item) => item.status === "linked").length}/
              {operation.items.length}
            </span>
            {operation.items.some((item) => item.status === "failed") && (
              <>
                <span className="min-w-0 flex-1 break-words text-destructive">
                  {operation.items.find((item) => item.status === "failed")?.error}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void resourceApi({ op: "retryCollection", operationId: operation.id })
                      .then(() => collections.refetch())
                      .catch((cause) =>
                        toastManager.add({
                          type: "error",
                          title: tr("Collection retry failed"),
                          description: String(cause),
                        }),
                      )
                  }
                >
                  {tr("Retry failed copies")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    collectResources(
                      operation.items
                        .filter((item) => item.status === "failed")
                        .map((item) => ({
                          name: item.name,
                          assetId: item.assetId,
                          origin: item.origin,
                        })),
                    )
                  }
                >
                  {tr("Choose destination again")}
                </Button>
              </>
            )}
          </div>
        ))}
      {
        <Dialog
          open={!!sources}
          onOpenChange={(open) => {
            if (!open && !busy) useResourceCollection.setState({ sources: null });
          }}
        >
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{tr("Add to resource center")}</DialogTitle>
              <DialogDescription>
                {tr("Keep an independent copy in the resource library.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 p-4">
              <p className="text-ui text-muted-foreground">
                {sources?.length} {tr("resources")}
              </p>
              {!library.data?.root ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await resourceApi({ op: "chooseRoot" });
                    })
                  }
                >
                  {tr("Choose resource folder")}
                </Button>
              ) : (
                <>
                  <label className="block space-y-2 text-ui">
                    {tr("Destination")}
                    <ResourceDestinationSelect
                      value={target}
                      onChange={setTarget}
                      disabled={busy}
                      directories={library.data.directories}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Input
                      aria-label={tr("Folder name")}
                      placeholder={tr("Folder name")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Button
                      disabled={
                        busy ||
                        !name.trim() ||
                        (!!library.data?.scan && library.data.scan.phase !== "ready")
                      }
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          const created = await resourceApi<ResourceEntry>({
                            op: "createDirectory",
                            parent: target ?? "",
                            name,
                          });
                          setTarget(created.path);
                          setName("");
                        })
                      }
                    >
                      {tr(target ? "New folder" : "New project")}
                    </Button>
                  </div>
                  {sources?.some((source) => source.folder) && (
                    <div className="space-y-1 text-ui-sm text-muted-foreground">
                      <p>{tr("Subfolders from the task output paths are created here:")}</p>
                      <ul className="list-inside list-disc break-all">
                        {sources.slice(0, 5).map((source, i) => (
                          <li key={i}>{[source.folder, source.name].filter(Boolean).join("/")}</li>
                        ))}
                        {sources.length > 5 && <li>…</li>}
                      </ul>
                    </div>
                  )}
                </>
              )}
              {error || library.data?.error || library.error ? (
                <p role="alert" className="whitespace-pre-wrap text-ui text-destructive">
                  {tr(error ?? library.data?.error ?? library.error?.message ?? "")}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => useResourceCollection.setState({ sources: null })}
                >
                  {tr("Cancel")}
                </Button>
                <Button
                  disabled={
                    busy ||
                    target === null ||
                    !!library.data?.error ||
                    (!!library.data?.scan && library.data.scan.phase !== "ready")
                  }
                  onClick={() => void collect()}
                >
                  {tr(busy ? "Saving..." : "Add to resource center")}
                </Button>
              </div>
            </div>
          </DialogPopup>
        </Dialog>
      }
    </>
  );
}
