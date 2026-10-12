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
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
export function ResourceCollectionDialog() {
  useEffect(() => {
    if (window.desktopBridge?.resourceLibrary)
      return installResourceContextMenuExtension(window.desktopBridge);
  }, []);
  const tr = useAhaTranslation();
  const sources = useResourceCollection((s) => s.sources);
  const isOpen = !!sources;
  const library = useResourceLibrary(isOpen);
  const client = useQueryClient();
  const [target, setTarget] = useState("");
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
      const last = JSON.parse(localStorage.getItem("aha:resource-destination") ?? "null") as {
        libraryId: string;
        id: string;
      } | null;
      const dir =
        last?.libraryId === library.data.libraryId
          ? library.data.directories.find((e) => e.id === last.id)
          : undefined;
      setTarget(dir?.path ?? "");
    } catch {
      setTarget("");
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
      if (!sources || !library.data?.directories.some((e) => e.path === target))
        throw new Error("Choose a project or folder.");
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
      const id = library.data.directories.find((e) => e.path === target)!.id;
      try {
        localStorage.setItem(
          "aha:resource-destination",
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
            {tr("Keep an independent copy in a project folder.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
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
              <label className="block space-y-2 text-sm">
                {tr("Destination")}
                <select
                  aria-label={tr("Destination")}
                  className={inputClass}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={busy}
                >
                  <option value="">{tr("Choose a project or folder.")}</option>
                  {library.data.directories.map((d) => (
                    <option key={d.id} value={d.path}>
                      {d.path}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <input
                  aria-label={tr("Folder name")}
                  placeholder={tr("Folder name")}
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  disabled={busy || !name.trim()}
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      const created = await resourceApi<ResourceEntry>({
                        op: "createDirectory",
                        parent: target,
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
            </>
          )}
          {error || library.data?.error || library.error ? (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
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
              disabled={busy || !target || !!library.data?.error}
              onClick={() => void collect()}
            >
              {tr(busy ? "Saving..." : "Add to resource center")}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
