import { useEffect, useRef, useState, useCallback, type PointerEvent, type RefObject } from "react";
import {
  drawingPoint,
  fitDrawingView,
  zoomDrawingAt,
  type DrawingView,
  type ViewPoint,
} from "./drawingViewport";
export function useDrawingViewport(
  stage: RefObject<HTMLDivElement | null>,
  width: number,
  height: number,
) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const mount = useCallback(
    (node: HTMLDivElement | null) => {
      stage.current = node;
      setElement(node);
    },
    [stage],
  );
  const [view, setView] = useState<DrawingView>({ scale: 1, x: 0, y: 0 });
  const current = useRef(view);
  const pointers = useRef(new Map<number, ViewPoint>());
  const gesture = useRef<{ view: DrawingView; point: ViewPoint; distance?: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const commit = (next: DrawingView) => {
    current.current = next;
    setView(next);
  };
  const fit = () => {
    const el = stage.current;
    if (el)
      commit(fitDrawingView({ width, height }, { width: el.clientWidth, height: el.clientHeight }));
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const b = stage.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const zoom = (scale: number, point?: ViewPoint) => {
    const el = stage.current;
    if (!el) return;
    const min =
      fitDrawingView({ width, height }, { width: el.clientWidth, height: el.clientHeight }).scale /
      4;
    commit(
      zoomDrawingAt(
        current.current,
        point ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 },
        Math.min(8, Math.max(min, scale)),
      ),
    );
  };
  useEffect(() => {
    const el = element;
    if (!el) return;
    commit(fitDrawingView({ width, height }, { width: el.clientWidth, height: el.clientHeight }));
    const resize = new ResizeObserver(() => {
      commit(fitDrawingView({ width, height }, { width: el.clientWidth, height: el.clientHeight }));
    });
    resize.observe(el);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const p = { x: e.clientX - b.left, y: e.clientY - b.top };
      if (e.altKey || e.ctrlKey || e.metaKey) {
        const old = current.current;
        const min =
          fitDrawingView({ width, height }, { width: el.clientWidth, height: el.clientHeight })
            .scale / 4;
        commit(
          zoomDrawingAt(
            old,
            p,
            Math.min(8, Math.max(min, old.scale * Math.exp(-e.deltaY * 0.005))),
          ),
        );
      } else
        commit({
          ...current.current,
          x: current.current.x - e.deltaX,
          y: current.current.y - e.deltaY,
        });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      resize.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [element, width, height]);
  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b
      ? {
          point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          distance: Math.hypot(a.x - b.x, a.y - b.y),
        }
      : null;
  };
  return {
    mount,
    view,
    panning,
    fit,
    zoom,
    point: (e: { clientX: number; clientY: number }) => drawingPoint(current.current, local(e)),
    down: (e: PointerEvent, hand: boolean) => {
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      const two = pair();
      if (two) {
        gesture.current = { view: current.current, ...two };
        setPanning(true);
        return true;
      }
      if (hand || e.altKey || e.button === 1) {
        gesture.current = { view: current.current, point: p };
        setPanning(true);
        return true;
      }
      return false;
    },
    move: (e: PointerEvent) => {
      if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
      const g = gesture.current;
      if (!g) return false;
      const two = pair();
      if (g.distance && two) {
        const next = zoomDrawingAt(
          g.view,
          g.point,
          Math.min(8, Math.max(0.001, (g.view.scale * two.distance) / Math.max(1, g.distance))),
        );
        commit({
          ...next,
          x: next.x + two.point.x - g.point.x,
          y: next.y + two.point.y - g.point.y,
        });
      } else {
        const p = local(e);
        commit({ ...g.view, x: g.view.x + p.x - g.point.x, y: g.view.y + p.y - g.point.y });
      }
      return true;
    },
    up: (e: PointerEvent) => {
      const was = Boolean(gesture.current);
      pointers.current.delete(e.pointerId);
      if (!pointers.current.size) {
        gesture.current = null;
        setPanning(false);
      } else if (was) {
        const p = [...pointers.current.values()][0]!;
        gesture.current = { view: current.current, point: p };
      }
      return was;
    },
  };
}
