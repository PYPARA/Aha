import { createFileRoute } from "@tanstack/react-router";
import SpriteLibrary from "~/components/sprite/SpriteLibrary";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface } from "~/components/RouteSurface";
import { useRailShellStore } from "~/railShellStore";
export const Route = createFileRoute("/_chat/sprite-animation")({
  validateSearch: (search: Record<string, unknown>): { projectId?: string } =>
    typeof search.projectId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(search.projectId)
      ? { projectId: search.projectId }
      : {},
  beforeLoad: () => {
    useRailShellStore.getState().selectRouteItem("spriteAnimation");
  },
  component: SpriteAnimationRoute,
});

function SpriteAnimationRoute() {
  const { projectId } = Route.useSearch();
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <div className="app-content-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--app-rail-block-radii,0px)]">
          <SpriteLibrary projectId={projectId} />
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
