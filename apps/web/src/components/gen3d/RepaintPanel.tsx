import { useEffect, useState } from "react";
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
import { Button } from "../ui/button";
import { OptionSelect } from "../ui/option-select";
import { Textarea } from "../ui/textarea";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { MaskCanvasEditor } from "../drawing/MaskCanvasEditor";
import { drawingApi, imageUrl, uploadDrawingImage, useImageProviders } from "../drawing/useDrawing";

export const REPAINT_VIEW_LABELS: Record<Gen3DRepaintView, string> = {
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
const repaintPrompt = (instruction: string) =>
  `Edit only the masked (transparent) area of this image. The image is an orthographic render of a 3D game asset and will be used as its texture. Change: ${instruction}. Keep the object's silhouette, outlines, camera, scale and everything outside the masked area unchanged. Paint surface colour and detail only, as a texture would look: the same soft even lighting as the rest of the object, no new cast shadows or highlights, no perspective change, no background change, no text.`;

/** Local repaint: render a view of a baked version, paint a mask, edit it with the drawing
 * channel and project the edit back onto the texture as a new version. */
export function RepaintPanel({
  version,
  disabled,
  blenderMissing,
  act,
  onError,
}: {
  version: Gen3DVersion | undefined;
  disabled: boolean;
  blenderMissing: boolean;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    providers = useImageProviders();
  const enabled = providers.data?.filter((p) => p.enabled && p.models.length) ?? [];
  const [view, setView] = useState<Gen3DRepaintView>("front"),
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
  // A render and mask belong to one version and view; switching either starts over.
  useEffect(() => {
    setBase(null);
    setMask(null);
    setJob(null);
    setFailure(null);
  }, [version?.id, view]);
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
          prompt: repaintPrompt(instruction.trim()),
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
              {GEN3D_REPAINT_VIEWS.map((key) => (
                <option key={key} value={key}>
                  {tr(REPAINT_VIEW_LABELS[key])}
                </option>
              ))}
            </OptionSelect>
          </label>
          {base && (
            <figure className="space-y-1">
              <img
                src={imageUrl(base, "thumbnail")}
                alt={tr(REPAINT_VIEW_LABELS[view])}
                className="aspect-square w-full rounded-md border border-border bg-muted/40 object-contain"
              />
              <figcaption className="text-ui-xs text-muted-foreground">
                {tr(mask ? "Mask painted." : "Paint the area to change.")}
              </figcaption>
            </figure>
          )}
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
