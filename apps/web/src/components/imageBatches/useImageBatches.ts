import { useEffect } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ImageBatchCommand, ImageBatchResultsInput, ImageBatchState } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const batchApi = () => ensureNativeApi().imageBatches;
export const batchKey = ["image-batches"] as const;
export function useBatchEvents() {
  const client = useQueryClient();
  useEffect(
    () =>
      batchApi().onEvent(() => {
        void client.invalidateQueries({ queryKey: batchKey });
      }),
    [client],
  );
}
export function useBatch(id: string | null) {
  return useQuery({
    queryKey: [...batchKey, "detail", id],
    enabled: !!id,
    queryFn: () => batchApi().get({ id: id! }),
  });
}
export function useBatchList(
  query: string,
  filter: "all" | "draft" | "active" | "issues" | "archived",
) {
  return useInfiniteQuery({
    queryKey: [...batchKey, "list", query, filter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      batchApi().list({ query, filter, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
}
export function useBatchResults(input: Omit<typeof ImageBatchResultsInput.Type, "cursor">) {
  return useInfiniteQuery({
    queryKey: [...batchKey, "results", input],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      batchApi().results({ ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
}
export function useBatchCommand() {
  const client = useQueryClient();
  return async (input: ImageBatchCommand): Promise<ImageBatchState> => {
    const state = await batchApi().command(input);
    client.setQueryData([...batchKey, "detail", state.id], state);
    await client.invalidateQueries({ queryKey: batchKey });
    return state;
  };
}
