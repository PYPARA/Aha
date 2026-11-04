import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Gen3DCommand, Gen3DCommandResult, Gen3DProject, ImageJob } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OptionSelect } from "../ui/option-select";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { drawingApi, useImageProviders } from "../drawing/useDrawing";
import { gen3dAssetUrl } from "./useGen3D";

export interface TileChoice {
  textureId: string | null;
  metres: string;
  roughness: number;
}
type Act = (
  input: Omit<Gen3DCommand, "projectId" | "revision">,
) => Promise<Gen3DCommandResult | null>;
const tilePrompt = (subject: string) =>
  `Seamless tileable texture of ${subject}. A flat, top-down, orthographic surface sample that fills the entire square frame edge to edge and repeats seamlessly on all four edges. Even, diffuse, shadowless lighting with no highlights or vignetting; uniform scale and density across the image; no objects, borders, perspective, text or watermark.`;
export const validTileSize = (metres: string) => {
  const value = Number(metres);
  return Number.isFinite(value) && value >= 0.02 && value <= 20;
};

/** Texture, repeat size and roughness for one material that uses a tiled texture. */
export function TiledTextureField({
  project,
  label,
  value,
  disabled,
  act,
  onChange,
}: {
  project: Gen3DProject;
  label: string;
  value: TileChoice;
  disabled: boolean;
  act: Act;
  onChange: (value: TileChoice) => void;
}) {
  const tr = useAhaTranslation();
  const [generating, setGenerating] = useState(false);
  const textures = project.textures ?? [];
  return (
    <div className="ms-5 space-y-2 border-s border-border ps-3">
      <div className="flex items-center gap-2">
        {value.textureId && (
          <img
            src={gen3dAssetUrl(project.id, "textures", value.textureId)}
            alt=""
            className="size-9 shrink-0 rounded-sm border border-border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <OptionSelect
            label={`${tr("Tiled texture")}: ${label}`}
            value={value.textureId ?? ""}
            disabled={disabled}
            onValueChange={(textureId) => onChange({ ...value, textureId: textureId || null })}
          >
            <option value="">{tr("Choose a texture")}</option>
            {textures.map((texture) => (
              <option key={texture.id} value={texture.id}>
                {texture.prompt || texture.name}
              </option>
            ))}
          </OptionSelect>
        </div>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setGenerating(true)}>
          {tr("Generate…")}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-ui-xs">
        <span className="text-muted-foreground">{tr("Repeat every (m)")}</span>
        <Input
          className="w-24"
          inputMode="decimal"
          aria-label={`${tr("Repeat every (m)")}: ${label}`}
          value={value.metres}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, metres: event.target.value })}
        />
      </label>
      {!validTileSize(value.metres) && (
        <p className="text-ui-xs text-destructive">{tr("Use 0.02 to 20 metres.")}</p>
      )}
      {generating && (
        <TextureDialog
          act={act}
          onClose={() => setGenerating(false)}
          onCreated={(textureId) => {
            onChange({ ...value, textureId });
            setGenerating(false);
          }}
        />
      )}
    </div>
  );
}

/** Generates one tileable texture with the drawing channel and keeps it in the project. */
function TextureDialog({
  act,
  onClose,
  onCreated,
}: {
  act: Act;
  onClose: () => void;
  onCreated: (textureId: string) => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    providers = useImageProviders();
  const enabled = providers.data?.filter((p) => p.enabled && p.models.length) ?? [];
  const [subject, setSubject] = useState(""),
    [choice, setChoice] = useState<{ providerId: string; model: string } | null>(null),
    [job, setJob] = useState<ImageJob | null>(null),
    [failure, setFailure] = useState<string | null>(null);
  const current =
    choice ?? (enabled[0] ? { providerId: enabled[0].id, model: enabled[0].models[0]!.id } : null);
  useEffect(() => {
    if (!job || ["succeeded", "partial", "failed", "cancelled", "interrupted"].includes(job.status))
      return;
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
    if (!job) return;
    if (["failed", "cancelled", "interrupted"].includes(job.status)) {
      setFailure(
        (typeof job.error === "string" ? job.error : job.error?.message) ??
          tr("Image generation failed."),
      );
      return;
    }
    const asset = job.outputs[0];
    if (!asset || !["succeeded", "partial"].includes(job.status)) return;
    void (async () => {
      const result = await act({
        operation: "import-texture-asset",
        imageAssetId: asset.id,
        imageJobId: job.id,
        instruction: subject.trim(),
      });
      const texture = result?.project?.textures?.findLast((t) => t.imageJobId === job.id);
      if (texture) onCreated(texture.id);
      else setFailure(tr("The texture could not be imported."));
    })();
    // The import runs once per finished job.
  }, [job?.status]);
  const generating = !!job && !failure && !["succeeded", "partial"].includes(job.status);
  const start = async () => {
    if (!current) return;
    setFailure(null);
    try {
      setJob(
        await drawingApi().createJob({
          clientRequestId: crypto.randomUUID(),
          providerId: current.providerId,
          model: current.model,
          prompt: tilePrompt(subject.trim()),
          parameters: { n: 1, size: "1024x1024", quality: "high", outputFormat: "png" },
          inputAssetIds: [],
          inputReferences: [],
          maskAssetId: null,
          sourceJobId: null,
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !generating && onClose()}>
      <DialogPopup showCloseButton={!generating}>
        <DialogHeader className="pe-10">
          <DialogTitle>{tr("Generate a tiled texture")}</DialogTitle>
          <DialogDescription>
            {tr(
              "Creates one 1024×1024 texture with your drawing channel; it is recorded in Drawing and may be billed. Aha blends its edges so it repeats without seams.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 pt-2 text-ui-sm">
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Surface to draw")}</span>
            <Textarea
              rows={3}
              value={subject}
              disabled={generating}
              placeholder={tr("For example: weathered dark oak planks with visible grain")}
              onChange={(event) => setSubject(event.target.value)}
            />
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
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={generating} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!current || !subject.trim() || generating} onClick={() => void start()}>
            {tr(failure ? "Try again" : "Generate")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
