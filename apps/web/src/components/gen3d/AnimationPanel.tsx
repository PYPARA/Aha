import { useEffect, useState } from "react";
import {
  GEN3D_ANIMATION_CLIPS,
  type Gen3DCommand,
  type Gen3DCommandResult,
  type Gen3DProject,
  type Gen3DVersion,
} from "@synara/contracts";
import { skeletonSource } from "@synara/shared/gen3dVersions";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { gen3dAssetUrl } from "./useGen3D";

type Clip = (typeof GEN3D_ANIMATION_CLIPS)[number];
export const CLIP_LABELS: Record<Clip, string> = {
  idle: "Idle",
  walk: "Walk",
  run: "Run",
  attack: "Attack",
};
export const RIG_KIND_LABELS = {
  biped: "Biped",
  quadruped: "Quadruped",
  generic: "Generic skeleton",
} as const;

/** Rigs a version from the skeleton saved with its modeling build and previews the clips. */
export function AnimationPanel({
  project,
  version,
  disabled,
  blenderMissing,
  act,
}: {
  project: Gen3DProject;
  version: Gen3DVersion | undefined;
  disabled: boolean;
  blenderMissing: boolean;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
}) {
  const tr = useAhaTranslation();
  const [clips, setClips] = useState<Clip[]>([...GEN3D_ANIMATION_CLIPS]);
  const source = version && skeletonSource(project.versions, version);
  const rig = version?.process?.rig;
  const animated = !!rig && version.files.some((f) => f.name === "rigged.glb");
  useEffect(() => setClips([...GEN3D_ANIMATION_CLIPS]), [version?.id]);
  const toggle = (clip: Clip, on: boolean) =>
    setClips((current) =>
      GEN3D_ANIMATION_CLIPS.filter((c) => (c === clip ? on : current.includes(c))),
    );
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-ui-sm">
      <h2 className="font-medium">{tr("Rig and animation")}</h2>
      {!version ? (
        <p className="text-muted-foreground">{tr("Build a version first.")}</p>
      ) : (
        <>
          {animated && rig && (
            <section className="space-y-2" aria-label={tr("Animation clips")}>
              <p>
                {tr(RIG_KIND_LABELS[rig.kind])} ·{" "}
                {tr("{n} bones").replace("{n}", String(rig.bones))}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {rig.clips.map((clip) => (
                  <figure key={clip.name} className="space-y-1">
                    <img
                      src={gen3dAssetUrl(
                        project.id,
                        "versions",
                        version.id,
                        `anim-${clip.name}.webp`,
                      )}
                      alt={tr(CLIP_LABELS[clip.name])}
                      className="aspect-square w-full rounded-md border border-border bg-muted/40 object-contain"
                    />
                    <figcaption className="text-ui-xs text-muted-foreground">
                      {tr(CLIP_LABELS[clip.name])} · {clip.seconds} s
                      {clip.loop ? ` · ${tr("Loop")}` : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
              <p className="text-ui-xs leading-relaxed text-muted-foreground">
                {tr(
                  "Previews are rendered by Blender. glTF and FBX files carry no loop flag, so turn on looping for loop clips in your engine.",
                )}
              </p>
            </section>
          )}
          <p>
            {tr("Source version")}: <strong>{version.name}</strong>
          </p>
          {!source ? (
            <p className="text-ui-xs leading-relaxed text-muted-foreground">
              {tr(
                "Rigging uses the skeleton saved with a modeling build. Ask the AI assistant to build with a skeleton (characters, creatures, tails), then rig that version or an optimized one made from it.",
              )}
            </p>
          ) : (
            <>
              <p className="text-ui-xs text-muted-foreground">
                {tr("Skeleton from {name}, {n} joints.")
                  .replace("{name}", source.name)
                  .replace("{n}", String(source.build.skeleton!.length))}
              </p>
              <fieldset className="space-y-2">
                <legend className="mb-1 text-ui-xs text-muted-foreground">
                  {tr("Animation clips")}
                </legend>
                {GEN3D_ANIMATION_CLIPS.map((clip) => (
                  <label key={clip} className="flex items-center gap-2 text-ui-xs">
                    <Checkbox
                      checked={clips.includes(clip)}
                      onCheckedChange={(value) => toggle(clip, value === true)}
                    />
                    {tr(CLIP_LABELS[clip])}
                  </label>
                ))}
              </fieldset>
              <Button
                className="w-full"
                disabled={disabled || !clips.length}
                onClick={() => void act({ operation: "rig", versionId: version.id, clips })}
              >
                {tr("Create rigged version")}
              </Button>
              {blenderMissing && (
                <p className="text-ui-xs text-destructive">
                  {tr("Rigging needs Blender. Set it up in the 3D workshop.")}
                </p>
              )}
              <p className="rounded-md bg-muted/40 p-3 text-ui-xs leading-relaxed text-muted-foreground">
                {tr(
                  "Runs Aha's fixed script in background Blender: bones from the skeleton, automatic weights, then procedural clips. Bipeds and quadrupeds are detected from joint names; other skeletons get an idle sway only. Rig an optimized version for game use; LODs are not rigged.",
                )}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
