import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/** Nonmodal tools live in their owning workspace, below its header and navigation. */
export function WorkAreaPanel({
  title,
  active = true,
  closeLabel,
  onClose,
  children,
  side = "right",
  overlay = false,
  className,
  width,
  footer,
}: {
  active?: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  side?: "left" | "right";
  overlay?: boolean;
  className?: string;
  width?: number | string | undefined;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement;
    close.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [active, title]);
  return (
    <aside
      role="region"
      aria-labelledby={titleId}
      data-work-area-panel
      className={cn(
        "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-background",
        side === "left" ? "border-r" : "border-l",
        overlay && "absolute inset-y-0 z-20 shadow-lg",
        overlay && (side === "left" ? "left-0" : "right-0"),
        className,
      )}
      style={{ width: width ?? 320, maxWidth: "100%" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-ui font-medium">
          {title}
        </h2>
        <Button
          ref={close}
          size="icon-sm"
          variant="ghost"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {children}
      {footer && <div className="shrink-0 border-t p-3">{footer}</div>}
    </aside>
  );
}
