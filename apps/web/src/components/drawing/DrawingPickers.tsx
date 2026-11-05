import {
  drawingFormatLabel,
  drawingFrameCountOptions,
  drawingFrameDurationOptions,
  drawingParameterLabel,
  type DrawingParameterPatch,
} from "./drawingParameters";
import { CentralIcon } from "~/lib/central-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IMAGE_GIF_FRAME_COUNT,
  IMAGE_GIF_FRAME_DURATION_MS,
  type ImageGenerationParameters,
  type ImageProvider,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { PlusIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DrawingSizePicker as SizePicker } from "./DrawingSizePicker";
import {
  Menu,
  MenuTrigger,
  MenuItem,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
} from "../ui/menu";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { PickerPanelShell } from "../chat/PickerPanelShell";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../chat/ComposerPickerMenuPopup";

export function DrawingModelPicker({
  providers,
  providerId,
  model,
  onChange,
  onSettings,
}: {
  providers: readonly ImageProvider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  onSettings: () => void;
}) {
  const tr = useAhaTranslation();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const enabled = providers.filter((p) => p.enabled);
  const selected = enabled.find((p) => p.id === providerId);
  const search = query.trim().toLowerCase();
  const matches = enabled.flatMap((p) =>
    p.models
      .filter((m) => `${p.name} ${m.id}`.toLowerCase().includes(search))
      .map((m) => ({ provider: p, model: m })),
  );
  const choose = (id: string, value: string) => {
    onChange(id, value);
    setOpen(false);
  };
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      keepOpenOnSubmenuInteraction
    >
      <MenuTrigger
        render={
          <PickerTriggerButton
            icon={<CentralIcon name="images-sparkle" />}
            label={model || tr("Select model")}
            title={selected ? `${selected.name} · ${model}` : tr("Select model")}
            aria-label={tr("Image model")}
          />
        }
      />
      <ComposerPickerMenuPopup side="top" align="start" fixedWidth>
        <PickerPanelShell
          variant="plain"
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={tr("Search models or providers")}
          autoFocusSearch
          stopSearchKeyPropagation
          widthClassName="w-full"
          listMaxHeightClassName="max-h-[min(var(--available-height),24rem)]"
        >
          {search
            ? matches.map(({ provider: p, model: m }) => (
                <MenuItem key={`${p.id}:${m.id}`} onClick={() => choose(p.id, m.id)}>
                  <span className="min-w-0 flex-1 truncate">
                    {m.id}
                    <span className="block truncate text-ui-xs text-muted-foreground">
                      {p.name}
                    </span>
                  </span>
                  {providerId === p.id && model === m.id ? (
                    <span aria-label={tr("Selected")}>✓</span>
                  ) : null}
                </MenuItem>
              ))
            : enabled.map((p) => (
                <MenuSub key={p.id}>
                  <MenuSubTrigger className="w-full min-w-0">
                    <span className="min-w-0 flex-1 truncate" title={p.name}>
                      {p.name}
                    </span>
                    {providerId === p.id ? (
                      <span className="ml-auto text-muted-foreground">✓</span>
                    ) : null}
                  </MenuSubTrigger>
                  <ComposerPickerMenuSubPopup fixedWidth>
                    <MenuRadioGroup
                      value={providerId === p.id ? model : ""}
                      onValueChange={(value) => choose(p.id, value)}
                    >
                      {p.models.map((m) => (
                        <MenuRadioItem key={m.id} value={m.id} closeOnClick>
                          <span className="min-w-0 flex-1 truncate" title={m.id}>
                            {m.id}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </ComposerPickerMenuSubPopup>
                </MenuSub>
              ))}
          {search && enabled.length && !matches.length ? (
            <p className="p-3 text-ui-sm text-muted-foreground">{tr("No matching models")}</p>
          ) : null}
          {!enabled.length ? (
            <p className="p-3 text-ui-sm text-muted-foreground">
              {tr("Add an image provider to start drawing.")}
            </p>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={onSettings}>{tr("Image provider settings")}</MenuItem>
        </PickerPanelShell>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ParameterPicker({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; note?: string | undefined }[];
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  const display = options.find((option) => option.value === value)?.label ?? value;
  return (
    <Menu>
      <MenuTrigger
        render={
          <PickerTriggerButton
            className="max-w-none shrink-0 rounded-full px-2"
            icon={null}
            label={`${label} ${display}`}
            aria-label={`${label}: ${display}`}
          />
        }
      />
      <ComposerPickerMenuPopup side="top" align="start">
        <MenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
              {option.note ? (
                <span className="ml-auto pl-3 text-ui-xs text-muted-foreground">{option.note}</span>
              ) : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {children}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

const clampFrameValue = (
  text: string,
  fallback: number,
  range: { min: number; max: number; step: number },
) => {
  const parsed = Number(text);
  if (!text.trim() || !Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(parsed / range.step) * range.step));
};
/** Free entry beside the shortcut list: out-of-range values snap to the limit, empty input keeps the value. */
function FrameNumberField({
  label,
  unit,
  value,
  range,
  onCommit,
}: {
  label: string;
  unit?: string;
  value: number;
  range: { min: number; max: number; step: number };
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const latest = useRef({ text, value, range, onCommit });
  latest.current = { text, value, range, onCommit };
  useEffect(() => setText(String(value)), [value]);
  // Closing the menu unmounts the field without a blur; commit what was typed.
  useEffect(
    () => () => {
      const l = latest.current;
      const next = clampFrameValue(l.text, l.value, l.range);
      if (next !== l.value) l.onCommit(next);
    },
    [],
  );
  const commit = () => {
    const next = clampFrameValue(text, value, range);
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flex items-center gap-2 px-3 py-2 text-ui-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <Input
        nativeInput
        size="sm"
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={range.step}
        className="w-24"
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDownCapture={(e) => {
          if (e.key === "Tab" || e.key === "Escape") return;
          // Keep typing and arrow keys out of the menu's typeahead and navigation.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="shrink-0">
        {unit ?? ""} {range.min}–{range.max}
      </span>
    </label>
  );
}

export function DrawingParameters({
  parameters: p,
  onChange,
}: {
  parameters: ImageGenerationParameters;
  onChange: (patch: DrawingParameterPatch) => void;
}) {
  const tr = useAhaTranslation();
  const gif = p.outputFormat === "gif";
  const frameCount = p.frameCount ?? IMAGE_GIF_FRAME_COUNT.default;
  const frameDuration = p.frameDurationMs ?? IMAGE_GIF_FRAME_DURATION_MS.default;
  const options = (values: string[]) =>
    values.map((value) => ({
      value,
      label: drawingParameterLabel(value, tr),
      ...(["xhigh", "max"].includes(value) ? { note: tr("Requires model support") } : {}),
    }));
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5"
      aria-label={tr("Image parameters")}
    >
      <SizePicker
        value={p.size}
        animated={gif ? { frameCount } : undefined}
        onChange={(size) => onChange({ size })}
      />
      <ParameterPicker
        label={tr("Quality")}
        value={p.quality ?? "auto"}
        options={options(["auto", "low", "medium", "high", "xhigh", "max"])}
        onChange={(v) => onChange({ quality: v as ImageGenerationParameters["quality"] })}
      >
        <p className="max-w-64 px-3 py-2 text-ui-xs text-muted-foreground">
          {tr(
            "Extra high and Maximum are supported by GPT Image 2.5 and 2.6 Sunburst / Flare. Other models depend on provider support.",
          )}
        </p>
      </ParameterPicker>
      <ParameterPicker
        label={tr("Complexity")}
        value={p.complexity ?? "auto"}
        options={options(["auto", "low", "medium", "high"])}
        onChange={(v) =>
          onChange({
            complexity: v === "auto" ? undefined : (v as ImageGenerationParameters["complexity"]),
          })
        }
      >
        <p className="max-w-64 px-3 py-2 text-ui-xs text-muted-foreground">
          {tr(
            "Complexity sets how much the model plans before rendering. Auto is not sent; GPT Image 2.6 then uses High. Other models may not support it.",
          )}
        </p>
      </ParameterPicker>
      <ParameterPicker
        label={tr("Image count")}
        value={String(p.n)}
        options={Array.from({ length: 10 }, (_, i) => ({
          value: String(i + 1),
          label: String(i + 1),
        }))}
        onChange={(v) => onChange({ n: Number(v) })}
      />
      <ParameterPicker
        label={tr("Format")}
        value={p.outputFormat ?? "png"}
        options={(["png", "jpeg", "webp", "gif"] as const).map((value) => ({
          value,
          label: drawingFormatLabel(value)!,
          note: value === "gif" ? tr("Animated") : undefined,
        }))}
        onChange={(v) => onChange({ outputFormat: v as ImageGenerationParameters["outputFormat"] })}
      >
        {gif ? (
          <p className="max-w-64 px-3 py-2 text-ui-xs text-muted-foreground">
            {tr(
              "GIF animation requires model support, such as GPT Image 2.6. Size is per frame. Transparent GIF edges are fully opaque or fully clear. Some providers decide frames and timing themselves; task details show the actual result.",
            )}
          </p>
        ) : null}
      </ParameterPicker>
      {gif ? (
        <>
          <ParameterPicker
            label={tr("Frames")}
            value={String(frameCount)}
            options={drawingFrameCountOptions.map((count) => ({
              value: String(count),
              label: String(count),
              note:
                count > IMAGE_GIF_FRAME_COUNT.commonMax ? tr("Some providers allow 16") : undefined,
            }))}
            onChange={(v) => onChange({ frameCount: Number(v) })}
          >
            <FrameNumberField
              label={tr("Custom")}
              value={frameCount}
              range={{ min: IMAGE_GIF_FRAME_COUNT.min, max: IMAGE_GIF_FRAME_COUNT.max, step: 1 }}
              onCommit={(next) => onChange({ frameCount: next })}
            />
          </ParameterPicker>
          <ParameterPicker
            label={tr("Per frame")}
            value={String(frameDuration)}
            options={drawingFrameDurationOptions.map((ms) => ({
              value: String(ms),
              label: `${ms} ms`,
              note: `${Math.round((1000 / ms) * 10) / 10} fps`,
            }))}
            onChange={(v) => onChange({ frameDurationMs: Number(v) })}
          >
            <FrameNumberField
              label={tr("Custom")}
              unit="ms"
              value={frameDuration}
              range={IMAGE_GIF_FRAME_DURATION_MS}
              onCommit={(next) => onChange({ frameDurationMs: next })}
            />
            <p className="max-w-64 px-3 pb-2 text-ui-xs text-muted-foreground">
              {tr("One loop lasts")} {((frameCount * frameDuration) / 1000).toFixed(1)}{" "}
              {tr("seconds")}
            </p>
          </ParameterPicker>
        </>
      ) : null}
      <ParameterPicker
        label={tr("Background")}
        value={p.background ?? "auto"}
        options={options(["auto", "opaque", "transparent"])}
        onChange={(v) => onChange({ background: v as ImageGenerationParameters["background"] })}
      />
    </div>
  );
}

export function DrawingAddMenu({
  uploading,
  onUpload,
  onCanvas,
}: {
  uploading: boolean;
  onUpload: () => void;
  onCanvas: () => void;
}) {
  const tr = useAhaTranslation();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="chrome"
            size="icon-sm"
            disabled={uploading}
            aria-label={tr("Add reference or canvas")}
          >
            <PlusIcon />
          </Button>
        }
      />
      <ComposerPickerMenuPopup side="top" align="start">
        <MenuItem onClick={onUpload}>{tr("Reference images")}</MenuItem>
        <MenuItem onClick={onCanvas}>{tr("Blank canvas")}</MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
