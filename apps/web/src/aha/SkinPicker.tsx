// FILE: SkinPicker.tsx
// Purpose: Skin library radio cards; each card previews the skin's window artwork, icon and colors.
// Layer: Aha appearance settings
// Exports: SkinPicker

import type { SkinEntry } from "@synara/contracts/ahaSkins";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";
import { skinName } from "./skin-colors";
import { useAhaImageUrl } from "./useAhaImageUrl";

function SkinThumbnail({
  entry,
  iconId,
  variant,
}: {
  entry: SkinEntry;
  iconId: string | null;
  variant: "dark" | "light";
}) {
  const windowBackground = entry.adjusted.backgrounds.window;
  const imageUrl = useAhaImageUrl(
    windowBackground.source === "image" ? windowBackground.imageId : null,
  );
  const iconUrl = useAhaImageUrl(iconId);
  // Swatches show the skin's own data, so they intentionally bypass theme tokens.
  const colors = entry.adjusted.palette?.[variant];
  return (
    <div
      aria-hidden
      className="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-muted"
      style={colors ? { backgroundColor: colors.surface } : undefined}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          style={{ objectPosition: `${windowBackground.x}% ${windowBackground.y}%` }}
        />
      )}
      <img
        src={iconUrl ?? "/aha-logo.png"}
        alt=""
        draggable={false}
        className="absolute bottom-1.5 left-1.5 size-7 object-contain drop-shadow-sm"
      />
      {colors && (
        <span className="absolute right-2 bottom-2 flex gap-1">
          {[colors.ink, colors.accent].map((color) => (
            <span
              key={color}
              className="size-2.5 rounded-full ring-1 ring-white/50"
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/** Radio group of skin cards. Choosing a card only previews it; the panel applies or cancels. */
export function SkinPicker({
  skins,
  selectedId,
  activeId,
  defaultIconId,
  variant,
  en,
  disabled,
  onSelect,
}: {
  skins: readonly SkinEntry[];
  selectedId: string;
  activeId: string;
  defaultIconId: string | null;
  variant: "dark" | "light";
  en: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const radioItemProps = useRadioGroupKeyboardNav({
    values: skins.map((entry) => entry.id),
    value: selectedId,
    onValueChange: onSelect,
  });
  return (
    <div
      role="radiogroup"
      aria-label="Skin library"
      aria-busy={disabled}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {skins.map((entry) => {
        const selected = entry.id === selectedId;
        const name = skinName(entry.id, entry.name, en);
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            disabled={disabled}
            className="group flex min-w-0 flex-col items-center gap-1.5 focus-visible:outline-none disabled:cursor-progress"
            onClick={() => onSelect(entry.id)}
            {...radioItemProps(entry.id)}
          >
            <div
              className={cn(
                "w-full rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
                "group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
                selected
                  ? "border-foreground"
                  : "border-transparent group-hover:border-foreground/25",
              )}
            >
              <SkinThumbnail
                entry={entry}
                iconId={entry.adjusted.iconId ?? defaultIconId}
                variant={variant}
              />
            </div>
            <span className="flex max-w-full items-center gap-1.5 text-ui leading-snug">
              <span
                className={cn(
                  "truncate transition-colors motion-reduce:transition-none",
                  selected ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {name}
              </span>
              {entry.id === activeId && (
                <span className="shrink-0 text-ui-sm text-muted-foreground">
                  {en ? "· In use" : "· 使用中"}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
