import {
  DEFAULT_SKIN_PALETTE,
  SkinPaletteSchema,
  type SkinPalette,
} from "@synara/contracts/ahaSkins";

const colors = (surface: string, ink: string, accent: string) => ({
  surface,
  ink,
  accent,
  contrast: 0,
  semanticColors: { diffAdded: "#35A56C", diffRemoved: "#D95A66", skill: accent },
});
export const BUILTIN_PALETTES: Record<string, SkinPalette> = {
  "synara-default": DEFAULT_SKIN_PALETTE,
  "aha-elation": {
    dark: colors("#1B151E", "#EEE8F0", "#D56B88"),
    light: colors("#FAF3F5", "#2B2028", "#A92D50"),
  },
  "furina-chanson": {
    dark: colors("#0B172A", "#EAF2FC", "#68B9F0"),
    light: colors("#F3F8FD", "#162740", "#216CC7"),
  },
};
// Old packages can contain whole native themes; extract colors only, never typography/material.
export function paletteFromPreview(preview: {
  nativeTheme: string | null;
  legacyTheme?: {
    dark: { palette: { background: string; foreground: string; accent: string } };
    light: { palette: { background: string; foreground: string; accent: string } };
  };
}): SkinPalette {
  if (preview.nativeTheme) {
    const raw = JSON.parse(preview.nativeTheme);
    const native = raw.chromeThemes;
    return SkinPaletteSchema.parse(
      Object.fromEntries(
        ["dark", "light"].map((mode) => {
          const theme = native?.[mode] ?? raw[mode]?.theme;
          if (!theme) throw new Error("主题包缺少深浅配色 / Theme colors are missing.");
          return [
            mode,
            {
              ...colors(theme.surface, theme.ink, theme.accent),
              contrast: theme.contrast ?? 0,
              semanticColors:
                theme.semanticColors ??
                colors(theme.surface, theme.ink, theme.accent).semanticColors,
            },
          ];
        }),
      ),
    );
  }
  if (!preview.legacyTheme) throw new Error("主题包缺少配色 / Theme colors are missing.");
  return SkinPaletteSchema.parse(
    Object.fromEntries(
      ["dark", "light"].map((mode) => {
        const palette = preview.legacyTheme![mode as "dark" | "light"].palette;
        return [mode, colors(palette.background, palette.foreground, palette.accent)];
      }),
    ),
  );
}
