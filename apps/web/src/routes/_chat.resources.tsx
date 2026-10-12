import { createFileRoute } from "@tanstack/react-router";
import ResourceCenter from "~/components/resources/ResourceCenter";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "~/components/chat/chatHeaderControls";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useRailShellStore } from "~/railShellStore";
import { cn } from "~/lib/utils";
export const Route = createFileRoute("/_chat/resources")({
  beforeLoad: () => useRailShellStore.getState().selectRouteItem("resources"),
  component: ResourceRoute,
});
function ResourceRoute() {
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  return (
    <RouteInsetSurface>
      <ResourceCenter
        headerClassName={cn(
          CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          "py-0",
          trafficLightGutter,
          windowControlsGutter,
        )}
      />
    </RouteInsetSurface>
  );
}
