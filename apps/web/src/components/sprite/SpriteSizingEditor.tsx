import {
  DEFAULT_SPRITE_SIZING,
  SPRITE_GIF_SEGMENT_FRAMES,
  spritePlanTasks,
  type SpritePlanConfiguration,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { DrawingSizePicker } from "../drawing/DrawingSizePicker";
import { SpriteSelect } from "./SpriteSelect";
import { SpriteNumberField } from "./SpriteNumberField";
import { useAhaTranslation } from "~/aha/AppearanceProvider";

/** Actions are generated as GIFs; sizes here are per GIF frame. */
export function SpriteSizingEditor({
  configuration: c,
  onChange,
}: {
  configuration: SpritePlanConfiguration;
  onChange: (patch: Partial<SpritePlanConfiguration>) => void;
}) {
  const tr = useAhaTranslation(),
    s = c.sizing;
  let tasks: SpritePlanConfiguration[] = [],
    error = "";
  try {
    tasks = spritePlanTasks(c);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const generation = c.generation ?? { version: 1 as const };
  const patch = (value: Partial<NonNullable<typeof s>>) => {
    const sizing = { ...(s ?? DEFAULT_SPRITE_SIZING), ...value };
    onChange({
      generation,
      sizing,
      layout: undefined,
      sizeSource:
        sizing.mode === "linked" ? "recommended" : sizing.mode === "model" ? "auto" : "user",
    });
  };
  return (
    <div className="space-y-3" data-testid="sprite-sizing-editor">
      <p className="text-ui-sm">
        {tr("Output frame size")}: {c.width}×{c.height} ·{" "}
        {tr("Output size follows project settings")}
      </p>
      {!s && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              generation,
              sizing: DEFAULT_SPRITE_SIZING,
              layout: undefined,
              sizeSource: "recommended",
            })
          }
        >
          {tr("Adopt recommended frame size")}
        </Button>
      )}
      <SpriteSelect
        label={tr("GIF frame size")}
        value={s?.mode ?? (c.sizeSource === "auto" ? "model" : "linked")}
        options={[
          { value: "linked", label: tr("Follow output frame size") },
          { value: "manual", label: tr("Specify frame size") },
          { value: "model", label: tr("Let model decide frame size") },
        ]}
        onChange={(mode) => patch({ mode })}
      />
      {s?.mode === "manual" && (
        <DrawingSizePicker
          exact
          animated={{ frameCount: tasks[0]?.segment?.frameCount ?? 8 }}
          value={c.parameters.size}
          onChange={(size) =>
            onChange({
              generation,
              sizing: { ...s, mode: !size || size === "auto" ? "model" : "manual" },
              sizeSource: !size || size === "auto" ? "auto" : "user",
              parameters: { ...c.parameters, size },
              layout: undefined,
            })
          }
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        {s?.mode !== "manual" && (
          <SpriteSelect
            label={tr("Source sampling")}
            value={String(s?.sourceScale ?? DEFAULT_SPRITE_SIZING.sourceScale)}
            options={[
              { value: "1", label: "1×" },
              { value: "2", label: "2×" },
            ]}
            onChange={(value) => patch({ sourceScale: value === "2" ? 2 : 1 })}
          />
        )}
        <SpriteNumberField
          label={tr("Frames per request")}
          min={2}
          max={64}
          value={generation.segmentFrames ?? SPRITE_GIF_SEGMENT_FRAMES}
          onChange={(segmentFrames) =>
            onChange({ generation: { ...generation, segmentFrames }, layout: undefined })
          }
        />
      </div>
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {tr(error)}
        </p>
      )}
      {tasks.map((task) => {
        const cell = task.layout?.cells[0];
        if (!cell || !task.segment) return null;
        return (
          <p
            key={`${task.segment.actionId}:${task.segment.frameStart}`}
            className="border-t pt-2 text-ui-sm"
          >
            {task.actions[0]?.name} · {tr("Frames")} {task.segment.frameStart + 1}–
            {task.segment.frameStart + task.segment.frameCount} · {task.segment.frameCount}×{" "}
            {task.parameters.size === "auto" ? tr("Auto") : `${cell.width}×${cell.height}`} ·{" "}
            {tr("Per frame")} {task.parameters.frameDurationMs}ms
            <span className="block text-muted-foreground">
              {tr("Source frame")}: {cell.width}×{cell.height} → {c.width}×{c.height} ·{" "}
              {tr("Combined")} ≈
              {((task.segment.frameCount * cell.width * cell.height) / 1_000_000).toFixed(1)}MP
            </span>
          </p>
        );
      })}
      <p className="text-ui-sm text-muted-foreground">
        {tr("Image requests")}: {tasks.length} · {tr("Cost unknown")}
      </p>
    </div>
  );
}
