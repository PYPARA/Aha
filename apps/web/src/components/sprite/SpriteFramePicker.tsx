import { useEffect, useRef, useState } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { FrameThumbnail } from "./SpritePreview";
import {
  selectSpriteFrame,
  reorderSelectedFrames,
  moveFrames,
  type SpriteProject,
  type SpriteFrame,
} from "./spriteModel";

export function SpriteFramePicker({
  project,
  frames,
  actionId,
  index,
  selected,
  onSelection,
  onPreview,
  onFrames,
  onCreate,
  readOnly = false,
  onError,
}: {
  project: SpriteProject;
  frames: SpriteFrame[];
  actionId: string;
  index: number;
  selected: Set<string>;
  onSelection: (ids: Set<string>) => void;
  onPreview: (index: number) => void;
  onFrames: (frames: SpriteFrame[]) => void;
  onCreate: () => void;
  readOnly?: boolean;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation();
  const [grid, setGrid] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const root = useRef<HTMLDivElement>(null),
    anchor = useRef<string | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    additive: boolean;
    previous: Set<string>;
  } | null>(null);
  const latest = useRef({ frames, selected, onSelection });
  latest.current = { frames, selected, onSelection };
  const actionOwner = useRef(actionId);
  actionOwner.current = actionId;
  useEffect(() => {
    anchor.current = null;
    drag.current = null;
    setBox(null);
  }, [actionId]);
  useEffect(() => {
    if (anchor.current && !frames.some((f) => f.id === anchor.current)) anchor.current = null;
    const valid = new Set(frames.filter((f) => selected.has(f.id)).map((f) => f.id));
    if (valid.size !== selected.size) onSelection(valid);
  }, [frames, selected, onSelection]);
  const remove = () => {
    if (!selected.size) return;
    onFrames(frames.filter((f) => !selected.has(f.id)));
    onSelection(new Set());
  };
  const menu = async (x: number, y: number) => {
    const owner = actionId;
    const clicked = await ensureNativeApi().contextMenu.show(
      [
        { id: "all", label: tr("Select all frames") },
        { id: "none", label: tr("Clear selection") },
        { id: "invert", label: tr("Invert selection") },
        ...(selected.size
          ? [
              { id: "create", label: tr("New action from selection"), separatorBefore: true },
              { id: "keep", label: tr("Keep selected frames only") },
              { id: "remove", label: tr("Remove selected frames"), destructive: true },
              { id: "earlier", label: tr("Move earlier"), separatorBefore: true },
              { id: "later", label: tr("Move later") },
            ]
          : []),
      ],
      { x, y },
    );
    if (actionOwner.current !== owner || latest.current.frames !== frames) return;
    if (clicked === "all") onSelection(new Set(frames.map((f) => f.id)));
    if (clicked === "none") onSelection(new Set());
    if (clicked === "invert")
      onSelection(new Set(frames.filter((f) => !selected.has(f.id)).map((f) => f.id)));
    if (clicked === "create") onCreate();
    if (clicked === "remove") remove();
    if (clicked === "keep") onFrames(frames.filter((f) => selected.has(f.id)));
    if (clicked === "earlier" || clicked === "later")
      onFrames(moveFrames(frames, selected, clicked === "earlier" ? -1 : 1));
  };
  const updateBox = () => {
    const el = root.current,
      start = drag.current;
    if (!el || !start) return;
    const bounds = el.getBoundingClientRect();
    const x = start.clientX - bounds.left + el.scrollLeft,
      y = start.clientY - bounds.top + el.scrollTop;
    const rect = {
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
    };
    setBox(rect);
    const ids = new Set(start.additive ? start.previous : []);
    for (const item of el.querySelectorAll<HTMLElement>("[data-frame-id]")) {
      const b = item.getBoundingClientRect(),
        left = b.left - bounds.left + el.scrollLeft,
        top = b.top - bounds.top + el.scrollTop;
      if (
        left < rect.x + rect.width &&
        left + b.width > rect.x &&
        top < rect.y + rect.height &&
        top + b.height > rect.y
      )
        ids.add(item.dataset.frameId!);
    }
    latest.current.onSelection(ids);
  };
  const boxing = box !== null;
  useEffect(() => {
    if (!boxing) return;
    let raf: number;
    const tick = () => {
      const el = root.current,
        start = drag.current;
      if (!el || !start) return;
      const b = el.getBoundingClientRect();
      const dx = start.clientX > b.right - 28 ? 10 : start.clientX < b.left + 28 ? -10 : 0;
      const dy = start.clientY > b.bottom - 28 ? 10 : start.clientY < b.top + 28 ? -10 : 0;
      if (dx || dy) {
        el.scrollBy(dx, dy);
        updateBox();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [boxing]);
  return (
    <section className="min-w-0" aria-label={tr("Frame selection")}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="flex-1 text-muted-foreground">
          {selected.size} {tr("frames selected")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          aria-label={tr(grid ? "Strip view" : "Grid view")}
          onClick={() => setGrid(!grid)}
        >
          {tr(grid ? "Strip view" : "Grid view")}
        </Button>
        {!readOnly && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={tr("Frame options")}
            title={tr("Frame options")}
            onClick={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              void menu(b.left, b.bottom).catch(onError);
            }}
          >
            ⋯
          </Button>
        )}
      </div>
      <div
        ref={root}
        tabIndex={0}
        className={`relative min-h-24 select-none overflow-auto rounded border p-3 outline-none focus-visible:ring-1 focus-visible:ring-primary ${grid ? "grid max-h-64 grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2" : "flex gap-1"}`}
        aria-label={tr("Animation frames")}
        onContextMenu={(e) => {
          if (readOnly) return;
          e.preventDefault();
          void menu(e.clientX, e.clientY).catch(onError);
        }}
        onKeyDown={(e) => {
          if (
            readOnly ||
            (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.frameId)
          )
            return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            onSelection(new Set(frames.map((f) => f.id)));
          } else if (e.key === "Escape") {
            e.preventDefault();
            onSelection(new Set());
          } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            remove();
          }
        }}
        onPointerDown={(e) => {
          if (readOnly || e.button !== 0 || (e.target as HTMLElement).closest("[data-frame-id]"))
            return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const b = e.currentTarget.getBoundingClientRect();
          drag.current = {
            x: e.clientX - b.left + e.currentTarget.scrollLeft,
            y: e.clientY - b.top + e.currentTarget.scrollTop,
            clientX: e.clientX,
            clientY: e.clientY,
            additive: e.metaKey || e.ctrlKey,
            previous: new Set(selected),
          };
          updateBox();
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          drag.current.clientX = e.clientX;
          drag.current.clientY = e.clientY;
          updateBox();
        }}
        onPointerUp={() => {
          drag.current = null;
          setBox(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setBox(null);
        }}
      >
        {frames.map((f, i) => (
          <button
            key={f.id}
            data-frame-id={f.id}
            aria-label={`${tr("Frame")} ${i + 1}`}
            aria-pressed={selected.has(f.id)}
            draggable={!readOnly}
            className={`flex w-14 shrink-0 flex-col items-center rounded border text-xs ${i === index ? "border-orange-400" : ""} ${selected.has(f.id) && !readOnly ? "bg-primary/15 ring-2 ring-primary" : ""}`}
            onClick={(e) => {
              onPreview(i);
              if (readOnly) return;
              onSelection(
                selectSpriteFrame(
                  frames,
                  selected,
                  anchor.current,
                  f.id,
                  e.shiftKey,
                  e.metaKey || e.ctrlKey,
                ),
              );
              if (!e.shiftKey) anchor.current = f.id;
            }}
            onDragStart={(e) => {
              const ids = selected.has(f.id) ? [...selected] : [f.id];
              e.dataTransfer.setData("application/x-aha-sprite-frames", JSON.stringify(ids));
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-aha-sprite-frames"))
                e.preventDefault();
            }}
            onDrop={(e) => {
              if (readOnly) return;
              const raw = e.dataTransfer.getData("application/x-aha-sprite-frames");
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              try {
                onFrames(reorderSelectedFrames(frames, new Set(JSON.parse(raw)), f.id));
              } catch (error) {
                onError(error);
              }
            }}
          >
            <FrameThumbnail source={project.sources.find((s) => s.id === f.sourceId)!} frame={f} />
            <span>{i + 1}</span>
            <span>
              {f.width}×{f.height}
            </span>
          </button>
        ))}
        {box && (
          <div
            className="pointer-events-none absolute border border-primary bg-primary/15"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          />
        )}
      </div>
      {!readOnly && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={onCreate}>
            {tr("New action from selection")}
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={remove}>
            {tr("Remove selected frames")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.size || selected.size === frames.length}
            onClick={() => onFrames(frames.filter((f) => selected.has(f.id)))}
          >
            {tr("Keep selected frames only")}
          </Button>
        </div>
      )}
    </section>
  );
}
