import { useEffect, useRef, useState } from "react";
import { framePlacement, type SpriteProject, type SpriteFrame } from "./spriteModel";
export function SpritePreview({
  project,
  frame,
  previous,
  grid,
  onOffset,
}: {
  project: SpriteProject;
  frame?: SpriteFrame;
  previous?: SpriteFrame;
  grid?: SpriteFrame[];
  onOffset?: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bitmaps, setBitmaps] = useState<Map<string, ImageBitmap>>(new Map());
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  useEffect(() => {
    let disposed = false;
    const loaded = new Map<string, ImageBitmap>();
    void Promise.all(
      project.sources.map(async (source) => {
        const bitmap = await createImageBitmap(source.blob);
        if (disposed) bitmap.close();
        else loaded.set(source.id, bitmap);
      }),
    )
      .then(() => {
        if (!disposed) setBitmaps(loaded);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      for (const bitmap of loaded.values()) bitmap.close();
    };
  }, [project.sources]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    const draw = (f: SpriteFrame, opacity: number) => {
      const image = bitmaps.get(f.sourceId);
      // Source replacement closes the previous bitmap set before the new decode resolves.
      if (!image || image.width === 0) return;
      const p = framePlacement(f, canvas.width, canvas.height);
      ctx.globalAlpha = opacity;
      ctx.drawImage(image, f.x, f.y, f.width, f.height, p.x, p.y, f.width, f.height);
    };
    if (grid && frame) {
      const source = bitmaps.get(frame.sourceId);
      if (source && source.width > 0) ctx.drawImage(source, 0, 0);
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = Math.max(1, canvas.width / 600);
      for (const cell of grid) ctx.strokeRect(cell.x, cell.y, cell.width, cell.height);
    } else {
      if (previous) draw(previous, 0.22);
      if (frame) draw(frame, 1);
    }
    ctx.globalAlpha = 1;
  }, [bitmaps, frame, previous, grid, project.width, project.height]);
  return (
    <div className="relative flex min-h-48 flex-1 items-center justify-center overflow-auto rounded-lg border bg-muted/20 p-5">
      <canvas
        ref={canvasRef}
        width={project.width}
        height={project.height}
        aria-label="Sprite animation preview"
        className="max-w-full shrink-0 touch-none border-b border-b-orange-400 [image-rendering:pixelated]"
        style={{
          width: Math.min(512, Math.max(256, project.width)),
          height: "auto",
          aspectRatio: `${project.width} / ${project.height}`,
          backgroundColor: "#d1d5db",
          backgroundImage:
            "conic-gradient(#9ca3af 25%,transparent 0 50%,#9ca3af 0 75%,transparent 0)",
          backgroundSize: "20px 20px",
        }}
        onPointerDown={(e) => {
          if (!frame || !onOffset || grid) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, dx: frame.offsetX, dy: frame.offsetY };
        }}
        onPointerUp={(e) => {
          const start = drag.current;
          drag.current = null;
          if (!start || !onOffset) return;
          const bounds = e.currentTarget.getBoundingClientRect();
          onOffset(
            start.dx + Math.round(((e.clientX - start.x) * project.width) / bounds.width),
            start.dy + Math.round(((e.clientY - start.y) * project.height) / bounds.height),
          );
        }}
      />
    </div>
  );
}
export function SpriteThumbnail({ blob, label }: { blob: Blob; label: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return (
    <img
      src={url || undefined}
      alt={label}
      className="size-12 object-contain [image-rendering:pixelated]"
    />
  );
}

export function FrameThumbnail({
  source,
  frame,
}: {
  source: import("./spriteModel").SpriteSource;
  frame: SpriteFrame;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(source.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source.blob]);
  const scale = 40 / Math.max(frame.width, frame.height);
  return (
    <div
      className="relative m-1 overflow-hidden"
      style={{ width: frame.width * scale, height: frame.height * scale }}
    >
      <img
        alt=""
        draggable={false}
        src={url || undefined}
        className="absolute max-w-none [image-rendering:pixelated]"
        style={{
          width: source.width * scale,
          height: source.height * scale,
          left: -frame.x * scale,
          top: -frame.y * scale,
        }}
      />
    </div>
  );
}
