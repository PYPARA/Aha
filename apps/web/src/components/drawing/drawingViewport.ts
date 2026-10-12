export type ViewPoint = { x: number; y: number };
export type DrawingView = { scale: number; x: number; y: number };
export function fitDrawingView(
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): DrawingView {
  const scale = Math.min(
    (viewport.width - 48) / image.width,
    (viewport.height - 48) / image.height,
    1,
  );
  const safe = Math.max(0.001, scale);
  return {
    scale: safe,
    x: (viewport.width - image.width * safe) / 2,
    y: (viewport.height - image.height * safe) / 2,
  };
}
export function zoomDrawingAt(view: DrawingView, point: ViewPoint, scale: number): DrawingView {
  return {
    scale,
    x: point.x - ((point.x - view.x) * scale) / view.scale,
    y: point.y - ((point.y - view.y) * scale) / view.scale,
  };
}
export function drawingPoint(view: DrawingView, point: ViewPoint): ViewPoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}
