import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ImageAsset,
  ImageJobListInput,
  ImageEditDocument,
  ImageEditDocumentCreateInput,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
export const drawingProvidersKey = ["drawing", "providers"] as const;
export const drawingJobsKey = ["drawing", "jobs"] as const;
export const drawingApi = () => ensureNativeApi().imageGeneration;
export function useImageProviders() {
  return useQuery({ queryKey: drawingProvidersKey, queryFn: () => drawingApi().listProviders() });
}
export function useImageJobs(filters: Omit<ImageJobListInput, "cursor"> = {}) {
  return useInfiniteQuery({
    queryKey: [...drawingJobsKey, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      drawingApi().listJobs({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
export function useDrawingEvents() {
  const client = useQueryClient();
  useEffect(
    () =>
      drawingApi().onEvent((event) => {
        if (event.type === "providers-changed" || event.type === "snapshot")
          void client.invalidateQueries({ queryKey: drawingProvidersKey });
        if (event.type !== "providers-changed")
          void client.invalidateQueries({ queryKey: drawingJobsKey });
      }),
    [client],
  );
}
export async function uploadDrawingImage(file: File | Blob, name: string): Promise<ImageAsset> {
  const url = resolveWsHttpUrl(`/api/drawing/upload?name=${encodeURIComponent(name)}`);
  const response = await fetch(url, {
    method: "POST",
    body: file,
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not upload image.");
  return body;
}
export const imageUrl = (asset: ImageAsset, variant?: "thumbnail" | "edit") =>
  resolveWsHttpUrl(variant ? `${asset.url}?variant=${variant}` : asset.url);

export async function getImageEditDocument(id: string): Promise<ImageEditDocument> {
  const response = await fetch(
    resolveWsHttpUrl(`/api/drawing/documents/${encodeURIComponent(id)}`),
    { credentials: "include" },
  );
  if (!response.ok) throw new Error("Could not load editable image document.");
  return response.json();
}
export async function saveImageEditDocument(
  input: ImageEditDocumentCreateInput,
): Promise<ImageEditDocument> {
  const response = await fetch(resolveWsHttpUrl("/api/drawing/save-document"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not save editable image document.");
  return body;
}
