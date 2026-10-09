import { it, expect } from "vitest";
import { DEFAULT_THEME_STATE, parseStoredThemeState } from "../theme/theme.logic";
import { skinPaletteFromTheme, themeWithSkinPalette } from "./skin-colors";
import { DEFAULT_SKIN_PALETTE } from "@synara/contracts/ahaSkins";
it("keeps the unskinned built-in palette identical to the original theme defaults", () => {
  expect(DEFAULT_SKIN_PALETTE).toEqual(skinPaletteFromTheme(DEFAULT_THEME_STATE));
});
it("changes colors while preserving fonts, code highlighting, mode and window material", () => {
  const state = structuredClone(DEFAULT_THEME_STATE);
  state.mode = "light";
  state.chromeThemes.dark.fonts.ui = "Custom";
  state.chromeThemes.light.opaqueWindows = true;
  const palette = skinPaletteFromTheme(state);
  palette.dark.accent = "#69BBDD";
  palette.light.surface = "#F1F7FE";
  const result = parseStoredThemeState(themeWithSkinPalette(state, palette));
  expect(result.mode).toBe(state.mode);
  expect(result.translucency).toEqual(state.translucency);
  expect(result.systemUiFont).toBe(state.systemUiFont);
  expect(result.codeThemeIds).toEqual(state.codeThemeIds);
  expect(result.chromeThemes.dark.fonts).toEqual(state.chromeThemes.dark.fonts);
  expect(result.chromeThemes.light.opaqueWindows).toBe(true);
  expect(result.chromeThemes.dark.accent).toBe("#69bbdd");
  expect(result.chromeThemes.light.surface).toBe("#f1f7fe");
});
