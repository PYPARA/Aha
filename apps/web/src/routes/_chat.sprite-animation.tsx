import { createFileRoute } from "@tanstack/react-router";
import SpriteWorkbench from "~/components/sprite/SpriteWorkbench";
import { useRailShellStore } from "~/railShellStore";
export const Route = createFileRoute("/_chat/sprite-animation")({
  beforeLoad: () => {
    useRailShellStore.getState().selectRouteItem("spriteAnimation");
  },
  component: SpriteWorkbench,
});
