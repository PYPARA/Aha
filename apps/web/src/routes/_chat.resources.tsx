import { createFileRoute } from "@tanstack/react-router";
import ResourceCenter from "~/components/resources/ResourceCenter";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { useRailShellStore } from "~/railShellStore";
export const Route = createFileRoute("/_chat/resources")({
  beforeLoad: () => useRailShellStore.getState().selectRouteItem("resources"),
  component: ResourceRoute,
});
function ResourceRoute() {
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader className="shrink-0" />
        <div className="app-content-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--app-rail-block-radii,0px)]">
          <ResourceCenter />
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
