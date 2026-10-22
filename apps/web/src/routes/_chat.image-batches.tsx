import { createFileRoute } from "@tanstack/react-router";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface } from "~/components/RouteSurface";
import ImageBatchWorkbench from "~/components/imageBatches/ImageBatchWorkbench";
import { useRailShellStore } from "~/railShellStore";

export const Route = createFileRoute("/_chat/image-batches")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { batchId?: string; taskId?: string; resultId?: string } =>
    Object.fromEntries(
      ["batchId", "taskId", "resultId"].flatMap((key) =>
        typeof search[key] === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(search[key])
          ? [[key, search[key]]]
          : [],
      ),
    ),
  beforeLoad: () => useRailShellStore.getState().selectRouteItem("imageBatches"),
  component: () => (
    <RouteInsetSurface>
      <RouteSurface>
        <div className="app-content-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--app-rail-block-radii,0px)]">
          <ImageBatchWorkbench {...Route.useSearch()} />
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  ),
});
