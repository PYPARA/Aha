import { createFileRoute } from "@tanstack/react-router";
import SpriteWorkbench from "~/components/sprite/SpriteWorkbench";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { useRailShellStore } from "~/railShellStore";
export const Route = createFileRoute("/_chat/sprite-animation")({
  beforeLoad: () => {
    useRailShellStore.getState().selectRouteItem("spriteAnimation");
  },
  component: SpriteAnimationRoute,
});

function SpriteAnimationRoute() {
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader className="shrink-0" />
        <div className="app-content-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--app-rail-block-radii,0px)]">
          <SpriteWorkbench />
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
