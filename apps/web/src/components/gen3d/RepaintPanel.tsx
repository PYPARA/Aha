import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  GEN3D_REPAINT_SIZE,
  GEN3D_REPAINT_VIEWS,
  type Gen3DCommand,
  type Gen3DCommandResult,
  type Gen3DRepaintView,
  type Gen3DVersion,
  type ImageAsset,
  type ImageJob,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { EraserIcon, PencilIcon, Undo2Icon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { OptionSelect } from "../ui/option-select";
import { Textarea } from "../ui/textarea";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { MaskCanvasEditor } from "../drawing/MaskCanvasEditor";
import { drawingApi, imageUrl, uploadDrawingImage, useImageProviders } from "../drawing/useDrawing";
import { BRUSH_MAX, BRUSH_MIN, type Gen3DPaintSession } from "./gen3dPaint";

export const REPAINT_VIEW_LABELS: Record<Gen3DRepaintView, string> = {
  custom: "Free angle",
  front: "Front",
  "front-right": "Front right",
  right: "Right",
  back: "Back",
  left: "Left",
  "front-left": "Front left",
  top: "Top",
};
const FEATHERS = [
  [0, "Hard edge"],
  [6, "Small soft edge"],
  [12, "Medium soft edge"],
  [24, "Large soft edge"],
] as const;
const finished = (status: string) =>
  ["succeeded", "partial", "failed", "cancelled", "interrupted"].includes(status);
/** Aha's template around the user's instruction; the mask, not the prompt, bounds the change. */
const repaintPrompt = (instruction: string, partial: boolean) =>
  `Edit only the masked (transparent) area of this image. The image is an orthographic render of ${partial ? "part of " : ""}a 3D game asset and will be used as its texture. Change: ${instruction}. Keep the object's silhouette, outlines, camera, scale and everything outside the masked area unchanged. Paint surface colour and detail only, as a texture would look: the same soft even lighting as the rest of the object, no new cast shadows or highlights, no perspective change, no background change, no text.`;

/** Local repaint: paint a mask on the model in 3D (or on a fixed view's render), edit that view
 * with the drawing channel and project the edit back onto the texture as a new version. */
export function RepaintPanel({
  version,
  disabled,
  blenderMissing,
  paint,
  onPaintingChange,
  act,
  onError,
}: {
  version: Gen3DVersion | undefined;
  disabled: boolean;
  blenderMissing: boolean;
  /** This version's 3D mask, painted in the viewer while the free angle is chosen. */
  paint: Gen3DPaintSession | null;
  onPaintingChange: (painting: boolean) => void;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    providers = useImageProviders();
  const enabled = providers.data?.filter((p) => p.enabled && p.models.length) ?? [];
  const [view, setView] = useState<Gen3DRepaintView>("custom"),
    [base, setBase] = useState<ImageAsset | null>(null),
    [mask, setMask] = useState<ImageAsset | null>(null),
    [editing, setEditing] = useState(false),
    [rendering, setRendering] = useState(false),
    [instruction, setInstruction] = useState(""),
    [feather, setFeather] = useState(12),
    [choice, setChoice] = useState<{ providerId: string; model: string } | null>(null),
    [job, setJob] = useState<ImageJob | null>(null),
    [failure, setFailure] = useState<string | null>(null);
  const current =
    choice ?? (enabled[0] ? { providerId: enabled[0].id, model: enabled[0].models[0]!.id } : null);
  const baked = version?.process?.baked.includes("baseColor") === true;
  const custom = view === "custom";
  // Re-render on brush and mask changes; the mask revision tells a new stroke from a new size.
  useSyncExternalStore(paint?.subscribe ?? noSubscribe, paint?.snapshot ?? zero);
  const renderedMask = useRef(-1);
  useEffect(() => {
    onPaintingChange(baked && custom && !!paint);
    return () => onPaintingChange(false);
  }, [baked, custom, paint]);
  // A render and mask belong to one version and view; switching either starts over.
  useEffect(() => {
    setBase(null);
    setMask(null);
    setJob(null);
    setFailure(null);
  }, [version?.id, view]);
  // Painting after a free-angle render makes that render's mask stale.
  useEffect(() => {
    if (custom && base && paint && paint.maskRevision !== renderedMask.current) {
      setBase(null);
      setMask(null);
    }
  }, [paint?.maskRevision]);
  useEffect(() => {
    if (!job || finished(job.status)) return;
    const timer = setInterval(() => {
      void drawingApi()
        .getJob({ id: job.id })
        .then(setJob)
        .catch((error: unknown) =>
          setFailure(error instanceof Error ? error.message : String(error)),
        );
    }, 2000);
    return () => clearInterval(timer);
  }, [job]);
  useEffect(() => {
    if (!job || !version || !finished(job.status)) return;
    const output = job.outputs[0];
    if (!output || !["succeeded", "partial"].includes(job.status)) {
      setFailure(
        (typeof job.error === "string" ? job.error : job.error?.message) ??
          tr("Image generation failed."),
      );
      return;
    }
    void (async () => {
      const result = await act({
        operation: "repaint",
        versionId: version.id,
        repaintView: view,
        imageJobId: job.id,
        imageAssetId: output.id,
        instruction: instruction.trim(),
        feather,
      });
      if (result) {
        setJob(null);
        setMask(null);
      } else setFailure(tr("The edit could not be projected onto the model."));
    })();
    // The projection starts once per finished drawing job.
  }, [job?.status]);
  const generating = !!job && !finished(job.status);
  const render = async () => {
    if (!version) return;
    setRendering(true);
    setFailure(null);
    try {
      if (custom) {
        const paintMask = paint?.encoded();
        if (!paint?.camera || !paintMask) return;
        const revision = paint.maskRevision;
        const result = await act({
          operation: "render-view",
          versionId: version.id,
          repaintView: "custom",
          repaintCamera: paint.camera,
          paintMask,
        });
        if (result?.viewAsset && result.maskAsset) {
          renderedMask.current = revision;
          setBase(result.viewAsset);
          setMask(result.maskAsset);
        }
        return;
      }
      const result = await act({
        operation: "render-view",
        versionId: version.id,
        repaintView: view,
      });
      if (result?.viewAsset) {
        setBase(result.viewAsset);
        setEditing(true);
      }
    } finally {
      setRendering(false);
    }
  };
  const start = async () => {
    if (!current || !base || !mask) return;
    setFailure(null);
    try {
      setJob(
        await drawingApi().createJob({
          clientRequestId: crypto.randomUUID(),
          providerId: current.providerId,
          model: current.model,
          prompt: repaintPrompt(instruction.trim(), custom),
          parameters: {
            n: 1,
            size: `${GEN3D_REPAINT_SIZE}x${GEN3D_REPAINT_SIZE}`,
            quality: "high",
            outputFormat: "png",
          },
          inputAssetIds: [base.id],
          inputReferences: [],
          maskAssetId: mask.id,
          sourceJobId: null,
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  const busy = disabled || rendering || generating;
  return (
    <section className="space-y-3" aria-labelledby="gen3d-repaint">
      <h3 id="gen3d-repaint" className="font-medium">
        {tr("Local repaint")}
      </h3>
      {!version ? (
        <p className="text-muted-foreground">{tr("Build a version first.")}</p>
      ) : !baked ? (
        <p className="text-ui-xs leading-relaxed text-muted-foreground">
          {tr(
            "Repaint changes a baked texture. Create an optimized version with baked textures in Optimize, then select it.",
          )}
        </p>
      ) : (
        <>
          <p>
            {tr("Source version")}: <strong>{version.name}</strong>
          </p>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("View")}</span>
            <OptionSelect
              label={tr("View")}
              value={view}
              disabled={busy}
              onValueChange={(value) => setView(value as Gen3DRepaintView)}
            >
              <option value="custom">{tr("Paint on the model (free angle)")}</option>
              {GEN3D_REPAINT_VIEWS.map((key) => (
                <option key={key} value={key}>
                  {tr(REPAINT_VIEW_LABELS[key])}
                </option>
              ))}
            </OptionSelect>
          </label>
          {custom && paint && <PaintControls paint={paint} disabled={busy} />}
          {base && (
            <figure className="space-y-1">
              <img
                src={imageUrl(base, "thumbnail")}
                alt={tr(REPAINT_VIEW_LABELS[view])}
                className="aspect-square w-full rounded-md border border-border bg-muted/40 object-contain"
              />
              <figcaption className="text-ui-xs text-muted-foreground">
                {tr(
                  custom
                    ? "Rendered from the viewer's angle, framed on the painted area. The mask follows the model."
                    : mask
                      ? "Mask painted."
                      : "Paint the area to change.",
                )}
              </figcaption>
            </figure>
          )}
          {custom ? (
            <div className="flex gap-2">
              <Button
                className="flex-1"
                variant="secondary"
                disabled={busy || !paint?.painted}
                onClick={() => void render()}
              >
                {tr(rendering ? "Rendering view…" : base ? "Render again" : "Render this angle")}
              </Button>
              {base && mask && (
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                  {tr("Adjust in 2D")}
                </Button>
              )}
            </div>
          ) : (
            <Button
              className="w-full"
              variant="secondary"
              disabled={busy}
              onClick={() => (base ? setEditing(true) : void render())}
            >
              {tr(
                rendering
                  ? "Rendering view…"
                  : base
                    ? mask
                      ? "Edit mask"
                      : "Paint mask"
                    : "Render view and paint mask",
              )}
            </Button>
          )}
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("What to paint")}</span>
            <Textarea
              rows={3}
              value={instruction}
              disabled={busy}
              placeholder={tr("For example: a silver skull-shaped lock with a dark keyhole")}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Mask edge")}</span>
            <OptionSelect
              label={tr("Mask edge")}
              value={String(feather)}
              disabled={busy}
              onValueChange={(value) => setFeather(Number(value))}
            >
              {FEATHERS.map(([value, label]) => (
                <option key={value} value={String(value)}>
                  {tr(label)}
                </option>
              ))}
            </OptionSelect>
          </label>
          {providers.data && !enabled.length ? (
            <p role="status" className="text-ui-xs text-muted-foreground">
              {tr("No drawing channel is configured. Add a channel in Drawing to repaint.")}
            </p>
          ) : (
            current && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui-xs text-muted-foreground">{tr("Channel and model")}</span>
                <DrawingModelPicker
                  providers={enabled}
                  providerId={current.providerId}
                  model={current.model}
                  onChange={(providerId, model) => setChoice({ providerId, model })}
                  onSettings={() => void navigate({ to: "/drawing", search: {} })}
                />
              </div>
            )
          )}
          <Button
            className="w-full"
            disabled={busy || !current || !base || !mask || !instruction.trim()}
            onClick={() => void start()}
          >
            {tr(generating ? "Repainting…" : failure ? "Try again" : "Repaint")}
          </Button>
          {generating && (
            <p role="status" aria-live="polite" className="text-ui-xs">
              {tr("Generating… this usually takes under a minute.")}
            </p>
          )}
          {failure && (
            <p role="alert" className="break-words text-ui-xs text-destructive">
              {failure}
            </p>
          )}
          {blenderMissing && (
            <p className="text-ui-xs text-destructive">
              {tr("Optimization needs Blender. Set it up in the 3D workshop.")}
            </p>
          )}
          <p className="rounded-md bg-muted/40 p-3 text-ui-xs leading-relaxed text-muted-foreground">
            {tr(
              "Creates one edit of this view with your drawing channel; it is recorded in Drawing and may be billed. Only masked surfaces this view can see change, everything else keeps the source texture exactly, and the result is a new version.",
            )}
          </p>
        </>
      )}
      {editing && base && (
        <MaskCanvasEditor
          mode="mask"
          base={base}
          mask={mask}
          onClose={() => setEditing(false)}
          onSave={async (blob) => {
            try {
              setMask(await uploadDrawingImage(blob, `gen3d-mask-${view}.png`));
              if (custom) renderedMask.current = paint?.maskRevision ?? -1;
            } catch (error) {
              onError(error);
              throw error;
            }
          }}
        />
      )}
    </section>
  );
}

const noSubscribe = () => () => {},
  zero = () => 0;

/** Brush, eraser, size, undo and clear for the mask painted in the 3D viewer. */
function PaintControls({ paint, disabled }: { paint: Gen3DPaintSession; disabled: boolean }) {
  const tr = useAhaTranslation();
  const centimetres = paint.radiusMetres * 100;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-1">
        {(
          [
            [false, "Brush (B)", <PencilIcon key="b" />],
            [true, "Eraser (E)", <EraserIcon key="e" />],
          ] as const
        ).map(([erase, label, icon]) => (
          <Button
            key={label}
            size="icon-sm"
            variant={paint.erase === erase ? "secondary" : "ghost"}
            aria-label={tr(label)}
            aria-pressed={paint.erase === erase}
            title={tr(label)}
            disabled={disabled}
            onClick={() => paint.setBrush({ erase })}
          >
            {icon}
          </Button>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={tr("Undo stroke")}
          title={tr("Undo stroke (Cmd/Ctrl+Z in the viewer)")}
          disabled={disabled || !paint.canUndo}
          onClick={() => paint.undo()}
        >
          <Undo2Icon />
        </Button>
        <Button
          className="ms-auto"
          size="sm"
          variant="ghost"
          disabled={disabled || !paint.painted}
          onClick={() => paint.clear()}
        >
          {tr("Clear")}
        </Button>
      </div>
      <div className="space-y-1.5">
        <span className="flex justify-between text-ui-xs text-muted-foreground">
          <span>{tr("Brush size")}</span>
          <span className="tabular-nums">
            {centimetres
              ? `${centimetres < 10 ? centimetres.toFixed(1) : Math.round(centimetres)} cm`
              : ""}
          </span>
        </span>
        <Slider
          aria-label={tr("Brush size")}
          value={Math.round(Math.log(paint.radius / BRUSH_MIN) * 100)}
          min={0}
          max={Math.round(Math.log(BRUSH_MAX / BRUSH_MIN) * 100)}
          disabled={disabled}
          onValueChange={(value) => paint.setBrush({ radius: BRUSH_MIN * Math.exp(value / 100) })}
        />
      </div>
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {tr(
          paint.painted
            ? "Turn the model so the painted area faces you, then render this angle. Only surfaces the angle can see change."
            : "Drag on the model in the viewer to paint the area to change. Alt-drag erases, right-drag orbits, [ and ] change the size.",
        )}
      </p>
    </div>
  );
}
