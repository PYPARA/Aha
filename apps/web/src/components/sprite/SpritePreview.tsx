import { useEffect, useRef, useState } from "react";
import { spriteFrameGeometry, type SpriteProject, type SpriteFrame } from "./spriteModel";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
export function SpritePreview({
  project,
  frame,
  previous,
  next,
  reference = false,
  grid,
  onOffset,
  zoom: controlledZoom,
  onZoomChange,
}: {
  project: SpriteProject;
  frame?: SpriteFrame | undefined;
  previous?: SpriteFrame | undefined;
  next?: SpriteFrame | undefined;
  reference?: boolean;
  grid?: SpriteFrame[];
  onOffset?: ((x: number, y: number) => void) | undefined;
  zoom?: "fit" | "native" | "logical" | undefined;
  onZoomChange?: ((zoom: "fit" | "native" | "logical") => void) | undefined;
}) {
  const tr = useAhaTranslation();
  const [localZoom, setLocalZoom] = useState<"fit" | "native" | "logical">("fit");
  const zoom = controlledZoom ?? localZoom,
    setZoom = onZoomChange ?? setLocalZoom;
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
    ctx.imageSmoothingEnabled = project.renderSpec?.mode === "illustration";
    const draw = (f: SpriteFrame, opacity: number) => {
      const geometry = spriteFrameGeometry(project, f);
      const image = bitmaps.get(geometry.source?.id);
      // Source replacement closes the previous bitmap set before the new decode resolves.
      if (!image || image.width === 0) return;
      ctx.globalAlpha = opacity;
      ctx.drawImage(
        image,
        geometry.sx,
        geometry.sy,
        geometry.sw,
        geometry.sh,
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
      );
    };
    if (grid && frame) {
      const source = bitmaps.get(frame.sourceId);
      if (source && source.width > 0) ctx.drawImage(source, 0, 0);
      ctx.strokeStyle = getComputedStyle(canvas).color;
      ctx.lineWidth = Math.max(1, canvas.width / 600);
      for (const cell of grid) ctx.strokeRect(cell.x, cell.y, cell.width, cell.height);
    } else {
      if (previous) draw(previous, 0.22);
      if (next) draw(next, 0.15);
      if (reference && project.referenceSourceId) {
        const base = bitmaps.get(project.referenceSourceId);
        if (base && base.width) {
          ctx.globalAlpha = 0.2;
          ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
        }
      }
      if (frame) draw(frame, 1);
      if (project.canonical && !grid) {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = getComputedStyle(canvas).color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const y =
          (project.canonical.pivotY / project.canonical.renderSpec.logicalHeight) * canvas.height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
  }, [bitmaps, frame, previous, next, reference, grid, project]);
  return (
    <div
      data-sprite-preview
      className="relative flex min-h-40 min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto rounded-lg bg-muted/20 p-3"
    >
      {!grid && (
        <div className="flex gap-2 text-xs">
          <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
            {tr("Fit")}
          </button>
          <button type="button" aria-pressed={zoom === "native"} onClick={() => setZoom("native")}>
            100%
          </button>
          {project.renderSpec?.mode === "pixel" && (
            <button
              type="button"
              aria-pressed={zoom === "logical"}
              onClick={() => setZoom("logical")}
            >
              {tr("Logical pixels")} 1×
            </button>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={project.width}
        height={project.height}
        aria-label={tr("Sprite animation preview")}
        tabIndex={onOffset ? 0 : undefined}
        className="shrink-0 touch-none border-b border-b-warning text-warning"
        style={{
          width:
            zoom === "native"
              ? project.width
              : zoom === "logical"
                ? (project.renderSpec?.logicalWidth ?? project.width)
                : "min(100%, 420px)",
          maxWidth: zoom === "fit" ? "100%" : undefined,
          imageRendering: project.renderSpec?.mode === "illustration" ? "auto" : "pixelated",
          height: "auto",
          aspectRatio: `${project.width} / ${project.height}`,
          maxHeight: zoom === "fit" ? "100%" : undefined,
          objectFit: "contain",
          backgroundColor: "var(--color-background-control-opaque)",
          backgroundImage:
            "repeating-conic-gradient(color-mix(in srgb,var(--foreground) 6%,transparent) 0% 25%,transparent 0% 50%)",
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
          const original = project.sources.find((s) => s.id === frame?.sourceId);
          const master = original?.masterSourceId
            ? project.sources.find((s) => s.id === original.masterSourceId)
            : undefined;
          const factor = master && original ? original.width / master.width : 1;
          const multiplier = master ? factor / (project.renderSpec?.outputScale ?? 1) : 1;
          const snap =
            project.renderSpec?.mode === "pixel"
              ? master
                ? factor
                : project.renderSpec.outputScale
              : 1;
          onOffset(
            Math.round(
              (start.dx + (((e.clientX - start.x) * project.width) / bounds.width) * multiplier) /
                snap,
            ) * snap,
            Math.round(
              (start.dy + (((e.clientY - start.y) * project.height) / bounds.height) * multiplier) /
                snap,
            ) * snap,
          );
        }}
        onKeyDown={(e) => {
          if (
            !frame ||
            !onOffset ||
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          )
            return;
          e.preventDefault();
          const original = project.sources.find((s) => s.id === frame.sourceId),
            master = project.sources.find((s) => s.id === original?.masterSourceId);
          const step =
            (project.renderSpec?.mode === "pixel"
              ? master && original
                ? original.width / master.width
                : project.renderSpec.outputScale
              : 1) * (e.shiftKey ? 10 : 1);
          onOffset(
            frame.offsetX + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0),
            frame.offsetY + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0),
          );
        }}
      />
    </div>
  );
}
export function SpriteThumbnail({
  blob,
  label,
  compact = false,
  pixelated = false,
}: {
  blob: Blob;
  label: string;
  compact?: boolean;
  pixelated?: boolean;
}) {
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
      className={`${compact ? "size-8" : "size-12"} shrink-0 object-contain`}
      style={{ imageRendering: pixelated ? "pixelated" : "auto" }}
    />
  );
}

export function FrameThumbnail({
  source,
  frame,
  pixelated = false,
}: {
  pixelated?: boolean;
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
        className="absolute max-w-none"
        style={{
          imageRendering: pixelated ? "pixelated" : "auto",
          width: source.width * scale,
          height: source.height * scale,
          left: -frame.x * scale,
          top: -frame.y * scale,
        }}
      />
    </div>
  );
}
