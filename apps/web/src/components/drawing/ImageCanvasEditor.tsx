import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { ImageAsset } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { imageUrl } from "./useDrawing";
import {
  drawCanvasCommand,
  imagePoint,
  selectionToMask,
  type CanvasCommand,
  type CanvasPoint,
} from "./imageCanvas";

async function loadBitmap(url: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load image.");
  return createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
}
export function ImageCanvasEditor({
  mode,
  base,
  mask,
  onClose,
  onSave,
}: {
  mode: "annotation" | "mask";
  base: ImageAsset | null;
  mask: ImageAsset | null;
  onClose: () => void;
  onSave: (blob: Blob) => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseBitmap = useRef<ImageBitmap | null>(null);
  const initialSelection = useRef<HTMLCanvasElement | null>(null);
  const active = useRef<CanvasCommand | null>(null);
  const panStart = useRef<{ point: CanvasPoint; pan: CanvasPoint } | null>(null);
  const [commands, setCommands] = useState<CanvasCommand[]>([]);
  const [redo, setRedo] = useState<CanvasCommand[]>([]);
  const [tool, setTool] = useState<CanvasCommand["tool"] | "hand">("brush");
  const [color, setColor] = useState("#f43f5e");
  const [width, setWidth] = useState(20);
  const [text, setText] = useState("");
  const [zoom, setZoom] = useState(0.5);
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = { width: base?.width ?? 1024, height: base?.height ?? 1024 };
  const render = useCallback(
    (all: CanvasCommand[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (initialSelection.current) ctx.drawImage(initialSelection.current, 0, 0);
      for (const command of all) drawCanvasCommand(ctx, command, mode === "mask");
    },
    [mode],
  );
  useEffect(() => {
    setLoading(true);
    setReady(false);
    let disposed = false;
    void (async () => {
      try {
        if (base) {
          const bitmap = await loadBitmap(imageUrl(base, "edit"));
          if (disposed) {
            bitmap.close();
            return;
          }
          baseBitmap.current = bitmap;
        }
        if (mask && mode === "mask") {
          const bitmap = await loadBitmap(imageUrl(mask, "edit"));
          if (disposed) {
            bitmap.close();
            return;
          }
          const initial = document.createElement("canvas");
          initial.width = size.width;
          initial.height = size.height;
          const ctx = initial.getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const pixels = ctx.getImageData(0, 0, initial.width, initial.height);
          pixels.data.set(selectionToMask(pixels.data));
          ctx.putImageData(pixels, 0, 0);
          ctx.globalCompositeOperation = "source-in";
          ctx.fillStyle = "#f43f5e";
          ctx.fillRect(0, 0, initial.width, initial.height);
          ctx.globalCompositeOperation = "source-over";
          initialSelection.current = initial;
        }
        if (!disposed) {
          setLoading(false);
          setReady(true);
          render([]);
        }
      } catch (e) {
        if (!disposed) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      disposed = true;
      baseBitmap.current?.close();
      baseBitmap.current = null;
    };
  }, [base, mask, mode, size.width, size.height, render]);
  useEffect(() => {
    render(commands);
  }, [commands, render]);
  const add = (command: CanvasCommand) => {
    setCommands((old) => [...old, command]);
    setRedo([]);
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) =>
    imagePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      size,
    );
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (loading || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "hand" || event.altKey || event.button === 1) {
      panStart.current = { point: { x: event.clientX, y: event.clientY }, pan };
      return;
    }
    if (event.button !== 0) return;
    if (tool === "text" && !text.trim()) return;
    active.current = {
      tool,
      points: [point(event)],
      color,
      width,
      ...(tool === "text" ? { text } : {}),
    };
    render([...commands, active.current]);
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (panStart.current) {
      setPan({
        x: panStart.current.pan.x + event.clientX - panStart.current.point.x,
        y: panStart.current.pan.y + event.clientY - panStart.current.point.y,
      });
      return;
    }
    if (!active.current) return;
    const command = active.current;
    if (command.tool === "brush" || command.tool === "eraser") command.points.push(point(event));
    else command.points = [command.points[0]!, point(event)];
    render([...commands, command]);
  };
  const up = () => {
    panStart.current = null;
    if (active.current) {
      add(active.current);
      active.current = null;
    }
  };
  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    setError(null);
    try {
      const output = document.createElement("canvas");
      output.width = size.width;
      output.height = size.height;
      const ctx = output.getContext("2d")!;
      if (mode === "mask") {
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, size.width, size.height);
        if (!pixels.data.some((v, i) => i % 4 === 3 && v > 0))
          throw new Error(tr("Paint an area to regenerate first."));
        pixels.data.set(selectionToMask(pixels.data));
        ctx.putImageData(pixels, 0, 0);
      } else {
        if (baseBitmap.current) ctx.drawImage(baseBitmap.current, 0, 0);
        else {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size.width, size.height);
        }
        ctx.drawImage(canvas, 0, 0);
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not export image."))),
          "image/png",
        ),
      );
      await onSave(blob);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{tr(mode === "mask" ? "Mask editor" : "Annotation canvas")}</DialogTitle>
          <DialogDescription>
            {tr(
              mode === "mask"
                ? "Painted areas will be regenerated. Erase to preserve an area."
                : "Draw annotations and export them as a reference image.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {(
              [
                "brush",
                "eraser",
                ...(mode === "annotation" ? ["rectangle", "arrow", "text"] : []),
                "hand",
              ] as const
            ).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={tool === value ? "default" : "outline"}
                onClick={() => setTool(value as typeof tool)}
              >
                {tr(value)}
              </Button>
            ))}
            {mode === "annotation" ? (
              <input
                aria-label={tr("Brush color")}
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            ) : null}
            <label className="text-xs flex items-center gap-1">
              {tr("Brush size")}
              <input
                type="range"
                min={2}
                max={100}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              />
            </label>
            {tool === "text" ? (
              <Input
                aria-label={tr("Annotation text")}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-48"
              />
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!commands.length}
              onClick={() => {
                setRedo((old) => [...old, commands.at(-1)!]);
                setCommands((old) => old.slice(0, -1));
              }}
            >
              {tr("Undo")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!redo.length}
              onClick={() => {
                setCommands((old) => [...old, redo.at(-1)!]);
                setRedo((old) => old.slice(0, -1));
              }}
            >
              {tr("Redo")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => add({ tool: "clear", points: [], color, width })}
            >
              {tr("Clear")}
            </Button>
            {mode === "mask" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => add({ tool: "fill", points: [], color, width })}
              >
                {tr("Select all")}
              </Button>
            ) : null}
          </div>
          <div
            className="relative h-[50vh] min-h-64 overflow-hidden rounded-xl border bg-muted/30 touch-none"
            onWheel={(e) => {
              setZoom((old) => Math.min(4, Math.max(0.1, old * (e.deltaY < 0 ? 1.1 : 0.9))));
            }}
          >
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                width: size.width,
                height: size.height,
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              {base ? (
                <img
                  src={imageUrl(base, "edit")}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full pointer-events-none"
                />
              ) : (
                <div className="absolute inset-0 bg-white" />
              )}
              <canvas
                ref={canvasRef}
                width={size.width}
                height={size.height}
                style={{
                  opacity: mode === "mask" ? 0.55 : 1,
                  cursor: tool === "hand" ? "grab" : "crosshair",
                }}
                className="relative touch-none"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              />
            </div>
            {loading ? (
              <p className="absolute inset-x-0 top-4 text-center">{tr("Loading...")}</p>
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setZoom((old) => Math.max(0.1, old / 1.2))}
            >
              −
            </Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setZoom((old) => Math.min(4, old * 1.2))}
            >
              +
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setZoom(0.5);
                setPan({ x: 0, y: 0 });
              }}
            >
              {tr("Reset view")}
            </Button>
            <span>
              {size.width} × {size.height} · {tr("Alt-drag to pan")}
            </span>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive mt-2">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void save()}>
            {tr(mode === "mask" ? "Use mask" : "Use as reference")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
