// FILE: ahaBrand.ts
// Purpose: Aha product identity applied to upstream-authored interface copy.
// Layer: Shared (web renderer, desktop main and packaging)

import type { UiLanguagePreference } from "@synara/contracts/uiLocale";

export const PRODUCT_DISPLAY_NAME = "Aha";

/** Public home of the Aha project (share links, OAuth client metadata). */
export const PRODUCT_HOMEPAGE_URL = "https://github.com/PYPARA/Aha";

/** Upstream release this build is merged from; update together with UPSTREAM.md. */
export const UPSTREAM_BASELINE = "Synara v1.1.0 / b6aa37bc";

/** Aha ships Simplified Chinese by default; "system" stays an explicit opt-in. */
export const AHA_DEFAULT_LANGUAGE_PREFERENCE: UiLanguagePreference = "zh-CN";

/**
 * Upstream catalogs name the product literally. Only catalog output passes through
 * here — user, model and tool content never does, so a thread titled "Synara" stays.
 */
export function applyAhaBrand(text: string): string {
  return text.includes("Synara") ? text.replaceAll("Synara", PRODUCT_DISPLAY_NAME) : text;
}
