import { drawingParameterLabel } from "./drawingParameters";
import { CentralIcon } from "~/lib/central-icons";
import { useState, type ReactNode } from "react";
import type { ImageGenerationParameters, ImageProvider } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { PlusIcon } from "~/lib/icons";
import { Button } from "../ui/button";
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
  options: readonly { value: string; label: string; note?: string }[];
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

export function DrawingParameters({
  parameters: p,
  onChange,
}: {
  parameters: ImageGenerationParameters;
  onChange: (patch: Partial<ImageGenerationParameters>) => void;
}) {
  const tr = useAhaTranslation();
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
      <SizePicker value={p.size} onChange={(size) => onChange({ size })} />
      <ParameterPicker
        label={tr("Quality")}
        value={p.quality ?? "auto"}
        options={options(["auto", "low", "medium", "high", "xhigh", "max"])}
        onChange={(v) => onChange({ quality: v as ImageGenerationParameters["quality"] })}
      >
        <p className="max-w-64 px-3 py-2 text-ui-xs text-muted-foreground">
          {tr(
            "Extra high and Maximum are supported by GPT Image 2.5 Sunburst / Flare. Other models depend on provider support.",
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
        options={["png", "jpeg", "webp"].map((value) => ({
          value,
          label: value === "webp" ? "WebP" : value.toUpperCase(),
        }))}
        onChange={(v) => onChange({ outputFormat: v as ImageGenerationParameters["outputFormat"] })}
      />
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
