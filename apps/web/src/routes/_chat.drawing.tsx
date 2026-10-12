import { createFileRoute } from "@tanstack/react-router";
import DrawingWorkbench from "~/components/drawing/DrawingWorkbench";
import { useRailShellStore } from "~/railShellStore";
export const Route = createFileRoute("/_chat/drawing")({
  beforeLoad: () => {
    useRailShellStore.getState().selectRouteItem("drawing");
  },
  component: DrawingWorkbench,
});
