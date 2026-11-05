import { useEffect, useMemo, useState } from "react";
import {
  GEN3D_PROP_MOTIONS,
  type Gen3DCommand,
  type Gen3DCommandResult,
  type Gen3DPropAnimation,
  type Gen3DVersion,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { OptionSelect } from "../ui/option-select";

type Motion = (typeof GEN3D_PROP_MOTIONS)[number];
export const MOTION_LABELS: Record<Motion, string> = {
  lid: "Lid on a hinge",
  door: "Door on a hinge",
  spin: "Spin",
  slide: "Slide",
};
const EDGE_LABELS = {
  back: "Back edge",
  front: "Front edge",
  left: "Left edge",
  right: "Right edge",
};
const DIRECTION_LABELS = { forward: "Forward", up: "Up", left: "Left", right: "Right" };

/** Moves chosen parts of a version: a lid or door on a hinge, a spin or a slide. */
export function PropAnimationPanel({
  version,
  disabled,
  act,
  chosen,
  onChosenChange,
}: {
  version: Gen3DVersion;
  disabled: boolean;
  /** Shared with the viewer: clicking parts there chooses them here. */
  chosen: string[];
  onChosenChange: (parts: string[]) => void;
  act: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<Gen3DCommandResult | null>;
}) {
  const tr = useAhaTranslation();
  const parts = version.report.objects;
  const setChosen = (next: string[] | ((current: string[]) => string[])) =>
    onChosenChange(typeof next === "function" ? next(chosen) : next);
  const [filter, setFilter] = useState(""),
    [motion, setMotion] = useState<Motion>("lid"),
    [edge, setEdge] = useState<"back" | "front" | "left" | "right">("back"),
    [angle, setAngle] = useState("100"),
    [direction, setDirection] = useState<"forward" | "up" | "left" | "right">("forward"),
    [distance, setDistance] = useState(""),
    [seconds, setSeconds] = useState("1");
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return parts.filter((p) => !query || `${p.name} ${p.id}`.toLowerCase().includes(query));
  }, [parts, filter]);
  const meshes = parts.filter((p) => p.kind !== "group").length;
  if (meshes < 2)
    return (
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {tr(
          "This version is one mesh. Animate the modeled version, or optimize it with “Keep parts separate” first.",
        )}
      </p>
    );
  const number = (value: string, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const hinge = motion === "lid" || motion === "door";
  const values = {
    angle: hinge ? number(angle, 5, 180) : 0,
    seconds: number(seconds, 0.2, 10),
    distance: motion === "slide" && distance.trim() ? number(distance, 0.001, 100) : 0,
  };
  const valid =
    chosen.length > 0 &&
    chosen.length < parts.length &&
    values.angle !== null &&
    values.seconds !== null &&
    values.distance !== null;
  const doorEdge = edge === "left" || edge === "right" ? edge : "left";
  const animation = (): Gen3DPropAnimation => ({
    parts: chosen,
    motion,
    seconds: values.seconds!,
    ...(motion === "lid" ? { edge, angle: values.angle! } : {}),
    ...(motion === "door" ? { edge: doorEdge, angle: values.angle! } : {}),
    ...(motion === "slide"
      ? { direction, ...(values.distance ? { distance: values.distance } : {}) }
      : {}),
  });
  return (
    <section className="space-y-3" aria-label={tr("Prop animation")}>
      <div className="space-y-1.5">
        <span className="text-ui-xs text-muted-foreground">
          {tr("Moving parts")} · {tr("{n} chosen").replace("{n}", String(chosen.length))}
        </span>
        <Input
          aria-label={tr("Filter parts")}
          placeholder={tr("Filter parts, e.g. lid")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!shown.length}
            onClick={() =>
              setChosen((current) => [...new Set([...current, ...shown.map((p) => p.id)])])
            }
          >
            {tr("Choose shown")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!chosen.length} onClick={() => setChosen([])}>
            {tr("Clear")}
          </Button>
        </div>
        <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
          {shown.map((part) => (
            <label
              key={part.id}
              className="flex items-center gap-2 text-ui-xs"
              style={{ paddingInlineStart: `${(part.depth ?? 0) * 12}px` }}
            >
              <Checkbox
                checked={chosen.includes(part.id)}
                onCheckedChange={(value) =>
                  setChosen((current) =>
                    value === true ? [...current, part.id] : current.filter((id) => id !== part.id),
                  )
                }
              />
              {/* Ids are the stable part names; glTF node names can be generic (mesh_2). */}
              <span className="min-w-0 flex-1 truncate" title={part.name}>
                {part.id}
              </span>
              <span className="tabular-nums text-muted-foreground">{part.triangles}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="block space-y-1.5">
        <span className="text-ui-xs text-muted-foreground">{tr("Motion")}</span>
        <OptionSelect
          label={tr("Motion")}
          value={motion}
          onValueChange={(value) => setMotion(value as Motion)}
        >
          {GEN3D_PROP_MOTIONS.map((key) => (
            <option key={key} value={key}>
              {tr(MOTION_LABELS[key])}
            </option>
          ))}
        </OptionSelect>
      </label>
      {hinge && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Hinge")}</span>
            <OptionSelect
              label={tr("Hinge")}
              value={motion === "door" ? doorEdge : edge}
              onValueChange={(value) => setEdge(value as typeof edge)}
            >
              {(motion === "door"
                ? (["left", "right"] as const)
                : (["back", "front", "left", "right"] as const)
              ).map((key) => (
                <option key={key} value={key}>
                  {tr(EDGE_LABELS[key])}
                </option>
              ))}
            </OptionSelect>
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Opening angle (°)")}</span>
            <Input
              inputMode="decimal"
              aria-label={tr("Opening angle (°)")}
              value={angle}
              onChange={(event) => setAngle(event.target.value)}
            />
          </label>
        </div>
      )}
      {motion === "slide" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Direction")}</span>
            <OptionSelect
              label={tr("Direction")}
              value={direction}
              onValueChange={(value) => setDirection(value as typeof direction)}
            >
              {(Object.keys(DIRECTION_LABELS) as (keyof typeof DIRECTION_LABELS)[]).map((key) => (
                <option key={key} value={key}>
                  {tr(DIRECTION_LABELS[key])}
                </option>
              ))}
            </OptionSelect>
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Distance (m)")}</span>
            <Input
              inputMode="decimal"
              aria-label={tr("Distance (m)")}
              placeholder={tr("Automatic")}
              value={distance}
              onChange={(event) => setDistance(event.target.value)}
            />
          </label>
        </div>
      )}
      <label className="block space-y-1.5">
        <span className="text-ui-xs text-muted-foreground">{tr("Duration (s)")}</span>
        <Input
          inputMode="decimal"
          aria-label={tr("Duration (s)")}
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
        />
      </label>
      {chosen.length >= parts.length && (
        <p className="text-ui-xs text-destructive">
          {tr("Choose the moving parts only; at least one part has to stay still.")}
        </p>
      )}
      <Button
        className="w-full"
        disabled={disabled || !valid}
        onClick={() =>
          void act({ operation: "animate", versionId: version.id, animate: animation() })
        }
      >
        {tr("Create animated version")}
      </Button>
      <p className="rounded-md bg-muted/40 p-3 text-ui-xs leading-relaxed text-muted-foreground">
        {tr(
          "The chosen parts turn or move around a pivot on their combined bounds. Lids, doors and slides get open and close clips; a spin loops. Children of a chosen group move with it.",
        )}
      </p>
    </section>
  );
}
