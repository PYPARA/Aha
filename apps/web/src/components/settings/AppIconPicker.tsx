// FILE: AppIconPicker.tsx
// Purpose: Render the visual desktop app-icon choices used by Appearance settings.
// Layer: Settings UI component

import { useState } from "react";

import type { DesktopAppIcon } from "@synara/contracts";
import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export function desktopAppIconsForPlatform(
  platform: string,
  flavor: SynaraDesktopFlavor | "unknown" = "unknown",
): ReadonlyArray<DesktopAppIcon> {
  void platform;
  void flavor;
  return ["default"];
}

export function AppIconPicker({
  platform,
  value,
  onValueChange,
}: {
  readonly platform: string;
  readonly value: DesktopAppIcon;
  readonly onValueChange: (value: DesktopAppIcon) => void | Promise<void>;
}) {
  const [pendingIcon, setPendingIcon] = useState<DesktopAppIcon | null>(null);
  const tr = useAhaTranslation();
  const busy = pendingIcon !== null;

  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={tr("App icon")}
      aria-busy={busy}
    >
      {desktopAppIconsForPlatform(platform).map((icon) => {
        const label = tr("Aha · Xuzhao · Elation");
        // Saved upstream tokens are compatibility aliases for the single Aha artwork.
        const selected = value === icon || value === "icon" || value === "dark" || value === "beta";
        const applying = pendingIcon === icon;
        return (
          <button
            key={icon}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={selected}
            disabled={busy}
            className={cn(
              // Same selection language as ThemeModePicker: the artwork is the whole
              // control, so no filled tile — just a stroke that appears when selected.
              "relative grid place-items-center rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none",
              selected || applying
                ? "border-foreground"
                : "border-transparent hover:border-foreground/25",
            )}
            onClick={() => {
              if (busy) return;
              setPendingIcon(icon);
              void (async () => {
                try {
                  await onValueChange(icon);
                } catch {
                  // Native preference synchronization owns rollback. The picker
                  // only owns its transient loading state.
                } finally {
                  setPendingIcon((current) => (current === icon ? null : current));
                }
              })();
            }}
          >
            <img
              src="/aha-logo.png"
              alt=""
              draggable={false}
              className={cn("size-10 object-contain", applying && "opacity-40")}
            />
            {applying ? (
              <Spinner
                aria-label={tr("Updating app icon")}
                className="absolute size-4 text-foreground motion-reduce:animate-none"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
