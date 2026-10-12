import { CentralIcon } from "~/lib/central-icons";
import { useEffect, useRef, useState, useMemo, type PointerEvent } from "react";
import type {
  ImageAsset,
  ImageComment,
  ImageEditDocument,
  ImageEditDocumentCreateInput,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ensureNativeApi } from "~/nativeApi";
import { PencilIcon, EraserIcon, MessageCircleIcon, Undo2Icon, Redo2Icon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Menu, MenuTrigger, MenuItem } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { useDrawingViewport } from "./useDrawingViewport";
import { imageUrl } from "./useDrawing";
import {
  drawSketchElementWithErase,
  isSketchElementVisible,
  findTopElementAt,
  getElementBounds,
  getTransformBounds,
  getHandlePoint,
  hitTestElement,
  moveElement,
  resizeBounds,
  transformElement,
  snapToAngle,
  SKETCH_SHAPES,
  SKETCH_HANDLES,
  getSketchFontSize,
  type SketchElement,
  type SketchShapeKind,
  type SketchHandle,
  type SketchPoint,
  type SketchBounds,
  type SketchEraseStroke,
} from "./imageSketch";

type Scene = { elements: SketchElement[]; comments: ImageComment[] };
type Tool = "select" | "brush" | "eraser" | "shape" | "text" | "comment" | "hand";
type Gesture = {
  before: Scene;
  start: SketchPoint;
  kind: "draw" | "move" | "resize" | "erase" | "comment";
  id?: string;
  bounds?: SketchBounds;
  handle?: SketchHandle;
  stroke?: SketchEraseStroke;
};
export type AnnotationSave = Omit<ImageEditDocumentCreateInput, "compositeAssetId">;
export function ImageAnnotationEditor({
  base,
  document,
  blankSize,
  onClose,
  onSave,
  focusComments,
  focusCommentId,
}: {
  base: ImageAsset | null;
  document: ImageEditDocument | null;
  blankSize?: { width: number; height: number } | undefined;
  focusComments?: boolean | undefined;
  focusCommentId?: string | undefined;
  onClose: () => void;
  onSave: (blob: Blob, data?: AnnotationSave) => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const width = document?.width ?? base?.width ?? blankSize?.width ?? 1024,
    height = document?.height ?? base?.height ?? blankSize?.height ?? 1024;
  const stage = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    scratch = useRef<HTMLCanvasElement | null>(null),
    frame = useRef<number | null>(null),
    bitmap = useRef<ImageBitmap | null>(null);
  const [scene, setScene] = useState<Scene>(() => ({
    elements: structuredClone(document?.elements ?? []) as SketchElement[],
    comments: structuredClone(document?.comments ?? []) as ImageComment[],
  }));
  const live = useRef(scene);
  live.current = scene;
  const initial = useRef<string | null>(null);
  if (initial.current === null) initial.current = JSON.stringify(scene);
  const history = useRef<{ undo: Scene[]; redo: Scene[] }>({ undo: [], redo: [] });
  const gesture = useRef<Gesture | null>(null);
  const [tool, setTool] = useState<Tool>(focusComments ? "comment" : "brush"),
    [shape, setShape] = useState<SketchShapeKind>("rect"),
    [selected, setSelected] = useState<string | null>(null),
    [color, setColor] = useState("#f43f5e"),
    [strokeWidth, setStrokeWidth] = useState(12),
    [hover, setHover] = useState<SketchPoint | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<string | null>(null),
    [historyVersion, setHistoryVersion] = useState(0);
  const [textEdit, setTextEdit] = useState<{ id: string; before: Scene; value: string } | null>(
      null,
    ),
    [commentEdit, setCommentEdit] = useState<{ id: string; before: Scene; value: string } | null>(
      () => {
        const comment = focusComments
          ? (scene.comments.find((c) => c.id === focusCommentId) ?? scene.comments[0])
          : null;
        return comment
          ? { id: comment.id, before: structuredClone(scene), value: comment.text }
          : null;
      },
    );
  const viewport = useDrawingViewport(stage, width, height);
  const sceneDirty = useMemo(() => JSON.stringify(scene) !== initial.current, [scene]);
  const dirty =
    sceneDirty ||
    Boolean(
      (textEdit &&
        textEdit.value !==
          (
            textEdit.before.elements.find((e) => e.id === textEdit.id && e.type === "text") as
              | { text: string }
              | undefined
          )?.text) ||
      (commentEdit &&
        commentEdit.value !==
          commentEdit.before.comments.find((c) => c.id === commentEdit.id)?.text),
    );
  const put = (next: Scene) => {
    live.current = next;
    setScene(next);
  };
  const remember = (before: Scene) => {
    if (JSON.stringify(before) === JSON.stringify(live.current)) return;
    history.current.undo.push(before);
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
    setHistoryVersion((v) => v + 1);
  };
  const commit = (next: Scene) => {
    const before = live.current;
    put(next);
    remember(before);
  };
  const undo = (redo = false) => {
    const from = redo ? history.current.redo : history.current.undo,
      to = redo ? history.current.undo : history.current.redo;
    const next = from.pop();
    if (next) {
      to.push(live.current);
      put(next);
      setSelected(null);
      setTextEdit(null);
      setCommentEdit(null);
      setHistoryVersion((v) => v + 1);
    }
  };
  const settleText = () => {
    if (!textEdit) return;
    const e = live.current.elements.find((e) => e.id === textEdit.id);
    put({
      ...live.current,
      elements:
        e && textEdit.value.trim()
          ? live.current.elements.map((el) =>
              el.id === e.id && el.type === "text" ? { ...el, text: textEdit.value } : el,
            )
          : live.current.elements.filter((el) => el.id !== textEdit.id),
    });
    remember(textEdit.before);
    setTextEdit(null);
  };
  const settleComment = () => {
    if (!commentEdit) return;
    put({
      ...live.current,
      comments: commentEdit.value.trim()
        ? live.current.comments.map((c) =>
            c.id === commentEdit.id ? { ...c, text: commentEdit.value.trim() } : c,
          )
        : live.current.comments.filter((c) => c.id !== commentEdit.id),
    });
    remember(commentEdit.before);
    setCommentEdit(null);
  };
  useEffect(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;

      const el = canvas.current;
      if (!el) return;
      const ctx = el.getContext("2d")!;
      ctx.clearRect(0, 0, width, height);
      scratch.current ??= window.document.createElement("canvas");
      for (const object of live.current.elements) {
        if (object.id === textEdit?.id) continue;
        drawSketchElementWithErase(ctx, object, scratch.current);
      }
    });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [scene, textEdit, width, height]);
  useEffect(() => {
    let disposed = false;
    setReady(false);
    void (async () => {
      try {
        if (base) {
          const response = await fetch(imageUrl(base, "edit"), { credentials: "include" });
          if (!response.ok) throw new Error(tr("Could not load image."));
          const b = await createImageBitmap(await response.blob());
          if (disposed) {
            b.close();
            return;
          }
          bitmap.current = b;
        }
        if (!disposed) setReady(true);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      disposed = true;
      bitmap.current?.close();
      bitmap.current = null;
    };
  }, [base, tr]);
  const bounds = selected ? live.current.elements.find((e) => e.id === selected) : null;
  const ctx = canvas.current?.getContext("2d");
  const selectionBounds = bounds && ctx ? getElementBounds(bounds, ctx) : null;
  const down = (event: PointerEvent<HTMLElement>) => {
    if (
      !ready ||
      busy ||
      (event.target instanceof HTMLElement && event.target.closest("button,input,textarea"))
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (viewport.down(event, tool === "hand")) {
      if (gesture.current) put(gesture.current.before);
      gesture.current = null;
      return;
    }
    if (event.button !== 0) return;
    settleText();
    settleComment();
    const p = viewport.point(event);
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return;
    const before = structuredClone(live.current);
    const id = crypto.randomUUID();
    if (tool === "comment") {
      put({
        ...before,
        comments: [...before.comments, { id, x: p.x / width, y: p.y / height, text: "" }],
      });
      setCommentEdit({ id, before, value: "" });
      return;
    }
    if (tool === "text") {
      put({
        ...before,
        elements: [
          ...before.elements,
          {
            id,
            type: "text",
            x: p.x,
            y: p.y,
            text: "",
            fontSize: getSketchFontSize(strokeWidth),
            color,
            width: strokeWidth,
          },
        ],
      });
      setTextEdit({ id, before, value: "" });
      setSelected(id);
      return;
    }
    const context = canvas.current!.getContext("2d")!;
    if (tool === "select") {
      const active = before.elements.find((e) => e.id === selected);
      if (active) {
        const b = getElementBounds(active, context);
        const handle = SKETCH_HANDLES.find((h) => {
          const q = getHandlePoint(b, h);
          return Math.hypot(p.x - q.x, p.y - q.y) < 10 / viewport.view.scale;
        });
        if (handle) {
          gesture.current = {
            before,
            start: p,
            kind: "resize",
            id: active.id,
            bounds: getTransformBounds(active, context),
            handle,
          };
          return;
        }
      }
      const hit = findTopElementAt(before.elements, p, 7 / viewport.view.scale, context);
      setSelected(hit?.id ?? null);
      if (hit) {
        setColor(hit.color);
        setStrokeWidth(hit.width);
        gesture.current = { before, start: p, kind: "move", id: hit.id };
      }
      return;
    }
    setSelected(null);
    if (tool === "eraser") {
      gesture.current = {
        before,
        start: p,
        kind: "erase",
        stroke: { width: strokeWidth, points: [p] },
      };
      erase(gesture.current);
      return;
    }
    const object: SketchElement =
      tool === "brush"
        ? { id, type: "path", color, width: strokeWidth, points: [p] }
        : { id, type: "shape", shape, color, width: strokeWidth, start: p, end: p };
    put({ ...before, elements: [...before.elements, object] });
    gesture.current = { before, start: p, kind: "draw", id };
  };
  const erase = (g: Gesture) => {
    const context = canvas.current!.getContext("2d")!;
    const stroke = g.stroke!;
    const objects = g.before.elements.map((el) =>
      stroke.points.some((p) => hitTestElement(el, p, stroke.width / 2, context, "erase"))
        ? { ...el, erase: [...(el.erase ?? []), structuredClone(stroke)] }
        : el,
    );
    put({ ...g.before, elements: objects });
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const p = viewport.point(event);
    setHover(p);
    if (viewport.move(event)) return;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "erase") {
      g.stroke!.points.push(p);
      erase(g);
      return;
    }
    if (g.kind === "comment") {
      put({
        ...g.before,
        comments: g.before.comments.map((c) =>
          c.id === g.id
            ? {
                ...c,
                x: Math.max(0, Math.min(1, p.x / width)),
                y: Math.max(0, Math.min(1, p.y / height)),
              }
            : c,
        ),
      });
      return;
    }
    if (g.kind === "move") {
      put({
        ...g.before,
        elements: g.before.elements.map((el) =>
          el.id === g.id ? moveElement(el, p.x - g.start.x, p.y - g.start.y) : el,
        ),
      });
      return;
    }
    if (g.kind === "resize") {
      put({
        ...g.before,
        elements: g.before.elements.map((el) =>
          el.id === g.id
            ? transformElement(
                el,
                g.bounds!,
                resizeBounds(
                  g.bounds!,
                  g.handle!,
                  p,
                  8,
                  event.shiftKey ? g.bounds!.width / Math.max(1, g.bounds!.height) : undefined,
                ),
                g.handle!,
              )
            : el,
        ),
      });
      return;
    }
    put({
      ...live.current,
      elements: live.current.elements.map((el) => {
        if (el.id !== g.id) return el;
        if (el.type === "path") return { ...el, points: [...el.points, p] };
        if (el.type === "shape") {
          let end = p;
          if (event.shiftKey) {
            if (el.shape === "line" || el.shape === "arrow") end = snapToAngle(el.start, p);
            else {
              const d = Math.max(Math.abs(p.x - el.start.x), Math.abs(p.y - el.start.y));
              end = {
                x: el.start.x + Math.sign(p.x - el.start.x) * d,
                y: el.start.y + Math.sign(p.y - el.start.y) * d,
              };
            }
          }
          return { ...el, end };
        }
        return el;
      }),
    });
  };
  const up = (event: PointerEvent<HTMLElement>) => {
    const navigation = viewport.up(event);
    const g = gesture.current;
    if (g && !navigation) {
      if (g.kind === "erase") {
        const probe = window.document.createElement("canvas");
        put({
          ...live.current,
          elements: live.current.elements.filter(
            (el) => !el.erase?.length || isSketchElementVisible(el, probe),
          ),
        });
      }
      remember(g.before);
      if (g.kind === "draw") setSelected(g.id ?? null);
    }
    gesture.current = null;
  };
  const cancel = (event: PointerEvent<HTMLElement>) => {
    viewport.up(event);
    if (gesture.current) put(gesture.current.before);
    gesture.current = null;
  };
  const removeSelected = () => {
    if (selected) {
      commit({ ...live.current, elements: live.current.elements.filter((e) => e.id !== selected) });
      setSelected(null);
    }
  };
  const style = (nextColor: string, nextWidth: number) => {
    setColor(nextColor);
    setStrokeWidth(nextWidth);
    if (selected)
      commit({
        ...live.current,
        elements: live.current.elements.map((e) =>
          e.id === selected
            ? {
                ...e,
                color: nextColor,
                width: nextWidth,
                ...(e.type === "text" && nextWidth !== strokeWidth
                  ? { fontSize: getSketchFontSize(nextWidth) }
                  : {}),
              }
            : e,
        ),
      });
  };
  const close = async () => {
    if (busy) return;
    if (dirty && !(await ensureNativeApi().dialogs.confirm(tr("Discard unsaved changes?")))) return;
    onClose();
  };
  const save = async () => {
    settleText();
    settleComment();
    setBusy(true);
    setError(null);
    try {
      const output = window.document.createElement("canvas");
      output.width = width;
      output.height = height;
      const context = output.getContext("2d")!;
      if (bitmap.current) context.drawImage(bitmap.current, 0, 0);
      else {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      const buffer = window.document.createElement("canvas");
      for (const el of live.current.elements) drawSketchElementWithErase(context, el, buffer);
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (b) => (b ? resolve(b) : reject(new Error(tr("Could not export image.")))),
          "image/png",
        ),
      );
      await onSave(blob, {
        baseAssetId: base?.id ?? null,
        width,
        height,
        elements: live.current.elements,
        comments: live.current.comments.filter((c) => c.text.trim()),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const tools: { value: Tool; label: string; icon: React.ReactNode }[] = [
    { value: "select", label: "Select object", icon: <CentralIcon name="cursor-1" /> },
    { value: "brush", label: "brush", icon: <PencilIcon /> },
    { value: "eraser", label: "eraser", icon: <EraserIcon /> },
    { value: "text", label: "text", icon: <CentralIcon name="text-1" /> },
    { value: "comment", label: "Image comment", icon: <MessageCircleIcon /> },
    { value: "hand", label: "hand", icon: <CentralIcon name="hand-5-finger" /> },
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="h-[min(900px,92dvh)] max-w-6xl overflow-hidden"
        onKeyDown={(e) => {
          if (
            e.target instanceof HTMLElement &&
            e.target.closest("input,textarea,[contenteditable=true]")
          )
            return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            undo(e.shiftKey);
          } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            removeSelected();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{tr("Annotation canvas")}</DialogTitle>
          <DialogDescription>
            {tr("Draw, edit objects, or add comments to describe changes.")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="mx-4 mb-3 flex shrink-0 flex-wrap items-center gap-1 rounded-xl bg-muted/40 p-1.5"
          inert={busy}
          aria-label={tr("Canvas tools")}
        >
          {tools.map((t) => (
            <Button
              key={t.value}
              size="icon-sm"
              variant={tool === t.value ? "secondary" : "ghost"}
              title={tr(t.label)}
              aria-label={tr(t.label)}
              aria-pressed={tool === t.value}
              onClick={() => {
                settleText();
                settleComment();
                setTool(t.value);
              }}
            >
              {t.icon}
            </Button>
          ))}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant={tool === "shape" ? "secondary" : "ghost"}
                  aria-label={tr("Shape")}
                  title={tr("Shape")}
                />
              }
            >
              <CentralIcon name="shapes-plus-x-square-circle" />
            </MenuTrigger>
            <ComposerPickerMenuPopup>
              {SKETCH_SHAPES.map((s) => (
                <MenuItem
                  key={s}
                  onClick={() => {
                    settleText();
                    settleComment();
                    setShape(s);
                    setTool("shape");
                  }}
                >
                  {tr(s === "rect" ? "rectangle" : s)}
                </MenuItem>
              ))}
            </ComposerPickerMenuPopup>
          </Menu>
          <span className="mx-1 h-5 w-px bg-border" />
          <label className="flex items-center gap-1">
            <span className="sr-only">{tr("Brush color")}</span>
            <input
              type="color"
              className="h-7 w-7 cursor-pointer rounded bg-transparent"
              aria-label={tr("Brush color")}
              value={color}
              onChange={(e) => style(e.target.value, strokeWidth)}
            />
          </label>
          <label className="flex items-center gap-2 text-ui-xs">
            <span className="sr-only">{tr("Brush size")}</span>
            <input
              className="w-20 accent-current"
              aria-label={tr("Brush size")}
              type="range"
              min={2}
              max={160}
              value={strokeWidth}
              onChange={(e) => style(color, Number(e.target.value))}
            />
            <span className="w-6 tabular-nums">{strokeWidth}</span>
          </label>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={tr("Undo")}
            title={tr("Undo")}
            disabled={!history.current.undo.length}
            onClick={() => undo()}
          >
            <Undo2Icon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={tr("Redo")}
            title={tr("Redo")}
            disabled={!history.current.redo.length}
            onClick={() => undo(true)}
          >
            <Redo2Icon />
          </Button>
          <Button size="sm" variant="ghost" disabled={!selected} onClick={removeSelected}>
            {tr("Delete")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              settleText();
              settleComment();
              commit({ elements: [], comments: [] });
              setSelected(null);
            }}
          >
            {tr("Clear")}
          </Button>
        </div>
        <div
          ref={viewport.mount}
          data-testid="annotation-stage"
          inert={busy}
          data-history-version={historyVersion}
          className="relative mx-4 min-h-40 flex-1 overflow-hidden rounded-xl border bg-muted/30 touch-none"
          style={{
            cursor: viewport.panning
              ? "grabbing"
              : tool === "hand"
                ? "grab"
                : tool === "brush" || tool === "eraser"
                  ? "none"
                  : "crosshair",
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={cancel}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={(e) => {
            if (tool !== "select" || !ctx) return;
            const hit = findTopElementAt(
              live.current.elements,
              viewport.point(e),
              7 / viewport.view.scale,
              ctx,
            );
            if (hit?.type === "text")
              setTextEdit({ id: hit.id, before: structuredClone(live.current), value: hit.text });
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width,
              height,
              transform: `translate(${viewport.view.x}px,${viewport.view.y}px) scale(${viewport.view.scale})`,
            }}
          >
            {base ? (
              <img
                src={imageUrl(base, "edit")}
                draggable={false}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
            ) : (
              <div className="absolute inset-0 bg-white" />
            )}
            <canvas
              ref={canvas}
              width={width}
              height={height}
              className="pointer-events-none relative"
            />
            {selectionBounds && !textEdit ? (
              <div
                className="pointer-events-none absolute border border-primary"
                style={{
                  left: selectionBounds.x,
                  top: selectionBounds.y,
                  width: selectionBounds.width,
                  height: selectionBounds.height,
                  borderWidth: 1 / viewport.view.scale,
                }}
              >
                {SKETCH_HANDLES.map((h) => {
                  const p = getHandlePoint(
                    { x: 0, y: 0, width: selectionBounds.width, height: selectionBounds.height },
                    h,
                  );
                  return (
                    <span
                      key={h}
                      className="absolute border border-primary bg-background"
                      style={{
                        left: p.x - 4 / viewport.view.scale,
                        top: p.y - 4 / viewport.view.scale,
                        width: 8 / viewport.view.scale,
                        height: 8 / viewport.view.scale,
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
            {scene.comments.map((c, i) => (
              <button
                type="button"
                key={c.id}
                aria-label={`${tr("Image comment")} ${i + 1}`}
                className="absolute flex items-center justify-center rounded-full border border-primary/40 bg-background text-primary shadow-md"
                style={{
                  left: c.x * width,
                  top: c.y * height,
                  width: 26 / viewport.view.scale,
                  height: 26 / viewport.view.scale,
                  fontSize: 12 / viewport.view.scale,
                  transform: "translate(-50%,-50%)",
                }}
                onClick={() => {
                  settleText();
                  settleComment();
                  setCommentEdit({
                    id: c.id,
                    before: structuredClone(live.current),
                    value: c.text,
                  });
                }}
                onPointerDown={(e) => {
                  if (busy) return;
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  gesture.current = {
                    before: structuredClone(live.current),
                    start: viewport.point(e),
                    kind: "comment",
                    id: c.id,
                  };
                }}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={cancel}
              >
                {i + 1}
              </button>
            ))}
          </div>
          {textEdit
            ? (() => {
                const obj = scene.elements.find((el) => el.id === textEdit.id);
                if (obj?.type !== "text") return null;
                return (
                  <textarea
                    autoFocus
                    aria-label={tr("Annotation text")}
                    className="absolute min-h-12 min-w-32 resize rounded border border-primary bg-background/90 px-1 text-foreground outline-none"
                    style={{
                      left: Math.max(
                        0,
                        Math.min(
                          (stage.current?.clientWidth ?? 600) - 140,
                          viewport.view.x + obj.x * viewport.view.scale,
                        ),
                      ),
                      top: Math.max(
                        0,
                        Math.min(
                          (stage.current?.clientHeight ?? 400) - 60,
                          viewport.view.y + obj.y * viewport.view.scale,
                        ),
                      ),
                      fontSize: Math.max(12, obj.fontSize * viewport.view.scale),
                      lineHeight: 1.25,
                      color: obj.color,
                      maxWidth: "90%",
                    }}
                    value={textEdit.value}
                    onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
                    onBlur={settleText}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.nativeEvent.isComposing) return;
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        settleText();
                      }
                      if (e.key === "Escape") {
                        put(textEdit.before);
                        setTextEdit(null);
                      }
                    }}
                  />
                );
              })()
            : null}
          {commentEdit
            ? (() => {
                const c = scene.comments.find((c) => c.id === commentEdit.id);
                if (!c) return null;
                return (
                  <div
                    className="absolute z-10 w-[min(280px,90%)] space-y-2 rounded-xl border bg-popover p-3 shadow-lg"
                    style={{
                      left: Math.max(
                        0,
                        Math.min(
                          (stage.current?.clientWidth ?? 600) - 280,
                          viewport.view.x + c.x * width * viewport.view.scale + 15,
                        ),
                      ),
                      top: Math.max(
                        0,
                        Math.min(
                          (stage.current?.clientHeight ?? 400) - 160,
                          viewport.view.y + c.y * height * viewport.view.scale + 15,
                        ),
                      ),
                    }}
                  >
                    <Input
                      nativeInput
                      autoFocus
                      aria-label={tr("Comment text")}
                      value={commentEdit.value}
                      onChange={(e) => setCommentEdit({ ...commentEdit, value: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          settleComment();
                        }
                        if (e.key === "Escape") {
                          put(commentEdit.before);
                          setCommentEdit(null);
                        }
                      }}
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          put({
                            ...live.current,
                            comments: live.current.comments.filter((c) => c.id !== commentEdit.id),
                          });
                          remember(commentEdit.before);
                          setCommentEdit(null);
                        }}
                      >
                        {tr("Delete")}
                      </Button>
                      <Button size="sm" onClick={settleComment}>
                        {tr("Apply")}
                      </Button>
                    </div>
                  </div>
                );
              })()
            : null}
          {hover && (tool === "brush" || tool === "eraser") && !viewport.panning ? (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-full border border-white shadow-[0_0_0_1px_black]"
              style={{
                left:
                  viewport.view.x +
                  hover.x * viewport.view.scale -
                  (strokeWidth * viewport.view.scale) / 2,
                top:
                  viewport.view.y +
                  hover.y * viewport.view.scale -
                  (strokeWidth * viewport.view.scale) / 2,
                width: strokeWidth * viewport.view.scale,
                height: strokeWidth * viewport.view.scale,
              }}
            />
          ) : null}
          {!ready ? (
            <p className="absolute inset-x-0 top-4 text-center text-ui">
              {error ?? tr("Loading...")}
            </p>
          ) : null}
        </div>
        <div className="mx-4 mt-2 flex shrink-0 flex-wrap items-center gap-1 text-ui-xs text-muted-foreground">
          <Button
            size="sm"
            variant="ghost"
            aria-label={tr("Zoom out")}
            onClick={() => viewport.zoom(viewport.view.scale / 1.2)}
          >
            −
          </Button>
          <span className="min-w-10 text-center tabular-nums">
            {Math.round(viewport.view.scale * 100)}%
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={tr("Zoom in")}
            onClick={() => viewport.zoom(viewport.view.scale * 1.2)}
          >
            +
          </Button>
          <Button size="sm" variant="ghost" onClick={viewport.fit}>
            {tr("Fit canvas")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => viewport.zoom(1)}>
            100%
          </Button>
          <span className="ml-auto">
            {width} × {height}
          </span>
        </div>
        {error ? (
          <p role="alert" className="mx-4 mt-2 text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => void close()}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void save()}>
            {tr(busy ? "Saving..." : "Use as reference")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
