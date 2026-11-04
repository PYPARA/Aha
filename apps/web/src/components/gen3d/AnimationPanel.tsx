import { useEffect, useState } from "react";
import {
  GEN3D_ANIMATION_CLIPS,
  type Gen3DCommand,
  type Gen3DCommandResult,
  type Gen3DProject,
  type Gen3DVersion,
} from "@synara/contracts";
import { rigSkeleton } from "@synara/shared/gen3dVersions";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { MOTION_LABELS, PropAnimationPanel } from "./PropAnimationPanel";
import { SkeletonEditor } from "./SkeletonEditor";
import { templateSkeleton, type Dimensions } from "./skeletonJoints";
import { gen3dAssetUrl } from "./useGen3D";

type Clip = (typeof GEN3D_ANIMATION_CLIPS)[number];
export const CLIP_LABELS: Record<Clip | "open" | "close" | "spin", string> = {
  idle: "Idle",
  walk: "Walk",
  run: "Run",
  attack: "Attack",
  open: "Open",
  close: "Close",
  spin: "Spin",
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
  onAskAssistant,
}: {
  project: Gen3DProject;
  version: Gen3DVersion | undefined;
  disabled: boolean;
  blenderMissing: boolean;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
  onAskAssistant: (prompt: string) => void;
}) {
  const tr = useAhaTranslation();
  const [clips, setClips] = useState<Clip[]>([...GEN3D_ANIMATION_CLIPS]),
    [editing, setEditing] = useState(false);
  // Joints from the version's history, including proposals that still wait for confirmation.
  const joints = version && rigSkeleton(project, version, true);
  const confirmed = !!joints && (joints.origin === "build" || joints.attached?.confirmed === true);
  useEffect(() => setEditing(false), [version?.id]);
  const ORIGIN_STATUS: Record<string, string> = {
    ai: "Proposed by the AI assistant from the renders. Drag the joints onto the body, then confirm.",
    template: "A template scaled to the model. Drag each joint onto the body, then confirm.",
  };
  const rig = version?.process?.rig,
    props = version?.process?.props;
  const animated =
    !!(rig || props) &&
    !!version?.files.some((f) => f.name === "rigged.glb" || f.name === "animated.glb");
  const shownClips = rig?.clips ?? props?.clips ?? [];
  useEffect(() => setClips([...GEN3D_ANIMATION_CLIPS]), [version?.id]);
  const template = (kind: "biped" | "quadruped") =>
    version &&
    void act({
      operation: "set-skeleton",
      versionId: version.id,
      skeleton: templateSkeleton(kind, version.report.dimensions as unknown as Dimensions),
      confirmed: false,
      skeletonOrigin: "template",
    });
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
          {animated && (
            <section className="space-y-2" aria-label={tr("Animation clips")}>
              <p>
                {rig
                  ? `${tr(RIG_KIND_LABELS[rig.kind])} · ${tr("{n} bones").replace("{n}", String(rig.bones))}`
                  : `${tr(MOTION_LABELS[props!.motion])} · ${tr("{n} parts").replace("{n}", String(props!.parts))}`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {shownClips.map((clip) => (
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
          {!joints ? (
            <section className="space-y-2" aria-label={tr("Joints")}>
              <p className="text-ui-xs leading-relaxed text-muted-foreground">
                {tr(
                  "This version has no joints yet. Start from a template and drag the joints onto the body, or ask the AI assistant to place them from the renders.",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => template("biped")}
                >
                  {tr("Biped template")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => template("quadruped")}
                >
                  {tr("Quadruped template")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    onAskAssistant(
                      tr(
                        "Propose joints for rigging version {name}: look at its front and side renders and call the gen3d skeleton operation. Do not rebuild the model.",
                      ).replace("{name}", version.name),
                    )
                  }
                >
                  {tr("Ask the AI assistant")}
                </Button>
              </div>
            </section>
          ) : !confirmed || editing ? (
            <SkeletonEditor
              project={project}
              version={joints.version}
              initial={joints.nodes as never}
              status={tr(
                ORIGIN_STATUS[joints.origin] ?? "Drag the joints to adjust them, then confirm.",
              )}
              disabled={disabled}
              onConfirm={(nodes) =>
                void act({
                  operation: "set-skeleton",
                  versionId: joints.version.id,
                  skeleton: nodes,
                  confirmed: true,
                }).then((result) => result && setEditing(false))
              }
              onDiscard={() =>
                joints.attached
                  ? void act({
                      operation: "set-skeleton",
                      versionId: joints.version.id,
                      skeleton: [],
                    })
                  : setEditing(false)
              }
            />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
                  {tr("Joints from {name}, {n} joints.")
                    .replace("{name}", joints.version.name)
                    .replace("{n}", String(joints.nodes.length))}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setEditing(true)}
                >
                  {tr("Edit joints")}
                </Button>
              </div>
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
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="font-medium">{tr("Prop animation")}</h3>
            <PropAnimationPanel version={version} disabled={disabled} act={act} />
          </section>
        </>
      )}
    </div>
  );
}
