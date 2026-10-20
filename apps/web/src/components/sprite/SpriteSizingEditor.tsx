import {
  DEFAULT_SPRITE_SIZING,
  spritePlanTasks,
  type SpritePlanConfiguration,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { DrawingSizePicker } from "../drawing/DrawingSizePicker";
import { SpriteSelect } from "./SpriteSelect";
import { SpriteNumberField } from "./SpriteNumberField";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
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
  const patch = (value: Partial<NonNullable<typeof s>>) => {
    const sizing = { ...(s ?? { ...DEFAULT_SPRITE_SIZING, mode: "manual" as const }), ...value };
    onChange({
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
              sizing: DEFAULT_SPRITE_SIZING,
              layout: undefined,
              sizeSource: "recommended",
            })
          }
        >
          {tr("Adopt recommended layout")}
        </Button>
      )}
      <SpriteSelect
        label={tr("Image sizing mode")}
        value={s?.mode ?? (c.sizeSource === "auto" ? "model" : "manual")}
        options={[
          { value: "linked", label: tr("Follow frame size and count") },
          { value: "manual", label: tr("Specify whole image size") },
          { value: "model", label: tr("Let model decide image size") },
        ]}
        onChange={(mode) => patch({ mode })}
      />
      {s?.mode !== "linked" && (
        <DrawingSizePicker
          exact
          value={s?.mode === "model" ? "auto" : c.parameters.size}
          onChange={(size) =>
            onChange({
              sizing: {
                ...(s ?? DEFAULT_SPRITE_SIZING),
                mode: !size || size === "auto" ? "model" : "manual",
              },
              sizeSource: !size || size === "auto" ? "auto" : "user",
              parameters: { ...c.parameters, size },
              layout: undefined,
            })
          }
        />
      )}
      <details>
        <summary className="cursor-pointer text-ui-sm">{tr("Layout parameters")}</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <SpriteSelect
            label={tr("Source sampling")}
            value={String(s?.sourceScale ?? 1)}
            options={[
              { value: "1", label: "1×" },
              { value: "2", label: "2×" },
            ]}
            onChange={(value) => patch({ sourceScale: value === "2" ? 2 : 1 })}
          />
          <SpriteSelect
            label={tr("Arrangement")}
            value={s?.arrangement ?? "auto"}
            options={[
              { value: "auto", label: tr("Automatic") },
              { value: "fixed", label: tr("Fixed rows and columns") },
            ]}
            onChange={(arrangement) =>
              patch({
                arrangement,
                columns: tasks[0]?.layout?.columns ?? 4,
                rows: tasks[0]?.layout?.rows ?? 2,
              })
            }
          />
          {s?.arrangement === "fixed" && (
            <>
              <SpriteNumberField
                label={tr("Columns")}
                value={s.columns ?? 4}
                max={32}
                onChange={(columns) => patch({ columns })}
              />
              <SpriteNumberField
                label={tr("Rows")}
                value={s.rows ?? 2}
                max={32}
                onChange={(rows) => patch({ rows })}
              />
            </>
          )}
          <SpriteNumberField
            label={tr("Margin")}
            min={0}
            value={s?.margin ?? 0}
            onChange={(margin) => patch({ margin })}
          />
          <SpriteNumberField
            label={tr("Spacing")}
            min={0}
            value={s?.gap ?? 0}
            onChange={(gap) => patch({ gap })}
          />
        </div>
      </details>
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {tr(error)}
        </p>
      )}
      {tasks.map((task) => {
        const l = task.layout;
        if (!l) return null;
        const cell = l.cells[0]!;
        return (
          <div
            key={`${task.segment?.actionId ?? "legacy"}:${task.segment?.frameStart ?? 0}`}
            className="space-y-2 border-t pt-2 text-ui-sm"
          >
            <p>
              {task.actions[0]?.name} · {tr("Frames")} {(task.segment?.frameStart ?? 0) + 1}–
              {(task.segment?.frameStart ?? 0) + (task.segment?.frameCount ?? 1)} · {l.width}×
              {l.height} · {l.columns}×{l.rows}
            </p>
            <svg
              className="max-h-28 w-full text-muted-foreground"
              viewBox={`0 0 ${l.width} ${l.height}`}
              role="img"
              aria-label={tr("Layout preview")}
            >
              {l.cells.map((g) => (
                <rect
                  key={g.id ?? `${g.actionId}:${g.frameIndex ?? `${g.x}:${g.y}`}`}
                  x={g.x}
                  y={g.y}
                  width={g.width}
                  height={g.height}
                  fill={g.actionId ? "var(--color-accent)" : "none"}
                  stroke="currentColor"
                  strokeWidth={Math.max(1, l.width / 300)}
                />
              ))}
            </svg>
            <p className="text-muted-foreground">
              {tr("Source cell")}: {cell.width}×{cell.height} → {c.width}×{c.height} ·{" "}
              {tr("Empty slots")}: {l.cells.filter((g) => !g.actionId).length} ·{" "}
              {tr("External whitespace")}: {cell.x}/{cell.y}px
            </p>
          </div>
        );
      })}
      <p className="text-ui-sm text-muted-foreground">
        {tr("Image requests")}: {tasks.length} · {tr("Cost unknown")}
      </p>
    </div>
  );
}
