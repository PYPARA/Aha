// FILE: SynaraLogo.tsx
// Purpose: Render Aha artwork while preserving upstream logo call sites and geometry.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import ahaMark from "../../../../assets/aha/elation/icon.png";
import { cn } from "~/lib/utils";

export function SynaraLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"]?.replace("Synara", "Aha");

  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      aria-label={ariaLabel}
      className={cn("shrink-0 text-foreground", className)}
    >
      <image href={ahaMark} width="512" height="512" />
    </svg>
  );
}
