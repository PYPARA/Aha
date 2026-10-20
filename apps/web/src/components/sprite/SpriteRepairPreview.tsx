import { useEffect, useRef, useState } from "react";
import type { ImageAsset, SpriteEditDescription, SpriteRun } from "@synara/contracts";
import { imageUrl } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
type Frame = SpriteEditDescription["actions"][number]["frames"][number];
export function SpriteRepairPreview({
  run,
  edit,
  frame,
  onCanvas,
  onMove,
  onAnchor,
  onion,
  baseline,
  reference,
  anchorMode = false,
  offset,
  processedAsset,
  maxHeight = 480,
}: {
  run: SpriteRun;
  edit: SpriteEditDescription;
  frame: Frame | undefined;
  onCanvas?: (canvas: HTMLCanvasElement) => void;
  onMove?: (x: number, y: number) => void;
  onAnchor?: (x: number, y: number) => void;
  onion?: Frame | undefined;
  baseline?: Frame | undefined;
  reference?: boolean;
  anchorMode?: boolean;
  offset?: { offsetX: number; offsetY: number } | undefined;
  processedAsset?: ImageAsset | undefined;
  maxHeight?: number;
}) {
  const tr = useAhaTranslation(),
    canvasRef = useRef<HTMLCanvasElement>(null),
    drag = useRef<{ x: number; y: number } | null>(null),
    sourceCanvas = useRef<HTMLCanvasElement | null>(null),
    processedCanvas = useRef<ImageBitmap | null>(null);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  const source =
    run.candidates?.find((c) => c.id === run.selectedCandidateId)?.source ?? run.source;
  const sourceUrl = source ? imageUrl(source) : "",
    processedUrl = processedAsset ? imageUrl(processedAsset) : "";
  const { width, height, background, chromaKey } = run.context,
    mode = run.context.renderSpec?.mode,
    outputScale = run.context.renderSpec?.outputScale ?? 1,
    canonical = run.context.canonical;
  const pivotX = canonical
      ? (canonical.pivotX / canonical.renderSpec.logicalWidth) * width
      : width * 0.5,
    pivotY = canonical
      ? (canonical.pivotY / canonical.renderSpec.logicalHeight) * height
      : height * 0.9;
  useEffect(() => {
    if (!sourceUrl) return;
    let alive = true;
    const abort = new AbortController();
    setError("");
    void (async () => {
      const response = await fetch(sourceUrl, { credentials: "include", signal: abort.signal });
      if (!response.ok) throw new Error("Could not load source image.");
      const bitmap = await createImageBitmap(await response.blob());
      if (!alive) {
        bitmap.close();
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (background === "chroma") {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height),
          key = [1, 3, 5].map((i) => parseInt(chromaKey.slice(i, i + 2), 16));
        for (let i = 0; i < data.data.length; i += 4) {
          const distance = Math.sqrt(
              key.reduce((sum, k, j) => sum + (data.data[i + j]! - k) ** 2, 0),
            ),
            alpha = Math.max(0, Math.min(1, (distance - 36) / 64));
          data.data[i + 3] = Math.round(alpha * data.data[i + 3]!);
          for (let j = 0; j < 3; j++)
            data.data[i + j] = alpha
              ? Math.round(
                  Math.max(0, Math.min(255, (data.data[i + j]! - (1 - alpha) * key[j]!) / alpha)),
                )
              : 0;
        }
        ctx.putImageData(data, 0, 0);
      }
      if (alive) {
        sourceCanvas.current = canvas;
        setRevision((n) => n + 1);
      }
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
      abort.abort();
      sourceCanvas.current = null;
    };
  }, [sourceUrl, background, chromaKey]);
  useEffect(() => {
    processedCanvas.current?.close();
    processedCanvas.current = null;
    if (!processedUrl) {
      setRevision((n) => n + 1);
      return;
    }
    let alive = true;
    const abort = new AbortController();
    void fetch(processedUrl, { credentials: "include", signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Could not load processed preview.");
        return r.blob();
      })
      .then(createImageBitmap)
      .then((bitmap) => {
        if (!alive) {
          bitmap.close();
          return;
        }
        processedCanvas.current = bitmap;
        setRevision((n) => n + 1);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      abort.abort();
      processedCanvas.current?.close();
      processedCanvas.current = null;
    };
  }, [processedUrl]);
  useEffect(() => {
    const canvas = canvasRef.current,
      source = sourceCanvas.current;
    if (!canvas || !source) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    const draw = (f: Frame | undefined, alpha: number, override?: typeof offset) => {
      if (!f) return;
      const cell = edit.cells.find((c) => c.id === f.cellId);
      if (!cell) return;
      const common = edit.common,
        fit = Math.min(width / common.canvasWidth, height / common.canvasHeight),
        r = common.registration;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = mode !== "pixel";
      ctx.translate(override?.offsetX ?? f.offsetX, override?.offsetY ?? f.offsetY);
      ctx.translate(pivotX + r.offsetX * outputScale, pivotY + r.offsetY * outputScale);
      ctx.scale(r.scale, r.scale);
      ctx.translate(-pivotX, -pivotY);
      ctx.drawImage(
        source,
        cell.x,
        cell.y,
        cell.width,
        cell.height,
        (width - common.canvasWidth * fit) / 2 + (common.anchorX + cell.x - cell.originX) * fit,
        (height - common.canvasHeight * fit) / 2 + (common.anchorY + cell.y - cell.originY) * fit,
        cell.width * fit,
        cell.height * fit,
      );
      ctx.restore();
    };
    if (processedCanvas.current && !offset)
      ctx.drawImage(processedCanvas.current, 0, 0, width, height);
    else draw(frame, 1, offset);
    // Anchor analysis receives only the active frame, excluding onion skin and reference overlays.
    const active = document.createElement("canvas");
    active.width = width;
    active.height = height;
    active.getContext("2d")!.drawImage(canvas, 0, 0);
    onCanvas?.(active);
    ctx.clearRect(0, 0, width, height);
    draw(onion, 0.22);
    draw(baseline, 0.22);
    ctx.drawImage(active, 0, 0);
  }, [
    edit,
    frame,
    onion,
    baseline,
    width,
    height,
    mode,
    outputScale,
    pivotX,
    pivotY,
    onCanvas,
    offset,
    revision,
  ]);
  return (
    <div className="w-full">
      <div
        className="sb-checker relative mx-auto w-full max-w-[480px]"
        style={{
          aspectRatio: `${width}/${height}`,
          maxWidth: Math.max(96, Math.min(480, ((maxHeight - 30) * width) / height)),
        }}
      >
        {reference && canonical && (
          <img
            alt=""
            src={imageUrl(canonical.asset)}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-25"
          />
        )}
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          role="img"
          aria-label={tr("Frame alignment preview")}
          className="relative h-full w-full touch-none"
          style={{ imageRendering: mode === "pixel" ? "pixelated" : "auto" }}
          onPointerDown={(e) => {
            if (!frame) return;
            const b = e.currentTarget.getBoundingClientRect();
            if (anchorMode) {
              onAnchor?.(
                ((e.clientX - b.left) * width) / b.width - frame.offsetX,
                ((e.clientY - b.top) * height) / b.height - frame.offsetY,
              );
              return;
            }
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            const b = e.currentTarget.getBoundingClientRect();
            onMove?.(
              Math.round(((e.clientX - drag.current.x) * width) / b.width),
              Math.round(((e.clientY - drag.current.y) * height) / b.height),
            );
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-primary/60"
          style={{ top: `${(pivotY / height) * 100}%` }}
        />
        {frame?.anchor && (
          <div
            aria-hidden
            className="pointer-events-none absolute size-3 -translate-1/2 rounded-full border-2 border-primary"
            style={{
              left: `${((frame.anchor.x + frame.offsetX) / width) * 100}%`,
              top: `${((frame.anchor.y + frame.offsetY) / height) * 100}%`,
            }}
          />
        )}
      </div>
      <p className="mt-2 text-center text-ui-sm text-muted-foreground">
        {tr(
          processedUrl
            ? "Processed output preview"
            : "Live draft preview. Validate processing to inspect the rendered output.",
        )}
      </p>
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {tr(error)}
        </p>
      )}
    </div>
  );
}
