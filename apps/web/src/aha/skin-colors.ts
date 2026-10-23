import { SkinPaletteSchema, type SkinEntry, type SkinPalette } from "@synara/contracts/ahaSkins";
import { type ThemeState, serializeThemeState } from "../theme/theme.logic";
export function skinPaletteFromTheme(state: ThemeState): SkinPalette {
  return SkinPaletteSchema.parse(
    Object.fromEntries(
      (["dark", "light"] as const).map((mode) => {
        const { surface, ink, accent, contrast, semanticColors } = state.chromeThemes[mode];
        return [mode, { surface, ink, accent, contrast, semanticColors }];
      }),
    ),
  );
}
export function themeWithSkinPalette(state: ThemeState, palette: SkinPalette | null): string {
  const next = structuredClone(state);
  if (palette)
    for (const mode of ["dark", "light"] as const)
      next.chromeThemes[mode] = { ...next.chromeThemes[mode], ...palette[mode] };
  return serializeThemeState(next);
}
export function skinName(id: string, name: string, en: boolean) {
  if (!en) return name;
  if (id === "synara-default") return "Default style";
  if (id === "aha-elation") return "Xuzhao · Elation";
  if (id === "furina-chanson") return "Furina · Chanson of Many Waters";
  return name === "当前自定义外观" ? "Current custom appearance" : name;
}
// The default skin leads every skin list; the rest keep library order.
export function defaultSkinFirst(skins: readonly SkinEntry[]) {
  return skins.toSorted(
    (a, b) => Number(b.id === "synara-default") - Number(a.id === "synara-default"),
  );
}
