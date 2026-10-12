export type CanvasPoint = { x: number; y: number };
export type CanvasCommand = {
  tool: "brush" | "eraser" | "rectangle" | "arrow" | "text" | "fill" | "clear";
  points: CanvasPoint[];
  color: string;
  width: number;
  text?: string;
};
export function imagePoint(
  client: CanvasPoint,
  bounds: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): CanvasPoint {
  return {
    x: ((client.x - bounds.left) * size.width) / bounds.width,
    y: ((client.y - bounds.top) * size.height) / bounds.height,
  };
}
export function drawCanvasCommand(
  ctx: CanvasRenderingContext2D,
  command: CanvasCommand,
  mask: boolean,
) {
  const points = command.points;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = command.width;
  ctx.strokeStyle = mask ? "#f43f5e" : command.color;
  ctx.fillStyle = mask ? "#f43f5e" : command.color;
  ctx.globalCompositeOperation = command.tool === "eraser" ? "destination-out" : "source-over";
  if (command.tool === "fill") ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  else if (command.tool === "clear") ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  else if (points[0]) {
    const first = points[0],
      last = points.at(-1)!;
    if (command.tool === "text") {
      ctx.font = `${Math.max(16, command.width * 3)}px system-ui`;
      ctx.textBaseline = "top";
      ctx.fillText(command.text ?? "", first.x, first.y);
    } else if (command.tool === "rectangle")
      ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
    else if (command.tool === "arrow") {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      const angle = Math.atan2(last.y - first.y, last.x - first.x),
        length = Math.max(12, command.width * 3);
      ctx.moveTo(
        last.x - length * Math.cos(angle - Math.PI / 6),
        last.y - length * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(last.x, last.y);
      ctx.lineTo(
        last.x - length * Math.cos(angle + Math.PI / 6),
        last.y - length * Math.sin(angle + Math.PI / 6),
      );
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      if (points.length === 1) {
        ctx.arc(first.x, first.y, command.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
// Selection alpha is one for edited pixels; the API mask uses zero for those pixels.
export function selectionToMask(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = 255 - data[i + 3]!;
  }
  return out;
}
