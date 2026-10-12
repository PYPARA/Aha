import { createContext, useEffect } from "react";
import { create } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ResourceCommand,
  ResourceSnapshot,
  ResourceReadResult,
  ResourceOrigin,
} from "@synara/contracts/resourceLibrary";
export const ResourceChatContext = createContext<string | undefined>(undefined);
export const resourceKey = ["resource-library"] as const;
export function resourceApi<T = unknown>(command: ResourceCommand): Promise<T> {
  const api = window.desktopBridge?.resourceLibrary;
  if (!api) return Promise.reject(new Error("Resource center is available in the desktop app."));
  return api.request<T>(command);
}
export function useResourceLibrary(enabled = true) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return window.desktopBridge?.resourceLibrary?.onChanged(() => {
      void client.invalidateQueries({
        queryKey: resourceKey,
        predicate: (q) => q.queryKey[1] !== "preview",
      });
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
        ...(!["drawing", "resources", "settings", ""].includes(segment ?? "")
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
export const useResourceTransfer = create<{ pending: { target: string; files: File[] } | null }>(
  () => ({ pending: null }),
);
export function useResourceAttachments(
  target: string | undefined,
  receive: (files: File[]) => void,
  ready = true,
) {
  const pending = useResourceTransfer((s) => s.pending);
  useEffect(() => {
    if (!ready || !pending || pending.target !== target) return;
    useResourceTransfer.setState({ pending: null });
    receive(pending.files);
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
