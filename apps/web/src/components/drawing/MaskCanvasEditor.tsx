import { CentralIcon } from "~/lib/central-icons";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { ImageAsset } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ensureNativeApi } from "~/nativeApi";
import { PencilIcon, EraserIcon } from "~/lib/icons";
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
import { useDrawingViewport } from "./useDrawingViewport";
import { imageUrl } from "./useDrawing";
import {
  drawCanvasCommand,
  selectionToMask,
  type CanvasCommand,
  type CanvasPoint,
} from "./imageCanvas";

async function loadBitmap(url: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-cache" });
  if (!response.ok) throw new Error("Could not load image.");
  return createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
}
export function MaskCanvasEditor({
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
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const [hover, setHover] = useState<CanvasPoint | null>(null);
  const [showSelection, setShowSelection] = useState(true);
  const [commands, setCommands] = useState<CanvasCommand[]>([]);
  const [redo, setRedo] = useState<CanvasCommand[]>([]);
  const [tool, setTool] = useState<CanvasCommand["tool"] | "hand">("brush");
  const [color, setColor] = useState("#f43f5e");
  const [width, setWidth] = useState(20);
  const [text, setText] = useState("");

  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = { width: base?.width ?? 1024, height: base?.height ?? 1024 };
  const viewport = useDrawingViewport(stage, size.width, size.height);
  const renderNow = useCallback(
    (all: CanvasCommand[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (initialSelection.current) ctx.drawImage(initialSelection.current, 0, 0);
      for (const command of all) drawCanvasCommand(ctx, command, mode === "mask");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      setHasSelection(pixels.some((v, i) => i % 4 === 3 && v > 0));
    },
    [mode],
  );
  const render = useCallback(
    (all: CanvasCommand[]) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        renderNow(all);
      });
    },
    [renderNow],
  );
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
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
  const point = (event: PointerEvent<HTMLDivElement>) => viewport.point(event);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (viewport.down(event, tool === "hand")) {
      active.current = null;
      render(commands);
      return;
    }
    if (event.button !== 0) return;
    const start = point(event);
    if (start.x < 0 || start.y < 0 || start.x > size.width || start.y > size.height) return;
    active.current = { tool: tool as CanvasCommand["tool"], points: [start], color, width };
    render([...commands, active.current]);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    setHover(point(event));
    if (viewport.move(event)) return;
    if (!active.current) return;
    active.current.points.push(point(event));
    render([...commands, active.current]);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const navigating = viewport.up(event);
    if (active.current && !navigating) add(active.current);
    active.current = null;
  };
  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    setError(null);
    try {
      renderNow(commands);
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
  const close = async () => {
    if (busy) return;
    if (
      commands.length &&
      !(await ensureNativeApi().dialogs.confirm(tr("Discard unsaved changes?")))
    )
      return;
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup
        className="h-[min(850px,90dvh)] max-w-6xl overflow-hidden"
        bottomStickOnMobile={false}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === "z" &&
            !(e.target instanceof HTMLElement && e.target.closest("input,textarea"))
          ) {
            e.preventDefault();
            if (e.shiftKey && redo.length) {
              setCommands((old) => [...old, redo.at(-1)!]);
              setRedo((old) => old.slice(0, -1));
            } else if (!e.shiftKey && commands.length) {
              setRedo((old) => [...old, commands.at(-1)!]);
              setCommands((old) => old.slice(0, -1));
            }
          }
        }}
      >
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
                size="icon-sm"
                aria-label={tr(value)}
                title={tr(value)}
                variant={tool === value ? "default" : "outline"}
                onClick={() => setTool(value as typeof tool)}
              >
                {value === "brush" ? (
                  <PencilIcon />
                ) : value === "eraser" ? (
                  <EraserIcon />
                ) : (
                  <CentralIcon name="hand-5-finger" />
                )}
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
            ref={viewport.mount}
            inert={busy}
            style={{ cursor: tool === "hand" ? (viewport.panning ? "grabbing" : "grab") : "none" }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={(e) => {
              viewport.up(e);
              active.current = null;
              render(commands);
            }}
            onPointerLeave={() => setHover(null)}
            className="relative h-[55dvh] min-h-48 overflow-hidden rounded-xl border bg-muted/30 touch-none"
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{
                width: size.width,
                height: size.height,
                transform: `translate(${viewport.view.x}px, ${viewport.view.y}px) scale(${viewport.view.scale})`,
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
                data-ready={ready}
                width={size.width}
                height={size.height}
                style={{
                  opacity: showSelection ? 0.55 : 0,
                  cursor: tool === "hand" ? (viewport.panning ? "grabbing" : "grab") : "none",
                }}
                className="relative touch-none"
              />
            </div>
            {hover && tool !== "hand" ? (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-full border border-white shadow-[0_0_0_1px_black]"
                style={{
                  left:
                    viewport.view.x +
                    hover.x * viewport.view.scale -
                    (width * viewport.view.scale) / 2,
                  top:
                    viewport.view.y +
                    hover.y * viewport.view.scale -
                    (width * viewport.view.scale) / 2,
                  width: width * viewport.view.scale,
                  height: width * viewport.view.scale,
                }}
              />
            ) : null}
            {loading ? (
              <p className="absolute inset-x-0 top-4 text-center">{tr("Loading...")}</p>
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => viewport.zoom(viewport.view.scale / 1.2)}
            >
              −
            </Button>
            <span>{Math.round(viewport.view.scale * 100)}%</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => viewport.zoom(viewport.view.scale * 1.2)}
            >
              +
            </Button>
            <Button size="sm" variant="ghost" onClick={viewport.fit}>
              {tr("Reset view")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => viewport.zoom(1)}>
              100%
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={showSelection}
              onClick={() => setShowSelection((v) => !v)}
            >
              {tr(showSelection ? "Hide selection" : "Show selection")}
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
          <Button variant="ghost" disabled={busy} onClick={() => void close()}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!ready || busy || !hasSelection} onClick={() => void save()}>
            {tr(mode === "mask" ? "Use mask" : "Use as reference")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
