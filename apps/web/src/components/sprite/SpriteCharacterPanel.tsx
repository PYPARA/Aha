import { createPortal } from "react-dom";
import { SpriteSelect } from "./SpriteSelect";
import { Input } from "../ui/input";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SPRITE_RENDER_SPEC,
  spriteOutputSize,
  type SpriteRenderSpec,
  type SpriteState,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { drawingApi, imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { decodeSpriteSource, suggestChromaKey } from "./spriteFiles";
import { spriteContext, type SpriteProject, type SpriteSource } from "./spriteModel";
import { decodeSpriteImages, spriteImageInput } from "./spriteImageInput";
import { SpriteNumberField } from "./SpriteNumberField";

export function SpriteCharacterPanel({
  project,
  state,
  onChange,
  onState,
  onDone,
  onGenerate,
  inspectorHost,
  fieldResetKey,
  onImportSheet,
}: {
  inspectorHost?: HTMLElement | null | undefined;
  fieldResetKey?: boolean;
  onImportSheet?: (() => void) | undefined;
  project: SpriteProject;
  state: SpriteState;
  onChange: (fn: (p: SpriteProject) => SpriteProject) => void;
  onState: (state: SpriteState) => void;
  onDone: () => void;
  onGenerate: () => void;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const tr = useAhaTranslation(),
    input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(
    () =>
      project.sources.find((s) => s.assetId === project.canonical?.source.id)?.id ??
      project.referenceSourceId ??
      "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [registration, setRegistration] = useState(
    project.canonical?.registration ?? { scale: 1, offsetX: 0, offsetY: 0 },
  );
  const source = project.sources.find((s) => s.id === selected),
    spec = project.renderSpec ?? DEFAULT_SPRITE_RENDER_SPEC;
  const externalSource = project.sources.find((s) => s.id === project.referenceSourceId);
  const originalSource = project.sources.find((s) => s.assetId === project.canonical?.source.id);
  const externalSelection = project.referenceSourceId
    ? externalSource?.assetId === project.canonical?.asset.id
      ? (originalSource?.id ?? project.referenceSourceId)
      : project.referenceSourceId
    : undefined;
  useEffect(() => {
    if (externalSelection) setSelected(externalSelection);
  }, [externalSelection]);
  const [sourceUrl, setSourceUrl] = useState("");
  useEffect(() => {
    if (!source) {
      setSourceUrl("");
      return;
    }
    const url = URL.createObjectURL(source.blob);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source]);
  const preview = state.characterPreview;
  const matching =
    preview &&
    preview.source.id === source?.assetId &&
    JSON.stringify(preview.renderSpec) === JSON.stringify(spec) &&
    JSON.stringify(preview.registration) === JSON.stringify(registration) &&
    preview.background === project.background &&
    preview.chromaKey === project.chromaKey;
  const changeSpec = (next: SpriteRenderSpec) => {
    const size = spriteOutputSize(next);
    onChange((p) => ({
      ...p,
      version: 2,
      renderSpec: next,
      ...size,
      canonical:
        p.canonical &&
        p.canonical.renderSpec.mode === next.mode &&
        p.canonical.renderSpec.logicalWidth === next.logicalWidth &&
        p.canonical.renderSpec.logicalHeight === next.logicalHeight
          ? p.canonical
          : undefined,
    }));
  };
  const perform = async (operation: "preview-character" | "confirm-character") => {
    if (!source) return;
    const retainedBytes = preview
      ? preview.asset.bytes + (preview.generationReference?.bytes ?? 0)
      : 0;
    if (
      operation === "confirm-character" &&
      project.sources.reduce((n, s) => n + s.blob.size, 0) + retainedBytes > 80 * 1024 * 1024
    ) {
      setError("Project archive exceeds 80 MiB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const asset =
        state.characterPreview && source.assetId === state.characterPreview.source.id
          ? state.characterPreview.source
          : state.canonical &&
              project.canonical?.revision === state.canonical.revision &&
              source.assetId === state.canonical.source.id
            ? state.canonical.source
            : await uploadDrawingImage(source.blob, source.name);
      onChange((p) => ({
        ...p,
        sources: p.sources.map((s) => (s.id === source.id ? { ...s, assetId: asset.id } : s)),
      }));
      const next = await drawingApi().spriteCommand({
        operation,
        projectId: project.id,
        context: spriteContext({
          ...project,
          version: 2,
          renderSpec: spec,
          ...spriteOutputSize(spec),
        }),
        renderSpec: spec,
        registration,
        references: [
          {
            referenceId: `project:${asset.id}`,
            asset,
            role: "character",
            actionId: null,
            source: "project",
          },
        ],
      });
      onState(next);
      if (operation === "confirm-character" && next.canonical) {
        const response = await fetch(imageUrl(next.canonical.asset), { credentials: "include" });
        if (!response.ok) throw new Error("Could not download character reference.");
        const normalized = {
          ...(await decodeSpriteSource(await response.blob(), "character-reference.png")),
          assetId: next.canonical.asset.id,
          usage: "material" as const,
        };
        const appearance = next.canonical.generationReference;
        const retained: SpriteSource[] = [normalized];
        if (appearance && !project.sources.some((s) => s.assetId === appearance.id)) {
          const full = await fetch(imageUrl(appearance), { credentials: "include" });
          if (!full.ok) throw new Error("Could not download character reference.");
          retained.push({
            ...(await decodeSpriteSource(await full.blob(), appearance.name)),
            assetId: appearance.id,
            usage: "generated-master",
          });
        }
        if (
          project.sources.reduce((n, s) => n + s.blob.size, 0) +
            retained.reduce((n, s) => n + s.blob.size, 0) >
          80 * 1024 * 1024
        )
          throw new Error("Project archive exceeds 80 MiB.");
        const chromaKey = await suggestChromaKey(normalized.blob);
        onChange((p) => ({
          ...p,
          version: 2,
          renderSpec: spec,
          ...spriteOutputSize(spec),
          canonical: next.canonical,
          canonicalVersions: [
            ...(p.canonicalVersions ?? (p.canonical ? [p.canonical] : [])),
            next.canonical!,
          ],
          chromaKey,
          sources: [...p.sources, ...retained],
          referenceSourceId: normalized.id,
        }));
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const approvedPreview = matching
    ? preview
    : project.canonical &&
        (source?.assetId === project.canonical.source.id ||
          source?.assetId === project.canonical.asset.id)
      ? project.canonical
      : null;
  const controls = (
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
      <h3 className="font-medium">{tr("Character settings")}</h3>
      <SpriteSelect
        label={tr("Character source")}
        value={selected}
        options={[
          { value: "", label: tr("Choose existing image") },
          ...project.sources
            .filter((s) => s.usage !== "generated-master" && s.usage !== "generated-frame")
            .map((s) => ({ value: s.id, label: s.name })),
        ]}
        onChange={setSelected}
      />
      <SpriteSelect
        label={tr("Rendering mode")}
        value={spec.mode}
        options={[
          { value: "pixel", label: tr("Pixel art") },
          { value: "illustration", label: tr("Illustration") },
        ]}
        onChange={(mode) =>
          changeSpec(
            mode === "pixel"
              ? { ...DEFAULT_SPRITE_RENDER_SPEC }
              : { mode, logicalWidth: 256, logicalHeight: 256, outputScale: 1 },
          )
        }
      />
      <div className="grid grid-cols-2 gap-3">
        <SpriteNumberField
          label={tr(spec.mode === "pixel" ? "Logical width" : "Action frame width")}
          value={spec.logicalWidth}
          max={Math.floor(4096 / spec.outputScale)}
          resetKey={fieldResetKey}
          onChange={(logicalWidth) => changeSpec({ ...spec, logicalWidth })}
        />
        <SpriteNumberField
          label={tr(spec.mode === "pixel" ? "Logical height" : "Action frame height")}
          value={spec.logicalHeight}
          max={Math.floor(4096 / spec.outputScale)}
          resetKey={fieldResetKey}
          onChange={(logicalHeight) => changeSpec({ ...spec, logicalHeight })}
        />
      </div>
      {spec.mode === "pixel" && (
        <SpriteNumberField
          label={tr("Output scale")}
          value={spec.outputScale}
          max={Math.floor(4096 / Math.max(spec.logicalWidth, spec.logicalHeight))}
          resetKey={fieldResetKey}
          onChange={(outputScale) => changeSpec({ ...spec, outputScale })}
        />
      )}
      <p className="text-ui-sm text-muted-foreground">
        {tr("Output frame")}: {spec.logicalWidth * spec.outputScale} ×{" "}
        {spec.logicalHeight * spec.outputScale}
      </p>
      <SpriteSelect
        label={tr("Generated background")}
        value={project.background}
        options={[
          { value: "transparent", label: tr("Transparent") },
          { value: "chroma", label: tr("Chroma background") },
        ]}
        onChange={(background) => onChange((p) => ({ ...p, background }))}
      />
      {project.background === "chroma" && (
        <label className="flex flex-col gap-2 text-ui-sm">
          {tr("Chroma key")}
          <Input
            type="color"
            aria-label={tr("Chroma key")}
            value={project.chromaKey}
            onChange={(e) => onChange((p) => ({ ...p, chromaKey: e.target.value }))}
          />
        </label>
      )}
      <div className="border-t pt-4 space-y-4">
        <h3 className="font-medium">{tr("Reference alignment")}</h3>
        <SpriteNumberField
          label={tr("Character scale percent")}
          value={Math.round(registration.scale * 100)}
          min={1}
          max={1600}
          onChange={(scale) => setRegistration((r) => ({ ...r, scale: scale / 100 }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <SpriteNumberField
            label={tr("Offset X")}
            value={registration.offsetX}
            min={-4096}
            onChange={(offsetX) => setRegistration((r) => ({ ...r, offsetX }))}
          />
          <SpriteNumberField
            label={tr("Ground offset")}
            value={registration.offsetY}
            min={-4096}
            onChange={(offsetY) => setRegistration((r) => ({ ...r, offsetY }))}
          />
        </div>
      </div>
      {project.canonical && (
        <p className="text-ui-sm text-muted-foreground">
          {tr(
            "An approved reference is saved. Confirming changes creates a new version and preserves existing actions.",
          )}
        </p>
      )}
      {!!project.canonicalVersions?.length && (
        <details className="border-t pt-4 text-ui-sm">
          <summary>
            {tr("Character reference history")} · {project.canonicalVersions.length}
          </summary>
          {project.canonicalVersions.toReversed().map((v) => (
            <div
              key={v.revision}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span>{new Date(v.confirmedAt).toLocaleString()}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const s =
                    project.sources.find((s) => s.assetId === v.source.id) ||
                    project.sources.find((s) => s.assetId === v.asset.id);
                  if (s) {
                    setSelected(s.id);
                    changeSpec(v.renderSpec);
                    setRegistration(
                      s.assetId === v.source.id
                        ? v.registration
                        : { scale: 1, offsetX: 0, offsetY: 0 },
                    );
                  }
                }}
              >
                {tr("Use as reference")}
              </Button>
            </div>
          ))}
        </details>
      )}
    </fieldset>
  );
  return (
    <section
      data-sprite-character
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      {...spriteImageInput((files) => void addFiles(files))}
    >
      <div className="sb-work-header">
        <div>
          <h2 className="font-medium">{tr("Character reference")}</h2>
          <p className="text-ui-sm text-muted-foreground">
            {tr(
              "Approve one character before generating its actions. All actions reuse this reference, scale and ground coordinate.",
            )}
          </p>
        </div>
      </div>
      <div className="sb-toolbar">
        <Button
          size="sm"
          variant={!showOriginal ? "secondary" : "ghost"}
          onClick={() => setShowOriginal(false)}
        >
          {tr("Processed reference")}
        </Button>
        <Button
          size="sm"
          variant={showOriginal ? "secondary" : "ghost"}
          onClick={() => setShowOriginal(true)}
        >
          {tr("Original reference")}
        </Button>
        <span className="ml-auto text-ui-sm text-muted-foreground">
          {tr("Action frame")}: {spec.logicalWidth} × {spec.logicalHeight}
        </span>
      </div>
      <div className="sb-character-stage sb-checker">
        {(
          showOriginal ? sourceUrl : approvedPreview ? imageUrl(approvedPreview.asset) : sourceUrl
        ) ? (
          <div
            className="relative flex max-h-full max-w-full items-center justify-center"
            style={{
              aspectRatio: approvedPreview
                ? `${approvedPreview.asset.width}/${approvedPreview.asset.height}`
                : source
                  ? `${source.width}/${source.height}`
                  : "1",
              height: "100%",
            }}
          >
            <img
              src={
                showOriginal
                  ? sourceUrl
                  : approvedPreview
                    ? imageUrl(approvedPreview.asset)
                    : sourceUrl
              }
              alt={showOriginal ? tr("Original reference") : tr("Processed reference")}
              className="max-h-full max-w-full object-contain"
              style={{
                imageRendering: spec.mode === "pixel" ? "pixelated" : "auto",
                width: Math.min(512, project.width),
              }}
            />
            {!showOriginal && approvedPreview && (
              <span
                aria-label={tr("Ground line")}
                className="absolute inset-x-0 border-t border-dashed border-warning"
                style={{
                  top: `${(approvedPreview.pivotY / approvedPreview.renderSpec.logicalHeight) * 100}%`,
                }}
              />
            )}
          </div>
        ) : (
          <div className="space-y-4 text-center">
            <p>{tr("Upload or generate a character to begin.")}</p>
            <p className="text-ui-sm text-muted-foreground">{tr("Drop or paste images here")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
                {tr("Upload character")}
              </Button>
              <Button disabled={busy} onClick={onGenerate}>
                {tr("Generate character")}
              </Button>
              {onImportSheet && (
                <Button variant="ghost" onClick={onImportSheet}>
                  {tr("Import sprite sheet")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {!inspectorHost && <div className="p-4">{controls}</div>}
      {inspectorHost && createPortal(controls, inspectorHost)}
      {error && (
        <p role="alert" className="px-4 py-2 text-ui text-destructive">
          {tr(error)}
        </p>
      )}
      <div className="sb-work-footer">
        <span className="mr-auto text-ui-sm text-muted-foreground">
          {tr("Local processing · no image generation")}
        </span>
        <Button variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
          {tr("Upload character")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !source}
          onClick={() => void perform("preview-character")}
        >
          {tr("Preview reference")}
        </Button>
        <Button disabled={busy || !matching} onClick={() => void perform("confirm-character")}>
          {tr(busy ? "Processing…" : "Confirm character reference")}
        </Button>
      </div>
      <input
        ref={input}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          if (e.target.files) void addFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </section>
  );
  async function addFiles(files: File[]) {
    setBusy(true);
    setError("");
    try {
      const { sources, errors } = await decodeSpriteImages(files);
      if (
        project.sources.reduce((n, s) => n + s.blob.size, 0) +
          sources.reduce((n, s) => n + s.blob.size, 0) >
        80 * 1024 * 1024
      )
        throw new Error("Project archive exceeds 80 MiB.");
      onChange((p) => ({
        ...p,
        sources: [...p.sources, ...sources.map((s) => ({ ...s, usage: "material" as const }))],
      }));
      if (sources[0]) setSelected(sources[0].id);
      setError(errors.join("\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
}
