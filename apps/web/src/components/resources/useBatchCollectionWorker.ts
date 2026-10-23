import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ResourceCollectionItem,
  ResourceCollectionOperation,
} from "@synara/contracts/resourceLibrary";
import { ensureNativeApi } from "~/nativeApi";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { resourceApi, resourceKey, fetchResource } from "./resourceLibrary";
import { batchKey } from "../imageBatches/useImageBatches";

/** Mounted in the application shell, independently of the currently visible workbench. */
export function useBatchCollectionWorker() {
  const client = useQueryClient(),
    running = useRef(false);
  const operations = useQuery({
    queryKey: [...resourceKey, "collections"],
    enabled: !!window.desktopBridge?.resourceLibrary,
    queryFn: () => resourceApi<ResourceCollectionOperation[]>({ op: "listCollections" }),
    refetchInterval: 5000,
    retry: false,
  });
  useEffect(
    () =>
      window.desktopBridge?.resourceLibrary?.onChanged(() => {
        void client.invalidateQueries({ queryKey: [...resourceKey, "collections"] });
      }),
    [client],
  );
  useEffect(() => {
    if (
      running.current ||
      !operations.data?.some(
        (operation) =>
          !operation.released &&
          (operation.items.some((item) =>
            ["queued", "writing", "committed"].includes(item.status),
          ) ||
            operation.items.every((item) => ["linked", "superseded"].includes(item.status))),
      )
    )
      return;
    running.current = true;
    void (async () => {
      for (const operation of operations.data!) {
        if (operation.released) continue;
        const items = operation.items.map((item) => ({ ...item }));
        let linked = false;
        for (const candidate of items) {
          if (!["queued", "writing", "committed"].includes(candidate.status)) continue;
          let item = candidate;
          if (item.status !== "committed") {
            try {
              const { bytes } = await fetchResource({
                name: item.name,
                url: resolveWsHttpUrl(
                  item.origin.kind === "model3d"
                    ? `/api/model3d/assets/${encodeURIComponent(item.origin.projectId!)}/${encodeURIComponent(item.origin.versionId!)}/model.glb`
                    : `/api/drawing/assets/${item.assetId}`,
                ),
              });
              item = await resourceApi<ResourceCollectionItem>({
                op: "commitCollection",
                operationId: operation.id,
                resultId: item.resultId,
                bytes,
              });
            } catch (cause) {
              candidate.status = "failed";
              await resourceApi({
                op: "failCollection",
                operationId: operation.id,
                resultId: item.resultId,
                error: cause instanceof Error ? cause.message : String(cause),
              }).catch(() => {});
              continue;
            }
          }
          if (!item.resourceId || (item.origin.kind !== "model3d" && !item.origin.batchId))
            continue;
          try {
            if (item.origin.kind !== "model3d")
              await ensureNativeApi().imageBatches.command({
                operation: "collection",
                batchId: item.origin.batchId!,
                resultId: item.resultId,
                libraryId: operation.libraryId,
                resourceId: item.resourceId,
              });
            await resourceApi({
              op: "linkCollection",
              operationId: operation.id,
              resultId: item.resultId,
            });
            candidate.status = "linked";
            linked = true;
          } catch {
            /* The committed receipt retries the link after reconnect; it never calls the image model. */
          }
        }
        // Once per operation: refetching every loaded results page per image makes the grid jump.
        if (linked) await client.invalidateQueries({ queryKey: batchKey });
        if (items.every((item) => ["linked", "superseded"].includes(item.status))) {
          try {
            for (const batchId of new Set(
              items.flatMap((item) => (item.origin.batchId ? [item.origin.batchId] : [])),
            ))
              await ensureNativeApi().imageBatches.command({
                operation: "collection-finish",
                batchId,
                operationId: operation.id,
              });
            await resourceApi({ op: "finishCollection", operationId: operation.id });
          } catch {
            /* Keep the retained originals protected until the completion acknowledgement is durable. */
          }
        }
      }
    })().finally(() => {
      running.current = false;
    });
  }, [operations.data, operations.dataUpdatedAt, client]);
  return operations;
}
