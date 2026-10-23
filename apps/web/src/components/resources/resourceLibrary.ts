import { createContext, useEffect } from "react";
import { create } from "zustand";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  ResourceCommand,
  ResourceSnapshot,
  ResourceReadResult,
  ResourceOrigin,
  ResourceBatchPlan,
  ResourceBatchResult,
  ResourceImportResult,
} from "@synara/contracts/resourceLibrary";
export const ResourceChatContext = createContext<string | undefined>(undefined);
export const ResourceLibraryIdContext = createContext<string | null>(null);
export const resourceKey = ["resource-library"] as const;
export interface ResourceTaskResults {
  batch: { result: ResourceBatchResult; plan: ResourceBatchPlan } | null;
  import: {
    result: ResourceImportResult;
    operation: { target: string; importDirectories?: boolean | undefined };
  } | null;
}
export const useResourceTaskResults = create<{ byLibrary: Record<string, ResourceTaskResults> }>(
  () => ({ byLibrary: {} }),
);
export function recordResourceTask(libraryId: string, update: Partial<ResourceTaskResults>) {
  useResourceTaskResults.setState((state) => ({
    byLibrary: {
      ...state.byLibrary,
      [libraryId]: {
        batch: null,
        import: null,
        ...state.byLibrary[libraryId],
        ...update,
      },
    },
  }));
}
export function resourceApi<T = unknown>(command: ResourceCommand): Promise<T> {
  const api = window.desktopBridge?.resourceLibrary;
  if (!api) return Promise.reject(new Error("Resource center is available in the desktop app."));
  return api.request<T>(command);
}
// One timer for every subscriber: a burst of desktop changes becomes a single refetch.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleLibraryRefresh(client: QueryClient) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void client.invalidateQueries({
      queryKey: resourceKey,
      predicate: (q) => q.queryKey[1] !== "preview" && q.queryKey[1] !== "collections",
    });
  }, 250);
}
export function useResourceLibrary(enabled = true) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    // Copy receipts are refreshed by the collection worker; they do not change the library.
    return window.desktopBridge?.resourceLibrary?.onChanged((scope) => {
      if (scope !== "collections") scheduleLibraryRefresh(client);
    });
  }, [client, enabled]);
  return useQuery({
    queryKey: [...resourceKey, "snapshot"],
    queryFn: () => resourceApi<ResourceSnapshot>({ op: "snapshot" }),
    enabled: enabled && typeof window !== "undefined" && !!window.desktopBridge?.resourceLibrary,
  });
}
export interface ResourceSource {
  name: string;
  /** Subfolder under the chosen destination, created on collection (batch output paths). */
  folder?: string | undefined;
  assetId?: string;
  url?: string;
  path?: string;
  origin?: ResourceOrigin | undefined;
  resolveUrl?: () => Promise<string>;
}
export const useResourceCollection = create<{ sources: ResourceSource[] | null }>(() => ({
  sources: null,
}));
export function collectResources(sources: ResourceSource[]) {
  if (typeof window === "undefined" || !window.desktopBridge?.resourceLibrary || !sources.length)
    return;
  const segment = window.location.pathname.split("/")[1];
  useResourceCollection.setState({
    sources: sources.map((source) => ({
      ...source,
      origin: {
        kind: "chat",
        ...(![
          "drawing",
          "image-batches",
          "sprite-animation",
          "model3d",
          "resources",
          "settings",
          "",
        ].includes(segment ?? "")
          ? { threadId: segment }
          : {}),
        ...source.origin,
      },
    })),
  });
}
export async function resourceFile(id: string) {
  const data = await resourceApi<ResourceReadResult>({ op: "read", id });
  return new File([new Uint8Array(data.bytes)], data.name, { type: data.mimeType });
}
export interface ResourceReceiveResult {
  accepted: number[];
  rejected: { index: number; error: string }[];
}
interface ResourceTransfer {
  transferId: string;
  target: string;
  files: File[];
  /** Resource IDs for Resource Center files; other senders get positional file IDs. */
  resourceIds: string[];
  /** Null when the files did not come from a resource library (batch results, drawings). */
  libraryId: string | null;
  status: "queued" | "receiving";
}
interface ResourceTransferResult {
  transferId: string;
  target: string;
  libraryId: string | null;
  acceptedIds: string[];
  rejected: { id: string; error: string; file: File }[];
}
export const useResourceTransfer = create<{
  pending: ResourceTransfer | null;
  lastResult: ResourceTransferResult | null;
}>(() => ({ pending: null, lastResult: null }));
/**
 * Hands files to the module registered for `target` ("drawing", a thread ID, "sprite:<id>",
 * "sprite:new" or "image-batch:<id>"); the destination claims them with useResourceAttachments.
 */
