import type { SkinDefinition } from "@synara/contracts/ahaSkins";
import { REGIONS } from "@synara/contracts/ahaLegacyAppearance";

/** Refresh bundled references, preserving user images and every saved adjustment. */
export function refreshBuiltinDefinition(
  previous: SkinDefinition,
  adjusted: SkinDefinition,
  current: SkinDefinition,
): SkinDefinition {
  const next = structuredClone(adjusted);
  for (const region of REGIONS) {
    if (next.backgrounds[region].imageId === previous.backgrounds[region].imageId)
      next.backgrounds[region].imageId = current.backgrounds[region].imageId;
  }
  if (next.iconId === previous.iconId) next.iconId = current.iconId;
  return next;
}
