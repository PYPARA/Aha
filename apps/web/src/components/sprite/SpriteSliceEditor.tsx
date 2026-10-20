/* eslint-disable oxc/no-map-spread -- Copy-on-write edit snapshots are the undo and draft history. */
import { createPortal } from "react-dom";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import { Schema } from "effect";
import {
  SpriteEditDescription as EditSchema,
  SpriteSliceConfiguration as SliceSchema,
  spriteEditFromSlice,
  spriteSliceFromEdit,
  spriteTaskSlice,
  spriteGridSlice,
  spriteEditGrid,
  spriteStationarySuggestions,
  spriteSupportAnchor,
  validateSpriteSlice,
  type SpriteEditDescription,
  type SpriteRun,
  type SpriteState,
  type SpriteCandidate,
  type SpriteTaskLayout,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Alert } from "../ui/alert";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SpriteNumberField } from "./SpriteNumberField";
import { SpriteSelect } from "./SpriteSelect";
import { SpriteRepairPreview } from "./SpriteRepairPreview";
import { drawingApi, imageUrl } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { spriteCandidate } from "./spriteCandidate";
import { spriteImageInput } from "./spriteImageInput";
type Edit = SpriteEditDescription;
type Frame = Edit["actions"][number]["frames"][number];
const uid = () => crypto.randomUUID();
export function SpriteSliceEditor({
  run,
  initialActionId,
  initialFrameIndex = 0,
  onState,
  onBack,
  inspectorHost,
  footerHost,
  onSaved,
  onReplaceSource,
}: {
  run: SpriteRun;
  initialActionId?: string | null;
  initialFrameIndex?: number;
  onState: (state: SpriteState) => void;
  onBack: () => void;
  inspectorHost?: HTMLElement | null;
  footerHost?: HTMLElement | null;
  onSaved?: (state: SpriteState) => void;
  onReplaceSource?: (files: File[]) => Promise<void>;
}) {
  const tr = useAhaTranslation(),
    candidate = spriteCandidate(run)!;
  const draftKey = `aha-sprite-slice-draft:${run.context.projectId}:${run.id}:${candidate.id}`;
  const restore = () => {
    const active = candidate.processingVersions?.find(
      (v) => v.id === candidate.processingVersionId,
    )?.configuration;
    const actions = run.configuration?.actions ??
      run.actions?.map((o) => o.action) ?? [
        {
          id: run.context.selection?.actionId ?? "imported",
          name: run.context.action,
          description: "",
          enabled: true,
          frameCount: run.context.frameCount,
          fps: run.context.fps,
          loop: run.context.loop ?? true,
        },
      ];
    const initial =
      candidate.slice ??
      active ??
      (run.configuration?.layout
        ? spriteTaskSlice(
            run.configuration.layout,
            actions,
            candidate.source.width,
            candidate.source.height,
          )
        : candidate.analysis?.suggestion) ??
      spriteGridSlice(candidate.source.width, candidate.source.height, actions);
    return spriteEditFromSlice(initial);
  };
  const [stored] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (!raw?.dirty) return null;
      return {
        edit: raw.edit
          ? Schema.decodeUnknownSync(EditSchema)(raw.edit)
          : spriteEditFromSlice(Schema.decodeUnknownSync(SliceSchema)(raw.slice)),
        version: Number(raw.version) || 0,
        past: (raw.past ?? [])
          .map((v: unknown) => Schema.decodeUnknownSync(EditSchema)(v))
          .slice(-100) as Edit[],
        future: (raw.future ?? [])
          .map((v: unknown) => Schema.decodeUnknownSync(EditSchema)(v))
          .slice(-100) as Edit[],
        actionId: raw.actionId as string | undefined,
        selected: (raw.selected ?? []) as string[],
        tab: raw.tab as "slice" | "groups" | "align" | undefined,
      };
    } catch {
      return null;
    }
  });
  const [edit, setEdit] = useState<Edit>(() => stored?.edit ?? restore()),
    [version, setVersion] = useState(stored?.version ?? candidate.version ?? 0);
  const [past, setPast] = useState<Edit[]>(stored?.past ?? []),
    [future, setFuture] = useState<Edit[]>(stored?.future ?? []),
    [dirty, setDirty] = useState(!!stored);
  const [processedPreview, setProcessedPreview] = useState<SpriteCandidate | null>(null);
  const snapshot = useRef(edit);
  snapshot.current = edit;
  const [tab, setTab] = useState<"slice" | "groups" | "align">(stored?.tab ?? "slice");
  const [actionId, setActionId] = useState(
    stored?.actionId ?? initialActionId ?? edit.actions[0]?.action.id ?? "",
  );
  const group = edit.actions.find((g) => g.action.id === actionId) ?? edit.actions[0];
  const [selected, setSelected] = useState<string[]>(
    stored?.selected ??
      (group?.frames[initialFrameIndex] ? [group.frames[initialFrameIndex]!.id] : []),
  );
  const currentFrame = group?.frames.find((f) => selected.includes(f.id)) ?? group?.frames[0];
  const [cellId, setCellId] = useState(currentFrame?.cellId ?? edit.cells[0]?.id ?? "");
  const cell = edit.cells.find((g) => g.id === cellId) ?? edit.cells[0];
  const [selectedCells, setSelectedCells] = useState<string[]>([]),
    [baselineId, setBaselineId] = useState(group?.frames[0]?.id ?? "");
  const [onion, setOnion] = useState(false),
    [reference, setReference] = useState(false),
    [anchorMode, setAnchorMode] = useState(false),
    [playing, setPlaying] = useState(false),
    [playIndex, setPlayIndex] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(stored ? "Restored your slicing draft." : "");
  const [historyId, setHistoryId] = useState(candidate.processingVersionId ?? "");
  const [suggestions, setSuggestions] = useState<ReturnType<typeof spriteStationarySuggestions>>(
      [],
    ),
    [pending, setPending] = useState<{ edit: Edit; message: string } | null>(null),
    [leave, setLeave] = useState(false),
    [replacement, setReplacement] = useState<File[] | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(360);
  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) =>
      setCanvasHeight(entries[0]?.contentRect.height ?? 360),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const correctionUnit =
    run.context.renderSpec?.mode === "pixel" ? run.context.renderSpec.outputScale : 1;
  const [columns, setColumns] = useState(new Set(edit.cells.map((c) => c.x)).size),
    [rows, setRows] = useState(new Set(edit.cells.map((c) => c.y)).size);
  const [region, setRegion] = useState(() => ({
    x: Math.min(...edit.cells.map((c) => c.x)),
    y: Math.min(...edit.cells.map((c) => c.y)),
    width:
      Math.max(...edit.cells.map((c) => c.x + c.width)) - Math.min(...edit.cells.map((c) => c.x)),
    height:
      Math.max(...edit.cells.map((c) => c.y + c.height)) - Math.min(...edit.cells.map((c) => c.y)),
  }));
  const [groupPreset, setGroupPreset] = useState<"all" | "rows" | "columns">("all");
  const replaceInput = useRef<HTMLInputElement>(null),
    previewCanvas = useRef<HTMLCanvasElement | null>(null),
    sourceRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    cell: NonNullable<typeof cell>;
    handle: string;
  } | null>(null);
  const commit = (next: Edit) => {
    const previous = snapshot.current;
    setPast((p) => [...p.slice(-99), previous]);
    setFuture([]);
    snapshot.current = next;
    setEdit(next);
    setDirty(true);
    setError("");
    setSuggestions([]);
    setProcessedPreview(null);
    setPlaying(false);
  };
  const undo = () => {
    const next = past.at(-1);
    if (!next) return;
    setPast((p) => p.slice(0, -1));
    const previous = snapshot.current;
    setFuture((p) => [...p, previous]);
    snapshot.current = next;
    setEdit(next);
    setProcessedPreview(null);
    setDirty(true);
    setSuggestions([]);
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((p) => p.slice(0, -1));
    const previous = snapshot.current;
    setPast((p) => [...p, previous]);
    snapshot.current = next;
    setEdit(next);
    setProcessedPreview(null);
    setDirty(true);
    setSuggestions([]);
  };
  const shift = (dx: number, dy: number) => {
    const step = run.context.renderSpec?.mode === "pixel" ? run.context.renderSpec.outputScale : 1;
    dx = Math.round(dx / step) * step;
    dy = Math.round(dy / step) * step;
    const ids = selected.length ? selected : currentFrame ? [currentFrame.id] : [];
    commit({
      ...edit,
      actions: edit.actions.map((g) => ({
        ...g,
        frames: g.frames.map((f) =>
          ids.includes(f.id) ? { ...f, offsetX: f.offsetX + dx, offsetY: f.offsetY + dy } : f,
        ),
      })),
    });
  };
  const keys = useEffectEvent((e: KeyboardEvent) => {
    if ((e.target as Element)?.closest("input,textarea,[contenteditable=true]") || busy) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (tab === "align" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      const n =
        (e.shiftKey ? 10 : 1) *
        (run.context.renderSpec?.mode === "pixel" ? run.context.renderSpec.outputScale : 1);
      shift(
        e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0,
        e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0,
      );
    }
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    const persist = () => {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            schemaVersion: 1,
            edit,
            version,
            dirty,
            past,
            future,
            actionId,
            selected,
            tab,
          }),
        );
      } catch {
        setNotice("Could not save the local slicing draft. Keep this editor open.");
      }
    };
    persist();
    const before = (e: BeforeUnloadEvent) => {
      persist();
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [draftKey, edit, version, dirty, past, future, actionId, selected, tab]);
  useEffect(() => {
    if (!playing || !group?.frames.length) return;
    const frame = group.frames[playIndex % group.frames.length]!;
    const timer = setTimeout(
      () => {
        setPlayIndex((i) =>
          group.action.loop
            ? (i + 1) % group.frames.length
            : Math.min(group.frames.length - 1, i + 1),
        );
        if (!group.action.loop && playIndex >= group.frames.length - 1) setPlaying(false);
      },
      frame.durationMs ?? 1000 / group.action.fps,
    );
    return () => clearTimeout(timer);
  }, [playing, playIndex, group]);
  const perform = async (operation: "save-slicing" | "preview-slicing" | "fork-slicing") => {
    if (busy) return;
    setBusy(true);
    setError("");
    setPlaying(false);
    try {
      const slice = spriteSliceFromEdit(edit, {
        background: candidate.slice?.background ?? run.context.background,
        chromaKey: candidate.slice?.chromaKey ?? run.context.chromaKey,
      });
      validateSpriteSlice(slice, candidate.source.width, candidate.source.height);
      const result = await drawingApi().spriteCommand({
        operation,
        projectId: run.context.projectId,
        runId: run.id,
        candidateId: candidate.id,
        version,
        slice,
      });
      if (operation === "preview-slicing") {
        setProcessedPreview(
          result.runs
            .find((r) => r.id === run.id)
            ?.candidates?.find((c) => c.id === candidate.id) ?? null,
        );
        setNotice("Preview generated locally. No image was generated.");
        return;
      }
      const saved = result.runs
        .find((r) => r.id === run.id)
        ?.candidates?.find((c) => c.id === candidate.id);
      setVersion(saved?.version ?? version);
      setDirty(false);
      setPast([]);
      setFuture([]);
      localStorage.removeItem(draftKey);
      setNotice("Slicing correction saved. No image was generated.");
      onState(result);
      onSaved?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const patchCell = (patch: Partial<NonNullable<typeof cell>>) => {
    if (cell)
      commit({
        ...edit,
        cells: edit.cells.map((c) => (c.id === cell.id ? { ...c, ...patch } : c)),
      });
  };
  const patchGroup = (patch: Partial<NonNullable<typeof group>["action"]>) => {
    if (group)
      commit({
        ...edit,
        actions: edit.actions.map((g) =>
          g.action.id === group.action.id ? { ...g, action: { ...g.action, ...patch } } : g,
        ),
      });
  };
  const changeSelection = (frame: Frame, add: boolean) => {
    setSelected(
      add
        ? selected.includes(frame.id)
          ? selected.filter((id) => id !== frame.id)
          : [...selected, frame.id]
        : [frame.id],
    );
    setCellId(frame.cellId);
    setPlaying(false);
  };
  const applyGrid = () => {
    try {
      if (columns * rows > 1024 || region.width < columns || region.height < rows)
        throw new Error("Invalid grid dimensions.");
      const layout: SpriteTaskLayout = {
        width: candidate.source.width,
        height: candidate.source.height,
        columns,
        rows,
        cells: Array.from({ length: columns * rows }, (_, i) => {
          const x = region.x + Math.floor(((i % columns) * region.width) / columns),
            y = region.y + Math.floor((Math.floor(i / columns) * region.height) / rows);
          return {
            id: edit.cells[i]?.id ?? `cell-${uid()}`,
            actionId: group?.action.id ?? "imported",
            frameIndex: i,
            x,
            y,
            width: region.x + Math.floor((((i % columns) + 1) * region.width) / columns) - x,
            height:
              region.y + Math.floor(((Math.floor(i / columns) + 1) * region.height) / rows) - y,
          };
        }),
      };
      const next = spriteEditGrid(edit, layout);
      if (
        next.removed.some((id) => edit.actions.some((g) => g.frames.some((f) => f.cellId === id)))
      )
        setPending({
          edit: next.edit,
          message:
            "Changing this grid removes cells used by actions. Their frame instances will be removed; Undo restores them.",
        });
      else commit(next.edit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const regroup = () => {
    const active = edit.cells.filter((c) => c.enabled).toSorted((a, b) => a.y - b.y || a.x - b.x);
    const buckets = new Map<number, typeof active>();
    for (const c of active) {
      const key = groupPreset === "rows" ? c.y : groupPreset === "columns" ? c.x : 0;
      buckets.set(key, [...(buckets.get(key) ?? []), c]);
    }
    const next = {
      ...edit,
      actions: [...buckets.values()].map((cells, i) => ({
        action: {
          ...(group?.action ?? {
            description: "",
            fps: 12,
            loop: true,
            enabled: true,
            name: "action",
            frameCount: 1,
            id: "imported",
          }),
          id: i === 0 ? (group?.action.id ?? "imported") : uid(),
          name: i === 0 ? (group?.action.name ?? "action") : `action-${i + 1}`,
          frameCount: cells.length,
        },
        frames: cells.map((c) => ({ id: uid(), cellId: c.id, offsetX: 0, offsetY: 0 })),
      })),
    };
    setPending({
      edit: next,
      message:
        "This replaces action grouping and frame order in this processing draft. Existing formal actions are preserved.",
    });
  };
  const reorder = (direction: number) => {
    if (!group) return;
    const frames = [...group.frames],
      indices = frames.flatMap((f, i) => (selected.includes(f.id) ? [i] : []));
    if (direction > 0) indices.reverse();
    for (const i of indices) {
      const j = i + direction;
      if (j >= 0 && j < frames.length && !selected.includes(frames[j]!.id))
        [frames[i], frames[j]] = [frames[j]!, frames[i]!];
    }
    commit({ ...edit, actions: edit.actions.map((g) => (g === group ? { ...g, frames } : g)) });
  };
  const duplicate = () => {
    if (!group) return;
    commit({
      ...edit,
      actions: edit.actions.map((g) =>
        g === group
          ? {
              ...g,
              frames: g.frames.flatMap((f) =>
                selected.includes(f.id) ? [f, { ...f, id: uid() }] : [f],
              ),
            }
          : g,
      ),
    });
  };
  const remove = () => {
    if (!group) return;
    const frames = group.frames.filter((f) => !selected.includes(f.id));
    if (!frames.length) {
      setError("Keep at least one frame in an action.");
      return;
    }
    commit({ ...edit, actions: edit.actions.map((g) => (g === group ? { ...g, frames } : g)) });
    setSelected([]);
  };
  const addCells = (fresh: boolean) => {
    const cells = edit.cells.filter((c) => selectedCells.includes(c.id));
    if (!cells.length) return;
    const frames = cells.map((c) => ({ id: uid(), cellId: c.id, offsetX: 0, offsetY: 0 }));
    const id = uid();
    commit({
      ...edit,
      actions: fresh
        ? [
            ...edit.actions,
            {
              action: {
                id,
                name: `action-${edit.actions.length + 1}`,
                description: "",
                enabled: true,
                frameCount: frames.length,
                fps: 12,
                loop: true,
              },
              frames,
            },
          ]
        : edit.actions.map((g) => (g === group ? { ...g, frames: [...g.frames, ...frames] } : g)),
    });
    if (fresh) setActionId(id);
  };
  const applySuggestion = () => {
    commit({
      ...edit,
      actions: edit.actions.map((g) => ({
        ...g,
        frames: g.frames.map((f) =>
          selected.includes(f.id) || (!selected.length && f.id === currentFrame?.id)
            ? { ...f, ...suggestions.find((s) => s.id === f.id) }
            : f,
        ),
      })),
    });
    setSuggestions([]);
  };
  const support = () => {
    const canvas = previewCanvas.current;
    if (!canvas || !currentFrame) return;
    const a = spriteSupportAnchor(
      canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
    if (!a) {
      setError("No reliable transparent foreground. Set the anchor manually.");
      return;
    }
    commit({
      ...edit,
      actions: edit.actions.map((g) => ({
        ...g,
        frames: g.frames.map((f) =>
          f.id === currentFrame.id
            ? { ...f, anchor: { x: a.x - f.offsetX, y: a.y - f.offsetY, confirmed: false } }
            : f,
        ),
      })),
    });
    setNotice(
      a.reliable
        ? "Anchor suggestion requires confirmation."
        : "Multiple supports or image edges detected. Confirm the anchor manually.",
    );
  };
  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest("[data-handle]") as HTMLElement | null;
    const clicked = edit.cells.find((c) => c.id === target?.dataset.cellId) ?? cell;
    if (!clicked) return;
    const handle = target?.dataset.handle;
    if (!handle) return;
    e.preventDefault();
    setCellId(clicked.id);
    drag.current = { x: e.clientX, y: e.clientY, cell: clicked, handle };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const pointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const b = e.currentTarget.getBoundingClientRect();
    const dx = Math.round(((e.clientX - d.x) * candidate.source.width) / b.width),
      dy = Math.round(((e.clientY - d.y) * candidate.source.height) / b.height),
      c = d.cell;
    let x = c.x,
      y = c.y,
      w = c.width,
      h = c.height;
    if (d.handle === "move") {
      x = Math.min(candidate.source.width - w, Math.max(0, x + dx));
      y = Math.min(candidate.source.height - h, Math.max(0, y + dy));
    } else {
      if (d.handle.includes("w")) {
        const nx = Math.max(0, Math.min(x + w - 1, x + dx));
        w += x - nx;
        x = nx;
      }
      if (d.handle.includes("e")) w = Math.max(1, Math.min(candidate.source.width - x, w + dx));
      if (d.handle.includes("n")) {
        const ny = Math.max(0, Math.min(y + h - 1, y + dy));
        h += y - ny;
        y = ny;
      }
      if (d.handle.includes("s")) h = Math.max(1, Math.min(candidate.source.height - y, h + dy));
    }
    patchCell({ x, y, width: w, height: h });
  };
  const properties = (
    <div className="space-y-4 p-3" data-testid="sprite-repair-properties">
      <h3 className="font-medium">
        {tr(
          tab === "slice"
            ? "Selected source cell"
            : tab === "groups"
              ? "Action grouping"
              : "Frame alignment",
        )}
      </h3>
      {tab === "slice" && cell && (
        <>
          <p className="text-ui-sm text-muted-foreground">
            {tr("Crop boundaries and content origin are independent.")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(["x", "y", "width", "height", "originX", "originY"] as const).map((k) => (
              <SpriteNumberField
                key={k}
                label={tr(
                  k === "originX"
                    ? "Content origin X"
                    : k === "originY"
                      ? "Content origin Y"
                      : k === "width"
                        ? "Cell width"
                        : k === "height"
                          ? "Cell height"
                          : k.toUpperCase(),
                )}
                value={cell[k]}
                min={k === "width" || k === "height" ? 1 : 0}
                onChange={(v) => patchCell({ [k]: v })}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={cell.enabled}
              onCheckedChange={(enabled) => patchCell({ enabled: !!enabled })}
            />
            {tr("Include this source cell")}
          </label>
          <details open>
            <summary className="cursor-pointer text-ui-sm">{tr("Advanced layout")}</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SpriteNumberField
                label={tr("Columns")}
                value={columns}
                max={1024}
                onChange={setColumns}
              />
              <SpriteNumberField label={tr("Rows")} value={rows} max={1024} onChange={setRows} />
              {(["x", "y", "width", "height"] as const).map((k) => (
                <SpriteNumberField
                  key={k}
                  label={tr(
                    k === "width"
                      ? "Content width"
                      : k === "height"
                        ? "Content height"
                        : `Content ${k.toUpperCase()}`,
                  )}
                  value={region[k]}
                  min={k === "width" || k === "height" ? 1 : 0}
                  onChange={(v) => setRegion((p) => ({ ...p, [k]: v }))}
                />
              ))}
            </div>
            <Button size="sm" variant="outline" className="mt-3" onClick={applyGrid}>
              {tr("Apply grid layout")}
            </Button>
          </details>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await drawingApi().spriteCommand({
                  operation: "analyze-candidate",
                  projectId: run.context.projectId,
                  runId: run.id,
                  candidateId: candidate.id,
                });
                onState(result);
                setNotice("Analysis updated. Apply the suggestion only after reviewing it.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr("Analyze source again")}
          </Button>
          {candidate.analysis && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = spriteEditFromSlice(candidate.analysis!.suggestion);
                setColumns(new Set(next.cells.map((c) => c.x)).size);
                setRows(new Set(next.cells.map((c) => c.y)).size);
                setRegion({
                  x: Math.min(...next.cells.map((c) => c.x)),
                  y: Math.min(...next.cells.map((c) => c.y)),
                  width:
                    Math.max(...next.cells.map((c) => c.x + c.width)) -
                    Math.min(...next.cells.map((c) => c.x)),
                  height:
                    Math.max(...next.cells.map((c) => c.y + c.height)) -
                    Math.min(...next.cells.map((c) => c.y)),
                });
                commit({
                  ...next,
                  actions: next.actions.map((g) => ({
                    ...g,
                    action: { ...g.action, fps: group?.action.fps ?? g.action.fps },
                  })),
                });
              }}
            >
              {tr("Use content suggestion")}
            </Button>
          )}
        </>
      )}
      {group && (
        <>
          <label className="flex flex-col gap-1 text-ui-sm">
            {tr("Action name")}
            <Input
              value={group.action.name}
              onChange={(e) => patchGroup({ name: e.target.value })}
            />
          </label>
          <SpriteNumberField
            label={tr("FPS")}
            value={group.action.fps}
            max={60}
            onChange={(fps) => patchGroup({ fps })}
          />
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={group.action.loop}
              onCheckedChange={(loop) => patchGroup({ loop: !!loop })}
            />
            {tr("Loop")}
          </label>
        </>
      )}
      {tab === "align" && currentFrame && (
        <>
          <p className="text-ui-sm text-muted-foreground">
            {tr(
              "Drag the character or use arrow keys. Shift moves 10 pixels. Multi-selection applies the same translation.",
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <SpriteNumberField
              label={tr("Offset X")}
              min={-4096}
              value={currentFrame.offsetX / correctionUnit}
              onChange={(v) => shift(v * correctionUnit - currentFrame.offsetX, 0)}
            />
            <SpriteNumberField
              label={tr("Offset Y")}
              min={-4096}
              value={currentFrame.offsetY / correctionUnit}
              onChange={(v) => shift(0, v * correctionUnit - currentFrame.offsetY)}
            />
          </div>
          <label className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              checked={!!currentFrame.allowEmpty}
              onCheckedChange={(allowEmpty) =>
                commit({
                  ...edit,
                  actions: edit.actions.map((g) => ({
                    ...g,
                    frames: g.frames.map((f) =>
                      f.id === currentFrame.id ? { ...f, allowEmpty: !!allowEmpty } : f,
                    ),
                  })),
                })
              }
            />
            {tr("Intentional blank frame")}
          </label>
          <SpriteNumberField
            label={tr("Frame duration (ms)")}
            value={currentFrame.durationMs ?? Math.round(1000 / (group?.action.fps ?? 12))}
            max={60000}
            onChange={(durationMs) =>
              commit({
                ...edit,
                actions: edit.actions.map((g) => ({
                  ...g,
                  frames: g.frames.map((f) => (selected.includes(f.id) ? { ...f, durationMs } : f)),
                })),
              })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              commit({
                ...edit,
                actions: edit.actions.map((g) => ({
                  ...g,
                  frames: g.frames.map((f) =>
                    selected.includes(f.id) ? { ...f, durationMs: undefined } : f,
                  ),
                })),
              })
            }
          >
            {tr("Inherit action FPS")}
          </Button>
          <SpriteSelect
            label={tr("Baseline frame")}
            value={baselineId}
            options={(group?.frames ?? []).map((f, i) => ({
              value: f.id,
              label: `${tr("Frame")} ${i + 1}`,
            }))}
            onChange={setBaselineId}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={onion ? "secondary" : "ghost"}
              onClick={() => setOnion(!onion)}
            >
              {tr("Previous frame onion skin")}
            </Button>
            <Button
              size="sm"
              variant={reference ? "secondary" : "ghost"}
              onClick={() => setReference(!reference)}
            >
              {tr("Compare character reference")}
            </Button>
            <Button
              size="sm"
              variant={anchorMode ? "secondary" : "outline"}
              onClick={() => setAnchorMode(!anchorMode)}
            >
              {tr("Set anchor manually")}
            </Button>
            <Button size="sm" variant="outline" onClick={support}>
              {tr("Suggest support anchor")}
            </Button>
          </div>
          {currentFrame.anchor && (
            <>
              <p className="text-ui-sm">
                {tr(
                  currentFrame.anchor.confirmed ? "Anchor confirmed" : "Anchor needs confirmation",
                )}{" "}
                · {Math.round(currentFrame.anchor.x)},{Math.round(currentFrame.anchor.y)}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  commit({
                    ...edit,
                    actions: edit.actions.map((g) => ({
                      ...g,
                      frames: g.frames.map((f) =>
                        f.id === currentFrame.id
                          ? { ...f, anchor: { ...currentFrame.anchor!, confirmed: true } }
                          : f,
                      ),
                    })),
                  })
                }
              >
                {tr("Confirm anchor")}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              try {
                setSuggestions(spriteStationarySuggestions(edit, group!.action.id, baselineId));
                setNotice(
                  "Preview fixed-position corrections, then apply to selected frames. Intentional movement is preserved until applied.",
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {tr("Preview fixed position")}
          </Button>
          {!!suggestions.length && (
            <Button size="sm" onClick={applySuggestion}>
              {tr("Apply corrections to selected frames")}
            </Button>
          )}
        </>
      )}
      {(candidate.processingVersions?.length ?? 0) > 1 && (
        <SpriteSelect
          label={tr("Processing versions")}
          value={historyId}
          options={candidate.processingVersions!.map((v, i) => ({
            value: v.id,
            label: `v${i + 1} · ${new Date(v.createdAt).toLocaleString()}`,
          }))}
          onChange={(id) => {
            const saved = candidate.processingVersions?.find((v) => v.id === id);
            if (!saved) return;
            commit(spriteEditFromSlice(saved.configuration));
            setHistoryId(id);
            setNotice(
              "Historical processing loaded as an editable draft. Saving creates a new version.",
            );
          }}
        />
      )}
      <details>
        <summary className="cursor-pointer text-ui-sm">{tr("Shared canvas and transform")}</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(["canvasWidth", "canvasHeight", "anchorX", "anchorY"] as const).map((k) => (
            <SpriteNumberField
              key={k}
              label={tr(k)}
              value={edit.common[k]}
              min={k.startsWith("canvas") ? 1 : 0}
              onChange={(v) => commit({ ...edit, common: { ...edit.common, [k]: v } })}
            />
          ))}
          {(["scale", "offsetX", "offsetY"] as const).map((k) => (
            <SpriteNumberField
              key={k}
              label={tr(`Shared ${k}`)}
              value={edit.common.registration[k]}
              min={k === "scale" ? 0.01 : -4096}
              max={k === "scale" ? 16 : 4096}
              step={k === "scale" ? 0.01 : 1}
              onChange={(v) =>
                commit({
                  ...edit,
                  common: { ...edit.common, registration: { ...edit.common.registration, [k]: v } },
                })
              }
            />
          ))}
        </div>
      </details>
    </div>
  );
  const captureCanvas = useCallback((canvas: HTMLCanvasElement) => {
    previewCanvas.current = canvas;
  }, []);
  const frameForPreview = playing ? group?.frames[playIndex % group.frames.length] : currentFrame;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="sprite-repair-editor">
      <div className="sb-work-header">
        <div>
          <h2 className="font-medium">
            {tr("Repair frames")} · {candidate.source.name}
          </h2>
          <p className="text-ui-sm text-muted-foreground">
            {candidate.source.width}×{candidate.source.height} → {run.context.width}×
            {run.context.height} · {tr("Changes are saved as a processing version")}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => (dirty ? setLeave(true) : onBack())}>
          {tr("Return to candidate review")}
        </Button>
      </div>
      <div className="sb-toolbar border-b" role="tablist" aria-label={tr("Repair frames")}>
        {(["slice", "groups", "align"] as const).map((value) => (
          <Button
            key={value}
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setTab(value);
              setPlaying(false);
            }}
          >
            {tr(
              value === "slice" ? "Slicing" : value === "groups" ? "Action grouping" : "Alignment",
            )}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={!past.length || busy} onClick={undo}>
          {tr("Undo")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!future.length || busy} onClick={redo}>
          {tr("Redo")}
        </Button>
      </div>
      {version !== (candidate.version ?? 0) && (
        <Alert size="sm" variant="warning">
          {tr("The source processing version changed. Your draft is preserved.")}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEdit(restore());
              setVersion(candidate.version ?? 0);
              setDirty(false);
              setPast([]);
              setFuture([]);
            }}
          >
            {tr("Reload saved version")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void perform("fork-slicing")}>
            {tr("Save as processing branch")}
          </Button>
        </Alert>
      )}
      {error && (
        <Alert variant="error" size="sm">
          {tr(error)}
        </Alert>
      )}
      {notice && (
        <p role="status" className="px-3 py-1 text-ui-sm text-muted-foreground">
          {tr(notice)}
        </p>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
          <div className="flex flex-wrap gap-1">
            {edit.actions.map((g) => (
              <Button
                key={g.action.id}
                size="sm"
                variant={g === group ? "secondary" : "ghost"}
                onClick={() => {
                  setActionId(g.action.id);
                  setSelected(g.frames[0] ? [g.frames[0].id] : []);
                  setCellId(g.frames[0]?.cellId ?? cellId);
                  setPlaying(false);
                }}
              >
                {g.action.name} · {g.frames.length}
              </Button>
            ))}
          </div>
          <div ref={canvasHost} className="min-h-16 min-w-0 flex-1 overflow-auto">
            {tab === "slice" || tab === "groups" ? (
              <div
                ref={sourceRef}
                className="relative mx-auto w-full touch-none border bg-muted/30"
                style={{
                  aspectRatio: `${candidate.source.width}/${candidate.source.height}`,
                  maxWidth: Math.min(
                    640,
                    (Math.max(128, canvasHeight) * candidate.source.width) /
                      candidate.source.height,
                  ),
                }}
                onPointerDown={pointerDown}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                {...spriteImageInput((files) => setReplacement(files))}
              >
                <img
                  src={imageUrl(candidate.source)}
                  alt={tr("Source image")}
                  className="pointer-events-none h-full w-full object-fill"
                  draggable={false}
                />
                {edit.cells.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-label={`${tr("Source cell")} ${i + 1}`}
                    aria-pressed={
                      tab === "groups" ? selectedCells.includes(c.id) : c.id === cell?.id
                    }
                    className={`absolute border ${c.id === cell?.id || selectedCells.includes(c.id) ? "border-primary bg-primary/15" : "border-muted-foreground/50"} text-left text-ui-sm text-foreground`}
                    style={{
                      left: `${(c.x / candidate.source.width) * 100}%`,
                      top: `${(c.y / candidate.source.height) * 100}%`,
                      width: `${(c.width / candidate.source.width) * 100}%`,
                      height: `${(c.height / candidate.source.height) * 100}%`,
                    }}
                    data-cell-id={c.id}
                    data-handle={tab === "slice" ? "move" : undefined}
                    onClick={(e) => {
                      setCellId(c.id);
                      if (tab === "groups")
                        setSelectedCells((p) =>
                          e.metaKey || e.ctrlKey || e.shiftKey
                            ? p.includes(c.id)
                              ? p.filter((id) => id !== c.id)
                              : [...p, c.id]
                            : [c.id],
                        );
                      const f = group?.frames.find((f) => f.cellId === c.id);
                      if (f) setSelected([f.id]);
                    }}
                  >
                    <span className="pointer-events-none bg-background/80 px-1">
                      {group?.frames
                        .flatMap((f, j) => (f.cellId === c.id ? [j + 1] : []))
                        .join(",") || "–"}
                    </span>
                  </button>
                ))}
                {tab === "slice" &&
                  cell &&
                  (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((handle) => (
                    <div
                      key={handle}
                      data-handle={handle}
                      className="absolute size-3 -translate-1/2 border border-primary bg-background"
                      style={{
                        left: `${((cell.x + (handle.includes("w") ? 0 : handle.includes("e") ? cell.width : cell.width / 2)) / candidate.source.width) * 100}%`,
                        top: `${((cell.y + (handle.includes("n") ? 0 : handle.includes("s") ? cell.height : cell.height / 2)) / candidate.source.height) * 100}%`,
                        cursor: `${handle}-resize`,
                      }}
                    />
                  ))}
              </div>
            ) : (
              <SpriteRepairPreview
                run={run}
                edit={edit}
                frame={frameForPreview}
                maxHeight={canvasHeight}
                onion={
                  onion
                    ? group?.frames[
                        Math.max(0, group.frames.findIndex((f) => f.id === frameForPreview?.id) - 1)
                      ]
                    : undefined
                }
                baseline={group?.frames.find(
                  (f) => f.id === baselineId && f.id !== frameForPreview?.id,
                )}
                reference={reference}
                anchorMode={anchorMode}
                offset={suggestions.find((s) => s.id === frameForPreview?.id)}
                onCanvas={captureCanvas}
                processedAsset={
                  processedPreview?.actions
                    .flatMap((o) =>
                      o.frames.map((asset, i) => ({ asset, id: o.frameMetadata?.[i]?.id })),
                    )
                    .find((f) => f.id === frameForPreview?.id)?.asset
                }
                onMove={(x, y) => {
                  setPlaying(false);
                  shift(x, y);
                }}
                onAnchor={(x, y) => {
                  if (!currentFrame) return;
                  commit({
                    ...edit,
                    actions: edit.actions.map((g) => ({
                      ...g,
                      frames: g.frames.map((f) =>
                        f.id === currentFrame.id ? { ...f, anchor: { x, y, confirmed: true } } : f,
                      ),
                    })),
                  });
                  setAnchorMode(false);
                }}
              />
            )}
          </div>
          {tab === "groups" && (
            <div className="space-y-3">
              <SpriteSelect
                label={tr("Organize actions")}
                value={groupPreset}
                options={[
                  { value: "all", label: tr("All valid cells as one action") },
                  { value: "rows", label: tr("One action per row") },
                  { value: "columns", label: tr("One action per column") },
                ]}
                onChange={setGroupPreset}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={regroup}>
                  {tr("Apply grouping")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!selectedCells.length}
                  onClick={() => addCells(false)}
                >
                  {tr("Add selected cells to action")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!selectedCells.length}
                  onClick={() => addCells(true)}
                >
                  {tr("Create action from selected cells")}
                </Button>
              </div>
              <p className="text-ui-sm text-muted-foreground">
                {tr(
                  "Cells can be reused across actions. Each addition creates independent frames.",
                )}
              </p>
            </div>
          )}
          <div className="shrink-0 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTab("align");
                setPlayIndex(group?.frames.findIndex((f) => f.id === currentFrame?.id) ?? 0);
                setPlaying(!playing);
              }}
            >
              {tr(playing ? "Pause" : "Play")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(group?.frames.map((f) => f.id) ?? [])}
            >
              {tr("Select all frames")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!selected.length}
              onClick={() => reorder(-1)}
            >
              {tr("Move earlier")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!selected.length}
              onClick={() => reorder(1)}
            >
              {tr("Move later")}
            </Button>
            <Button size="sm" variant="ghost" disabled={!selected.length} onClick={duplicate}>
              {tr("Duplicate frames")}
            </Button>
            <Button size="sm" variant="ghost" disabled={!selected.length} onClick={remove}>
              {tr("Remove frames")}
            </Button>
          </div>
          <div
            className="flex shrink-0 gap-2 overflow-x-auto pb-2"
            aria-label={tr("Action frames")}
          >
            {group?.frames.map((f, i) => {
              const c = edit.cells.find((c) => c.id === f.cellId);
              return (
                <button
                  key={f.id}
                  className={`w-20 shrink-0 rounded border p-1 text-ui-sm ${selected.includes(f.id) ? "border-primary bg-primary/10" : "border-border"}`}
                  aria-label={`${tr("Frame")} ${i + 1}`}
                  aria-pressed={selected.includes(f.id)}
                  onClick={(e) => changeSelection(f, e.metaKey || e.ctrlKey || e.shiftKey)}
                >
                  {c && (
                    <svg viewBox={`${c.x} ${c.y} ${c.width} ${c.height}`} className="h-14 w-full">
                      <image
                        href={imageUrl(candidate.source)}
                        width={candidate.source.width}
                        height={candidate.source.height}
                      />
                    </svg>
                  )}
                  <span>
                    {i + 1} · {Math.round(f.durationMs ?? 1000 / (group.action.fps || 12))}ms
                  </span>
                </button>
              );
            })}
          </div>
          {!inspectorHost && <div className="min-h-32 overflow-auto">{properties}</div>}
        </div>
      </div>
      {inspectorHost && createPortal(properties, inspectorHost)}
      {footerHost &&
        createPortal(
          <Button className="w-full" disabled={busy} onClick={() => void perform("save-slicing")}>
            {tr("Save corrections and return to review")}
          </Button>,
          footerHost,
        )}
      <div className="sb-work-footer flex-wrap shrink-0 border-t">
        <input
          ref={replaceInput}
          hidden
          type="file"
          accept="image/*"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) setReplacement(files);
          }}
        />
        {onReplaceSource && (
          <Button variant="ghost" size="sm" onClick={() => replaceInput.current?.click()}>
            {tr("Replace source image")}
          </Button>
        )}
        <span className="mr-auto text-ui-sm text-muted-foreground">
          {dirty ? tr("Unsaved corrections") : tr("Saved processing version")}
        </span>
        <Button variant="outline" disabled={busy} onClick={() => void perform("preview-slicing")}>
          {tr("Validate processing")}
        </Button>
        {!footerHost && (
          <Button disabled={busy} onClick={() => void perform("save-slicing")}>
            {tr("Save corrections and return to review")}
          </Button>
        )}
      </div>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Confirm frame mapping changes")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>{tr(pending?.message ?? "")}</DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              onClick={() => {
                if (pending) commit(pending.edit);
                setPending(null);
              }}
            >
              {tr("Apply changes")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={leave} onOpenChange={setLeave}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Keep unsaved corrections?")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {tr(
              "Your repair draft is saved locally and can be resumed. No candidate has been adopted.",
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeave(false)}>
              {tr("Continue editing")}
            </Button>
            <Button
              onClick={() => {
                setLeave(false);
                onBack();
              }}
            >
              {tr("Keep draft and return")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!replacement}
        onOpenChange={(open) => {
          if (!open) setReplacement(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Replace source image")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {tr(
              "Your current corrections remain in this source draft. The replacement opens a separate processing branch.",
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplacement(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              onClick={() => {
                if (replacement && onReplaceSource)
                  void onReplaceSource(replacement).catch((e) => setError((e as Error).message));
                setReplacement(null);
              }}
            >
              {tr("Keep draft and replace")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