export function queueResourceTransfer(
  target: string,
  files: File[],
  origin?: { resourceIds: string[]; libraryId: string },
) {
  if (useResourceTransfer.getState().pending)
    throw new Error("Finish the previous resource transfer first.");
  const transferId = crypto.randomUUID();
  useResourceTransfer.setState({
    pending: {
      transferId,
      target,
      files,
      resourceIds: origin?.resourceIds ?? files.map((_, index) => "file:" + index),
      libraryId: origin?.libraryId ?? null,
      status: "queued",
    },
    lastResult: null,
  });
  return transferId;
}
/** Points a still-queued transfer at a destination created after it was queued. */
export function retargetResourceTransfer(transferId: string, target: string) {
  const pending = useResourceTransfer.getState().pending;
  if (pending?.transferId !== transferId || pending.status !== "queued") return false;
  useResourceTransfer.setState({ pending: { ...pending, target } });
  return true;
}
export function retryResourceTransfer(): string | null {
  const previous = useResourceTransfer.getState().lastResult;
  if (!previous?.rejected.length) return null;
  queueResourceTransfer(
    previous.target,
    previous.rejected.map((item) => item.file),
    previous.libraryId
      ? { resourceIds: previous.rejected.map((item) => item.id), libraryId: previous.libraryId }
      : undefined,
  );
  return previous.target;
}
export function useResourceAttachments(
  target: string | undefined,
  receive: (files: File[]) => ResourceReceiveResult | Promise<ResourceReceiveResult>,
  ready = true,
) {
  const pending = useResourceTransfer((s) => s.pending);
  useEffect(() => {
    if (!ready || !pending || pending.target !== target || pending.status !== "queued") return;
    // Claim before entering async receiver work. StrictMode and rerenders cannot replay it.
    const claimed = useResourceTransfer.getState().pending;
    if (!claimed || claimed.transferId !== pending.transferId || claimed.status !== "queued")
      return;
    useResourceTransfer.setState({ pending: { ...claimed, status: "receiving" } });
    void Promise.resolve()
      .then(() => receive(claimed.files))
      .then(
        (result) => {
          if (useResourceTransfer.getState().pending?.transferId !== claimed.transferId) return;
          const accepted = new Set(result.accepted);
          useResourceTransfer.setState({
            pending: null,
            lastResult: {
              transferId: claimed.transferId,
              target: claimed.target,
              libraryId: claimed.libraryId,
              acceptedIds: claimed.resourceIds.filter((_, index) => accepted.has(index)),
              rejected: claimed.resourceIds.flatMap((id, index) =>
                accepted.has(index)
                  ? []
                  : [
                      {
                        id,
                        file: claimed.files[index]!,
                        error:
                          result.rejected.find((item) => item.index === index)?.error ??
                          "The destination did not accept this resource.",
                      },
                    ],
              ),
            },
          });
        },
        (cause) => {
          if (useResourceTransfer.getState().pending?.transferId !== claimed.transferId) return;
          useResourceTransfer.setState({
            pending: null,
            lastResult: {
              transferId: claimed.transferId,
              target: claimed.target,
              libraryId: claimed.libraryId,
              acceptedIds: [],
              rejected: claimed.resourceIds.map((id, index) => ({
                id,
                file: claimed.files[index]!,
                error: cause instanceof Error ? cause.message : String(cause),
              })),
            },
          });
        },
      );
  }, [pending, target, receive, ready]);
}
export async function fetchResource(source: ResourceSource) {
  const url = source.resolveUrl ? await source.resolveUrl() : source.url;
  if (!url) throw new Error("Resource no longer exists. Refresh the library.");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Unable to read source file (${response.status}).`);
  const max = 100 * 1024 * 1024;
  if (Number(response.headers.get("Content-Length")) > max)
    throw new Error("This file exceeds the 100 MiB attachment limit. Export it instead.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Could not read source file.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error("This file exceeds the 100 MiB attachment limit. Export it instead.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const mime = response.headers.get("Content-Type")?.split(";")[0];
  const extension = (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
    } as Record<string, string>
  )[mime ?? ""];
  let name =
    source.name
      // eslint-disable-next-line no-control-regex -- filenames must exclude control characters.
      .replace(/[\\/\x00-\x1f<>:"|?*]/gu, "_")
      .trim()
      .slice(0, 100) || "resource";
  if (extension && !/\.(png|jpe?g|webp|gif|avif)$/iu.test(name)) name += extension;
  return { bytes, name };
}
