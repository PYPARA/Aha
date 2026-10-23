import { createFileRoute } from "@tanstack/react-router";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface } from "~/components/RouteSurface";
import Model3DWorkbench from "~/components/model3d/Model3DWorkbench";
import { useRailShellStore } from "~/railShellStore";

export const Route = createFileRoute("/_chat/model3d")({
  validateSearch: (search: Record<string, unknown>): { projectId?: string } =>
    typeof search.projectId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(search.projectId)
      ? { projectId: search.projectId }
      : {},
  beforeLoad: () => useRailShellStore.getState().selectRouteItem("model3d"),
  component: () => (
    <RouteInsetSurface>
      <RouteSurface>
        <div className="app-content-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--app-rail-block-radii,0px)]">
          <Model3DWorkbench {...Route.useSearch()} />
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  ),
});
