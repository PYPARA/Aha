import { useState } from "react";
import {
  GEN3D_STYLES,
  type Gen3DCommand,
  type Gen3DCommandResult,
  type Gen3DStyle,
  type Gen3DVersion,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OptionSelect } from "../ui/option-select";

export const STYLE_LABELS: Record<Gen3DStyle, string> = {
  voxel: "Voxels",
  bricks: "Bricks",
  lowpoly: "Low poly",
};
const STYLE_HELP: Record<Gen3DStyle, string> = {
  voxel:
    "Solid cubes coloured from the model's surface. Detail is the number of cubes along the longest side.",
  bricks:
    "Building bricks with studs on top and a fixed colour palette. Detail is the number of bricks along the longest side.",
  lowpoly:
    "Flat-shaded facets, one colour each, sampled from the model's surface. Detail is the target triangle count.",
};
const PRESETS: Record<Gen3DStyle, readonly number[]> = {
  voxel: [16, 32, 48, 64],
  bricks: [12, 20, 32],
  lowpoly: [200, 600, 1500],
};

/** Rebuilds the version in a fixed style; the result is a new version like any other. */
export function StylizePanel({
  version,
  disabled,
  blenderMissing,
  act,
}: {
  version: Gen3DVersion | undefined;
  disabled: boolean;
  blenderMissing: boolean;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
}) {
  const tr = useAhaTranslation();
  const [style, setStyle] = useState<Gen3DStyle>("voxel"),
    [detail, setDetail] = useState(String(GEN3D_STYLES.voxel.default));
  const range = GEN3D_STYLES[style],
    value = Number(detail),
    valid = Number.isInteger(value) && value >= range.min && value <= range.max;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-ui-sm">
      <h2 className="font-medium">{tr("Stylize")}</h2>
      {!version ? (
        <p className="text-muted-foreground">{tr("Build a version first.")}</p>
      ) : (
        <>
          <p>
            {tr("Source version")}: <strong>{version.name}</strong> ·{" "}
            {version.report.triangles.toLocaleString()} {tr("triangles")}
          </p>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Style")}</span>
            <OptionSelect
              label={tr("Style")}
              value={style}
              onValueChange={(next) => {
                setStyle(next as Gen3DStyle);
                setDetail(String(GEN3D_STYLES[next as Gen3DStyle].default));
              }}
            >
              {(Object.keys(GEN3D_STYLES) as Gen3DStyle[]).map((key) => (
                <option key={key} value={key}>
                  {tr(STYLE_LABELS[key])}
                </option>
              ))}
            </OptionSelect>
            <span className="block text-ui-xs leading-relaxed text-muted-foreground">
              {tr(STYLE_HELP[style])}
            </span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Detail")}</span>
            <OptionSelect
              label={tr("Detail")}
              value={PRESETS[style].includes(value) ? detail : "custom"}
              onValueChange={(next) => next !== "custom" && setDetail(next)}
            >
              {PRESETS[style].map((n) => (
                <option key={n} value={String(n)}>
                  {n.toLocaleString()}
                </option>
              ))}
              <option value="custom">{tr("Custom")}</option>
            </OptionSelect>
            <Input
              inputMode="numeric"
              aria-label={tr("Detail")}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </label>
          {!valid && (
            <p className="text-ui-xs text-destructive">
              {tr("Use {min} to {max}.")
                .replace("{min}", range.min.toLocaleString())
                .replace("{max}", range.max.toLocaleString())}
            </p>
          )}
          <Button
            className="w-full"
            disabled={disabled || !valid}
            onClick={() =>
              void act({
                operation: "stylize",
                versionId: version.id,
                stylize: { style, detail: value },
              })
            }
          >
            {tr("Create stylized version")}
          </Button>
          {blenderMissing && (
            <p className="text-ui-xs text-destructive">
              {tr("Stylizing needs Blender. Set it up in the 3D workshop.")}
            </p>
          )}
          <p className="rounded-md bg-muted/40 p-3 text-ui-xs leading-relaxed text-muted-foreground">
            {tr(
              "Runs Aha's fixed script in background Blender. Each face takes one colour from a small palette texture. Export the result directly, rig it if the source has a skeleton, or optimize it to bake a regular texture before repainting.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
