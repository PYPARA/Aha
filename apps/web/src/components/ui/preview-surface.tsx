import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";
/** Opaque neutral board keeps transparent assets independent of the active background skin. */
export function PreviewSurface({
  className,
  style,
  checker = true,
  ...props
}: ComponentProps<"div"> & { checker?: boolean }) {
  return (
    <div
      {...props}
      className={cn("flex items-center justify-center overflow-hidden rounded-md", className)}
      style={{
        backgroundColor: "var(--color-background-elevated-primary-opaque)",
        backgroundImage: checker
          ? "conic-gradient(color-mix(in srgb, var(--color-text-foreground) 5%, transparent) 25%, transparent 0 50%, color-mix(in srgb, var(--color-text-foreground) 5%, transparent) 0 75%, transparent 0)"
          : undefined,
        backgroundSize: "16px 16px",
        ...style,
      }}
    />
  );
}
