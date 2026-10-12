import { ResourceChatContext } from "../resources/resourceLibrary";
import { ResourceCollectButton, resourceContextMenu } from "../resources/ResourceCollectionDialog";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
// FILE: ExpandedImageOverlay.tsx
// Purpose: Shared fullscreen image preview overlay.
// Layer: Chat and composer UI component
// Exports: ExpandedImageOverlay

import { useContext, useLayoutEffect, useEffect, useRef, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "~/lib/icons";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageOverlayProps {
  readonly actions?: ReactNode;
  readonly imageOverlay?: ReactNode;
  readonly expandedImage: ExpandedImagePreview | null;
  readonly onClose: () => void;
  readonly onNavigate: (direction: -1 | 1) => void;
}

export function ExpandedImageOverlay({
  expandedImage,
  actions,
  imageOverlay,
  onClose,
  onNavigate,
}: ExpandedImageOverlayProps) {
  const tr = useAhaTranslation();
  const resourceThreadId = useContext(ResourceChatContext);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const open = Boolean(expandedImageItem);
  const dialogRef = useRef<HTMLDivElement>(null);
  const hasActions = Boolean(actions);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    notifyNativeSurfaceOcclusionChange();
    return notifyNativeSurfaceOcclusionChange;
  }, [open]);

  useEffect(() => {
    if (!open || !actions) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onNavigate(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onNavigate(1);
      }
      if (event.key === "Tab") {
        const buttons = [
          ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
            []),
        ];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, actions, onClose, onNavigate]);

  useEffect(() => {
    if (!open || !hasActions) return;
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, hasActions]);

  if (!expandedImage || !expandedImageItem) {
    return null;
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {expandedImage.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      ) : null}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <div className="relative w-fit">
          <img
            src={expandedImageItem.src}
            onContextMenu={(e) =>
              void resourceContextMenu(
                e,
                [
                  {
                    name: expandedImageItem.name,
                    url: expandedImageItem.src,
                    origin: expandedImageItem.resourceOrigin,
                  },
                ],
                tr,
                resourceThreadId,
              )
            }
            alt={expandedImageItem.name}
            className={`${actions ? "max-h-[78vh]" : "max-h-[86vh]"} max-w-[92vw] select-none rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] object-contain shadow-2xl`}
            draggable={false}
          />
          {imageOverlay}
        </div>
        <p className="mt-2 max-w-[92vw] truncate text-center text-ui leading-snug text-muted-foreground/80">
          {expandedImageItem.name}
          {expandedImage.images.length > 1
            ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
            : ""}
        </p>
        <ResourceCollectButton
          sources={[
            {
              name: expandedImageItem.name,
              url: expandedImageItem.src,
              origin: expandedImageItem.resourceOrigin,
            },
          ]}
        />
        {actions ? <div className="mt-3 rounded-xl bg-background p-2">{actions}</div> : null}
      </div>
      {expandedImage.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => onNavigate(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
