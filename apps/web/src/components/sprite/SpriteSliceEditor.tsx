/* eslint-disable react/no-array-index-key -- Grid slots keep positional identity while boundaries are dragged. */
/* eslint-disable oxc/no-map-spread -- Immutable row updates preserve the unsaved editor snapshot. */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  spriteGridSlice,
  SPRITE_ANALYSIS_VERSION,
  spriteBoundaries,
  validateSpriteSlice,
  type SpriteRun,
  type SpriteSliceConfiguration,
  type SpriteCandidate,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { drawingApi, imageUrl } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { spriteCandidate } from "./SpriteResults";
const field = "h-8 min-w-0 rounded border bg-background px-2 text-xs";
function contentRegion(slice: SpriteSliceConfiguration) {
  const cells = slice.rows.flatMap((row) => row.cells);
  const x = Math.min(...cells.map((cell) => cell.x));
  const y = Math.min(...cells.map((cell) => cell.y));
  return {
    x,
    y,
    width: Math.max(...cells.map((cell) => cell.x + cell.width)) - x,
    height: Math.max(...cells.map((cell) => cell.y + cell.height)) - y,
  };
}
export function SpriteSliceEditor({
  run,
  onState,
  onBack,
}: {
  run: SpriteRun;
  onState: (state: import("@synara/contracts").SpriteState) => void;
  onBack: () => void;
}) {
  const tr = useAhaTranslation(),
    candidate = spriteCandidate(run)!;
  const actions =
    run.configuration?.actions.filter((a) => a.enabled) ?? run.actions?.map((a) => a.action) ?? [];
  const grid = () => spriteGridSlice(candidate.source.width, candidate.source.height, actions);
  const [slice, setSlice] = useState<SpriteSliceConfiguration>(() => candidate.slice ?? grid()),
    [editVersion, setEditVersion] = useState(candidate.version ?? 0),
    [rowIndex, setRowIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<SpriteCandidate | null>(null),
    [frame, setFrame] = useState(0);
  const [crop, setCrop] = useState(() => contentRegion(slice));
  const imageRef = useRef<HTMLDivElement>(null),
    snapshot = useRef(slice);
  snapshot.current = slice;
  const row = slice.rows[rowIndex] ?? slice.rows[0]!;
  const edit = (value: SpriteSliceConfiguration) => {
    setSlice({ ...value, reviewedActionIds: [] });
    setDirty(true);
    setPreview(null);
    setError("");
  };
  const actionPatch = (value: Partial<typeof row.action>) =>
    edit({
      ...slice,
      rows: slice.rows.map((r, i) =>
        i === rowIndex ? { ...r, action: { ...r.action, ...value } } : r,
      ),
    });
  const cellPatch = (index: number, value: Partial<(typeof row.cells)[number]>) =>
    edit({
      ...slice,
      rows: slice.rows.map((r, i) =>
        i === rowIndex
          ? { ...r, cells: r.cells.map((c, j) => (j === index ? { ...c, ...value } : c)) }
          : r,
      ),
    });
  const reset = (value: SpriteSliceConfiguration) => {
    edit(value);
    setRowIndex(0);
    setFrame(0);
    setCrop(contentRegion(value));
  };
  const numeric = (
    label: string,
    value: number,
    apply: (n: number) => void,
    min = 0,
    max = 4096,
  ) => (
    <label className="flex items-center gap-1 text-xs">
      <span>
        {/^(X|Y|Width|Height) \d+$/.test(label)
          ? `${tr(label.split(" ")[0]!)} ${label.split(" ")[1]}`
          : tr(label)}
      </span>
      <input
        aria-label={tr(label)}
        type="number"
        className={`${field} w-20`}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isInteger(n) && n >= min && n <= max) apply(n);
        }}
      />
    </label>
  );
  const fromCrop = (next = crop) => {
    const ys = spriteBoundaries(next.height, slice.rows.length, next.y);
    const rows = slice.rows.map((r, i) => {
      const xs = spriteBoundaries(next.width, r.cells.length, next.x);
      return {
        ...r,
        cells: r.cells.map((c, j) => ({
          ...c,
          x: xs[j]!,
          y: ys[i]!,
          width: xs[j + 1]! - xs[j]!,
          height: ys[i + 1]! - ys[i]!,
        })),
      };
    });
    edit({
      ...slice,
      rows,
      canvasWidth: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.width))),
      canvasHeight: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.height))),
      anchorX: 0,
      anchorY: 0,
    });
  };
  const drag = (
    event: React.PointerEvent,
    kind: "x" | "y" | "crop-left" | "crop-right" | "crop-top" | "crop-bottom",
    edge: number,
  ) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const bounds = imageRef.current!.getBoundingClientRect();
      const x = Math.round(((e.clientX - bounds.left) / bounds.width) * candidate.source.width),
        y = Math.round(((e.clientY - bounds.top) / bounds.height) * candidate.source.height);
      const current = snapshot.current;
      if (kind.startsWith("crop")) {
        setCrop((p) => {
          if (kind === "crop-left") {
            const nx = Math.max(0, Math.min(p.x + p.width - 1, x));
            return { ...p, x: nx, width: p.x + p.width - nx };
          }
          if (kind === "crop-right")
            return { ...p, width: Math.max(1, Math.min(candidate.source.width - p.x, x - p.x)) };
          if (kind === "crop-top") {
            const ny = Math.max(0, Math.min(p.y + p.height - 1, y));
            return { ...p, y: ny, height: p.y + p.height - ny };
          }
          return { ...p, height: Math.max(1, Math.min(candidate.source.height - p.y, y - p.y)) };
        });
        return;
      }
      if (kind === "x") {
        const cells = [...current.rows[rowIndex]!.cells],
          before = cells[edge - 1],
          after = cells[edge];
        const left = before?.x ?? 0,
          right = after ? after.x + after.width : candidate.source.width;
        const nx = Math.max(left + 1, Math.min(right - 1, x));
        if (before) cells[edge - 1] = { ...before, width: nx - before.x };
        if (after) cells[edge] = { ...after, x: nx, width: after.x + after.width - nx };
        edit({
          ...current,
          rows: current.rows.map((r, i) => (i === rowIndex ? { ...r, cells } : r)),
        });
      } else {
        const before = current.rows[edge - 1],
          after = current.rows[edge];
        const top = before?.cells[0]?.y ?? 0,
          bottom = after
            ? Math.max(...after.cells.map((c) => c.y + c.height))
            : candidate.source.height;
        const ny = Math.max(top + 1, Math.min(bottom - 1, y));
        edit({
          ...current,
          rows: current.rows.map((r, i) =>
            i === edge - 1
              ? { ...r, cells: r.cells.map((c) => ({ ...c, height: ny - c.y })) }
              : i === edge
                ? {
                    ...r,
                    cells: r.cells.map((c) => ({ ...c, y: ny, height: c.y + c.height - ny })),
                  }
                : r,
          ),
        });
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const perform = async (
    operation: "preview-slicing" | "save-slicing" | "restore-slicing",
    processingVersionId?: string,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (operation !== "restore-slicing")
        validateSpriteSlice(slice, candidate.source.width, candidate.source.height);
      const state = await drawingApi().spriteCommand({
        operation,
        projectId: run.context.projectId,
        runId: run.id,
        candidateId: candidate.id,
        version: editVersion,
        slice,
        ...(processingVersionId ? { processingVersionId } : {}),
      });
      const updated = state.runs
        .find((r) => r.id === run.id)
        ?.candidates?.find((c) => c.id === candidate.id);
      if (operation === "preview-slicing") setPreview(updated ?? null);
      else {
        onState(state);
        if (updated?.slice) {
          setSlice(updated.slice);
          setCrop(contentRegion(updated.slice));
          setRowIndex((index) => Math.min(index, updated.slice!.rows.length - 1));
          setFrame(0);
        }
        setEditVersion(updated?.version ?? editVersion);
        setDirty(false);
        setPreview(null);
        setNotice(tr("Slicing correction saved. No image was generated."));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const synchronizeAnalysis = (state: import("@synara/contracts").SpriteState) => {
    const analyzed = state.runs
      .find((item) => item.id === run.id)
      ?.candidates?.find((item) => item.id === candidate.id);
    if (analyzed) {
      setEditVersion(analyzed.version ?? editVersion);
      setSlice((current) => ({ ...current, reviewedActionIds: [] }));
      setPreview(null);
    }
    onState(state);
  };
  const acceptAnalysis = useEffectEvent(synchronizeAnalysis);
  const analysisId = candidate.id,
    analysisVersion = candidate.version ?? 0,
    hasAnalysis = candidate.analysis?.algorithmVersion === SPRITE_ANALYSIS_VERSION,
    analysisProject = run.context.projectId;
  useEffect(() => {
    if (hasAnalysis) return;
    let live = true;
    setBusy(true);
    void drawingApi()
      .spriteCommand({
        operation: "analyze-candidate",
        projectId: analysisProject,
        runId: run.id,
        candidateId: analysisId,
        version: analysisVersion,
      })
      .then((state) => {
        if (live) {
          setBusy(false);
          acceptAnalysis(state);
        }
      })
      .catch((e) => {
        if (live) {
          setBusy(false);
          setError(String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [analysisId, analysisVersion, hasAnalysis, analysisProject, run.id]);
  const currentPreview = preview?.actions.find((a) => a.action.id === row.action.id),
    previewFrame =
      currentPreview?.frames[Math.min(frame, (currentPreview?.frames.length ?? 1) - 1)];
  return (
    <section className="space-y-4" aria-label={tr("Correct frame slicing")}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{tr("Correct frame slicing")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {candidate.source.width} × {candidate.source.height} · {tr("Planned frames")}:{" "}
            {actions.reduce((n, a) => n + a.frameCount, 0)} · {tr("Correction frames")}:{" "}
            {slice.rows.reduce((n, r) => n + r.cells.filter((c) => c.enabled).length, 0)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!dirty || window.confirm(tr("Discard unsaved slicing changes?"))) onBack();
          }}
        >
          {tr("Back to task details")}
        </Button>
      </header>
      <fieldset disabled={busy} className="contents">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => reset(grid())}>
            {tr("Use planned grid")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!candidate.analysis?.reliable || busy}
            onClick={() => reset(candidate.analysis!.suggestion)}
          >
            {tr("Use content suggestion")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void drawingApi()
                .spriteCommand({
                  operation: "analyze-candidate",
                  projectId: run.context.projectId,
                  runId: run.id,
                  candidateId: candidate.id,
                  version: editVersion,
                })
                .then(synchronizeAnalysis)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {tr("Recheck layout")}
          </Button>
        </div>
        {candidate.analysis && !candidate.analysis.reliable && (
          <p className="rounded-lg border border-orange-500/30 p-3 text-xs">
            {tr(
              "The content layout could not be reliably identified. Review frame boundaries manually.",
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2 rounded-lg border p-3">
          {numeric(
            "Content left",
            crop.x,
            (n) => setCrop((p) => ({ ...p, x: n })),
            0,
            candidate.source.width - 1,
          )}
          {numeric(
            "Content top",
            crop.y,
            (n) => setCrop((p) => ({ ...p, y: n })),
            0,
            candidate.source.height - 1,
          )}
          {numeric(
            "Content width",
            crop.width,
            (n) => setCrop((p) => ({ ...p, width: n })),
            1,
            candidate.source.width,
          )}
          {numeric(
            "Content height",
            crop.height,
            (n) => setCrop((p) => ({ ...p, height: n })),
            1,
            candidate.source.height,
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              try {
                fromCrop();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {tr("Apply content region")}
          </Button>
        </div>
        <div
          className="relative mx-auto max-w-4xl overflow-hidden rounded border bg-muted/30"
          ref={imageRef}
          style={{
            aspectRatio: `${candidate.source.width}/${candidate.source.height}`,
            backgroundImage: "repeating-conic-gradient(#80808020 0% 25%,transparent 0% 50%)",
            backgroundSize: "20px 20px",
          }}
        >
          <img
            draggable={false}
            src={imageUrl(candidate.source)}
            alt={tr("Original image with frame boundaries")}
            className="pointer-events-none absolute inset-0 size-full object-contain"
          />
          {slice.rows.flatMap((r, ri) =>
            r.cells.map((c, i) => (
              <div
                key={`${ri}:${i}`}
                className={`pointer-events-none absolute border ${ri === rowIndex ? "border-primary" : "border-orange-400/70"} ${c.enabled ? "" : "bg-black/20"}`}
                style={{
                  left: `${(c.x / candidate.source.width) * 100}%`,
                  top: `${(c.y / candidate.source.height) * 100}%`,
                  width: `${(c.width / candidate.source.width) * 100}%`,
                  height: `${(c.height / candidate.source.height) * 100}%`,
                }}
              />
            )),
          )}
          {row.cells.map((c, i) => (
            <div
              key={`x:${i}`}
              role="separator"
              aria-label={`${tr("Frame boundary")} ${i}`}
              onPointerDown={(e) => drag(e, "x", i)}
              className="absolute z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none border-l-2 border-primary"
              style={{
                left: `${(c.x / candidate.source.width) * 100}%`,
                top: `${(c.y / candidate.source.height) * 100}%`,
                height: `${(c.height / candidate.source.height) * 100}%`,
              }}
            />
          ))}
          {slice.rows.map((r, i) => (
            <div
              key={`y:${i}`}
              role="separator"
              aria-label={`${tr("Row boundary")} ${i}`}
              onPointerDown={(e) => drag(e, "y", i)}
              className="absolute z-10 h-3 w-full -translate-y-1/2 cursor-row-resize touch-none border-t-2 border-orange-400"
              style={{ top: `${(r.cells[0]!.y / candidate.source.height) * 100}%` }}
            />
          ))}
          {(["left", "right", "top", "bottom"] as const).map((side) => (
            <div
              key={side}
              onPointerDown={(e) => drag(e, `crop-${side}`, 0)}
              className={`absolute z-20 touch-none ${side === "left" || side === "right" ? "h-full w-3 cursor-col-resize border-l-2" : "h-3 w-full cursor-row-resize border-t-2"} border-emerald-500`}
              style={
                side === "left"
                  ? { left: `${(crop.x / candidate.source.width) * 100}%` }
                  : side === "right"
                    ? { left: `${((crop.x + crop.width) / candidate.source.width) * 100}%` }
                    : side === "top"
                      ? { top: `${(crop.y / candidate.source.height) * 100}%` }
                      : { top: `${((crop.y + crop.height) / candidate.source.height) * 100}%` }
              }
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {tr(
            "Drag grid boundaries or enter exact original-image coordinates. Green boundaries define the content region.",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {numeric(
            "Rows",
            slice.rows.length,
            (n) => {
              const nextActions = Array.from(
                { length: n },
                (_, i) =>
                  slice.rows[i]?.action ?? {
                    ...slice.rows[0]!.action,
                    id: crypto.randomUUID(),
                    name: `action-${i + 1}`,
                  },
              );
              const rows = spriteGridSlice(
                candidate.source.width,
                candidate.source.height,
                nextActions,
              ).rows;
              reset({
                ...slice,
                rows,
                canvasWidth: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.width))),
                canvasHeight: Math.max(...rows.flatMap((r) => r.cells.map((c) => c.height))),
                anchorX: 0,
                anchorY: 0,
              });
            },
            1,
            32,
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {slice.rows.map((r, i) => (
            <Button
              key={r.action.id}
              size="sm"
              variant={i === rowIndex ? "default" : "outline"}
              onClick={() => {
                setRowIndex(i);
                setFrame(0);
              }}
            >
              {r.action.name} · {r.cells.filter((c) => c.enabled).length}
            </Button>
          ))}
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label={tr("Action name")}
              className={field}
              value={row.action.name}
              onChange={(e) => actionPatch({ name: e.target.value })}
            />
            {numeric("FPS", row.action.fps, (n) => actionPatch({ fps: n }), 1, 60)}
            <label className="text-xs">
              <input
                type="checkbox"
                checked={row.action.loop}
                onChange={(e) => actionPatch({ loop: e.target.checked })}
              />{" "}
              {tr("Loop")}
            </label>
            {numeric(
              "Frames",
              row.cells.length,
              (n) => {
                const left = row.cells[0]!.x,
                  right = Math.max(...row.cells.map((c) => c.x + c.width)),
                  xs = spriteBoundaries(right - left, n, left),
                  base = row.cells[0]!;
                edit({
                  ...slice,
                  rows: slice.rows.map((r, i) =>
                    i === rowIndex
                      ? {
                          ...r,
                          cells: xs
                            .slice(0, -1)
                            .map((x, j) => ({ ...base, x, width: xs[j + 1]! - x, enabled: true })),
                          action: { ...r.action, frameCount: n },
                        }
                      : r,
                  ),
                });
              },
              1,
              32,
            )}
            {numeric(
              "Row top",
              row.cells[0]!.y,
              (n) =>
                edit({
                  ...slice,
                  rows: slice.rows.map((r, i) =>
                    i === rowIndex ? { ...r, cells: r.cells.map((c) => ({ ...c, y: n })) } : r,
                  ),
                }),
              0,
              candidate.source.height - 1,
            )}
            {numeric(
              "Row height",
              row.cells[0]!.height,
              (n) =>
                edit({
                  ...slice,
                  rows: slice.rows.map((r, i) =>
                    i === rowIndex ? { ...r, cells: r.cells.map((c) => ({ ...c, height: n })) } : r,
                  ),
                }),
              1,
              candidate.source.height,
            )}
          </div>
          <div className="max-h-72 space-y-2 overflow-auto">
            {row.cells.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs">
                <label>
                  <input
                    aria-label={`${tr("Keep frame")} ${i + 1}`}
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => cellPatch(i, { enabled: e.target.checked })}
                  />{" "}
                  {tr("Frame")} {i + 1}
                </label>
                {numeric(
                  `X ${i + 1}`,
                  c.x,
                  (n) => cellPatch(i, { x: n }),
                  0,
                  candidate.source.width,
                )}
                {numeric(
                  `Y ${i + 1}`,
                  c.y,
                  (n) => cellPatch(i, { y: n }),
                  0,
                  candidate.source.height,
                )}
                {numeric(
                  `Width ${i + 1}`,
                  c.width,
                  (n) => cellPatch(i, { width: n }),
                  1,
                  candidate.source.width,
                )}
                {numeric(
                  `Height ${i + 1}`,
                  c.height,
                  (n) => cellPatch(i, { height: n }),
                  1,
                  candidate.source.height,
                )}
                {[-1, 1].map((direction) => (
                  <Button
                    key={direction}
                    size="sm"
                    variant="ghost"
                    disabled={i + direction < 0 || i + direction >= row.cells.length}
                    onClick={() => {
                      const cells = [...row.cells];
                      [cells[i], cells[i + direction]] = [cells[i + direction]!, cells[i]!];
                      edit({
                        ...slice,
                        rows: slice.rows.map((r, ri) => (ri === rowIndex ? { ...r, cells } : r)),
                      });
                    }}
                  >
                    {tr(direction < 0 ? "Move earlier" : "Move later")}
                  </Button>
                ))}
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 rounded bg-muted/30 p-2 text-xs">
            <input
              type="checkbox"
              checked={slice.reviewedActionIds.includes(row.action.id)}
              onChange={(e) => {
                setSlice({
                  ...slice,
                  reviewedActionIds: e.target.checked
                    ? [...slice.reviewedActionIds, row.action.id]
                    : slice.reviewedActionIds.filter((id) => id !== row.action.id),
                });
                setDirty(true);
              }}
            />
            {tr("I checked this action's actual frame count, empty positions and boundaries.")}
          </label>
        </div>
        <div className="flex flex-wrap gap-3 rounded-lg border p-3">
          {numeric(
            "Shared canvas width",
            slice.canvasWidth,
            (n) => edit({ ...slice, canvasWidth: n }),
            1,
          )}
          {numeric(
            "Shared canvas height",
            slice.canvasHeight,
            (n) => edit({ ...slice, canvasHeight: n }),
            1,
          )}
          {numeric("Shared anchor X", slice.anchorX, (n) => edit({ ...slice, anchorX: n }))}
          {numeric("Shared anchor Y", slice.anchorY, (n) => edit({ ...slice, anchorY: n }))}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              edit({
                ...slice,
                canvasWidth: Math.max(...slice.rows.flatMap((r) => r.cells.map((c) => c.width))),
                canvasHeight: Math.max(...slice.rows.flatMap((r) => r.cells.map((c) => c.height))),
                anchorX: 0,
                anchorY: 0,
              })
            }
          >
            {tr("Fit shared canvas to regions")}
          </Button>
        </div>
        {previewFrame && (
          <div className="rounded-lg border p-3">
            <img
              src={imageUrl(previewFrame)}
              alt={row.action.name}
              className="mx-auto h-48 object-contain [image-rendering:pixelated]"
            />
            <input
              aria-label={tr("Preview frame")}
              type="range"
              min={0}
              max={(currentPreview?.frames.length ?? 1) - 1}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
            />
            <span className="text-xs">
              {frame + 1}/{currentPreview?.frames.length}
            </span>
          </div>
        )}
        {!!candidate.processingVersions?.length && (
          <details className="rounded border p-3 text-xs">
            <summary>{tr("Processing history")}</summary>
            {candidate.processingVersions.map((v) => (
              <div key={v.id} className="my-2 flex items-center justify-between">
                <span>
                  {new Date(v.createdAt).toLocaleString()} · {v.frames.length} {tr("frames")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || v.id === candidate.processingVersionId}
                  onClick={() => void perform("restore-slicing", v.id)}
                >
                  {tr("Restore this slicing")}
                </Button>
              </div>
            ))}
          </details>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {tr(error)}{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBusy(true);
                void drawingApi()
                  .spriteCommand({ operation: "get", projectId: run.context.projectId })
                  .then((state) => {
                    onState(state);
                    const latest = state.runs.find((r) => r.id === run.id);
                    if (latest) {
                      const loaded = spriteCandidate(latest);
                      const configuration = loaded?.slice ?? grid();
                      setSlice(configuration);
                      setCrop(contentRegion(configuration));
                      setEditVersion(loaded?.version ?? 0);
                      setRowIndex(0);
                      setFrame(0);
                      setPreview(null);
                      setDirty(false);
                      setError("");
                    }
                  })
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {tr("Reload candidate")}
            </Button>
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-primary">
            {notice}
          </p>
        )}
        <footer className="sticky bottom-0 flex flex-wrap justify-end gap-2 rounded-lg border bg-[var(--color-background-elevated-primary)] p-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void perform("preview-slicing")}
          >
            {tr("Preview slicing")}
          </Button>
          <Button size="sm" disabled={busy || !dirty} onClick={() => void perform("save-slicing")}>
            {tr("Save slicing correction")}
          </Button>
        </footer>
      </fieldset>
    </section>
  );
}
