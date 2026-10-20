import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  createPanelResizeOverlay,
  removePanelResizeOverlay,
  attachPanelPointerOverlaySession,
} from "~/lib/panelResize";

export function SpriteResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  horizontal = false,
  reverse = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  horizontal?: boolean;
  reverse?: boolean;
}) {
  const change = (n: number) => onChange(Math.max(min, Math.min(max, n)));
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    cleanup.current?.();
    event.preventDefault();
    const origin = horizontal ? event.clientY : event.clientX;
    const overlay = createPanelResizeOverlay(horizontal ? "row-resize" : "col-resize");
    const move = (e: PointerEvent) =>
      change(value + ((horizontal ? e.clientY : e.clientX) - origin) * (reverse ? -1 : 1));
    const end = () => {
      detach();
      removePanelResizeOverlay(overlay);
      cleanup.current = null;
    };
    const detach = attachPanelPointerOverlaySession(overlay, {
      onMove: move,
      onRelease: end,
      onAbort: end,
    });
    cleanup.current = end;
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`sb-resize ${horizontal ? "sb-resize-horizontal" : ""}`}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault();
          change(
            value + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -10 : 10) * (reverse ? -1 : 1),
          );
        }
      }}
    />
  );
}
