import { expect, it } from "vitest";
import { defaultBackgrounds } from "@synara/contracts/ahaLegacyAppearance";
import type { SkinDefinition } from "@synara/contracts/ahaSkins";
import { refreshBuiltinDefinition } from "./skin-upgrade";
it("keeps custom and inherited icons, disabled images, opacity, crop and palette while refreshing matching bundled IDs", () => {
  const previous: SkinDefinition = {
    backgrounds: defaultBackgrounds(),
    palette: null,
    iconId: "a".repeat(64),
  };
  for (const background of Object.values(previous.backgrounds)) background.imageId = "b".repeat(64);
  const current = structuredClone(previous);
  current.iconId = "c".repeat(64);
  for (const background of Object.values(current.backgrounds)) background.imageId = "d".repeat(64);
  const adjusted = structuredClone(previous);
  adjusted.backgrounds.window = {
    ...adjusted.backgrounds.window,
    opacity: 0,
    source: "solid",
    x: 70,
    blur: 12,
  };
  adjusted.backgrounds.sidebar.imageId = "e".repeat(64);
  const result = refreshBuiltinDefinition(previous, adjusted, current);
  expect(result.iconId).toBe(current.iconId);
  expect(result.backgrounds.window).toEqual({
    ...adjusted.backgrounds.window,
    imageId: "d".repeat(64),
  });
  expect(result.backgrounds.sidebar).toEqual(adjusted.backgrounds.sidebar);
  adjusted.iconId = "f".repeat(64);
  expect(refreshBuiltinDefinition(previous, adjusted, current).iconId).toBe(adjusted.iconId);
  adjusted.iconId = null;
  expect(refreshBuiltinDefinition(previous, adjusted, current).iconId).toBeNull();
  expect(previous.iconId).toBe("a".repeat(64));
});
