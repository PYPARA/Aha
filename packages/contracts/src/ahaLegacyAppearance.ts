import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const PaletteSchema = z.strictObject({
  background: color,
  foreground: color,
  accent: color,
});
export const ProfileSchema = z.strictObject({
  palette: PaletteSchema,
  uiFont: z.literal("System"),
  contentFont: z.literal("Same as UI"),
  codeFont: z.literal("System"),
  uiWeight: z.enum(["400", "700"]),
  contentWeight: z.enum(["400", "700"]),
  codeWeight: z.enum(["400", "700"]),
});
export const REGIONS = ["window", "rail", "sidebar", "content", "composer"] as const;
export type BackgroundRegion = (typeof REGIONS)[number];
export const ResourceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const BackgroundSchema = z.strictObject({
  source: z.enum(["inherit", "image", "solid"]),
  imageId: ResourceIdSchema.nullable(),
  opacity: z.number().min(0).max(1),
  overlay: z.number().min(0).max(1),
  blur: z.number().min(0).max(24),
  fit: z.enum(["cover", "contain"]),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});
export type Background = z.infer<typeof BackgroundSchema>;
export const BackgroundsSchema = z.strictObject({
  window: BackgroundSchema,
  rail: BackgroundSchema,
  sidebar: BackgroundSchema,
  content: BackgroundSchema,
  composer: BackgroundSchema,
});
export type Backgrounds = z.infer<typeof BackgroundsSchema>;
export const defaultBackgrounds = (): Backgrounds =>
  Object.fromEntries(
    REGIONS.map((region) => [
      region,
      {
        source: region === "window" ? "solid" : "inherit",
        imageId: null,
        opacity: 0.6,
        overlay: 0.8,
        blur: 0,
        fit: "cover",
        x: 50,
        y: 50,
      },
    ]),
  ) as Backgrounds;
export const ThemeVisualSchema = z.strictObject({
  backgrounds: BackgroundsSchema,
  uiSize: z.number().int().min(12).max(20),
  codeSize: z.number().int().min(11).max(20),
  contrast: z.number().int().min(0).max(100),
});
export const ThemeSchema = z.strictObject({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  dark: ProfileSchema,
  light: ProfileSchema,
  visual: ThemeVisualSchema.optional(),
});
export const LegacyPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.enum(["system", "light", "dark"]),
  themeId: z.string().min(1).max(80),
  themes: z.array(ThemeSchema).min(1).max(100),
  separateModes: z.boolean(),
  separateInitialized: z.boolean(),
  shared: ProfileSchema,
  dark: ProfileSchema,
  light: ProfileSchema,
  uiSize: z.number().int().min(12).max(20),
  codeSize: z.number().int().min(11).max(20),
  motion: z.enum(["system", "on", "off"]),
  translucent: z.boolean(),
  contrast: z.number().int().min(0).max(100),
  diffMarkers: z.enum(["color", "symbols"]),
  pointer: z.boolean(),
  dockIcon: z.enum(["a", "aha"]),
  fontSmoothing: z.boolean(),
});
export const PreferencesSchema = LegacyPreferencesSchema.extend({
  schemaVersion: z.literal(2),
  backgrounds: BackgroundsSchema,
  clearMode: z.boolean(),
});
export const ThemePackageSchema = z.strictObject({
  schemaVersion: z.literal(2),
  theme: ThemeSchema,
  images: z
    .array(
      z.strictObject({
        id: ResourceIdSchema,
        data: z
          .string()
          .min(1)
          .max(30 * 1024 * 1024),
      }),
    )
    .max(5),
});
export const ImageResourceSchema = z.strictObject({
  id: ResourceIdSchema,
  mime: z.literal("image/png"),
  bytes: z.instanceof(Uint8Array),
});
export type ImageResource = z.infer<typeof ImageResourceSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Palette = z.infer<typeof PaletteSchema>;
export type AppearancePreferences = z.infer<typeof PreferencesSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export const capabilitiesSchema = z.strictObject({
  nativeSidebar: z.boolean(),
  dockIcon: z.boolean(),
  fontSmoothing: z.boolean(),
  systemDark: z.boolean(),
  reducedTransparency: z.boolean(),
});
export const AppearanceSnapshotSchema = z.strictObject({
  preferences: PreferencesSchema,
  capabilities: capabilitiesSchema,
  warning: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export type AppearanceSnapshot = z.infer<typeof AppearanceSnapshotSchema>;
export const SaveAppearanceSchema = z.strictObject({
  preferences: PreferencesSchema,
  revision: z.number().int().nonnegative(),
});
export const ThemeFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  theme: ThemeSchema,
});
export const APPEARANCE_CHANNELS = {
  get: "aha:appearance:get",
  save: "aha:appearance:save",
  reset: "aha:appearance:reset",
  changed: "aha:appearance:changed",
  import: "aha:appearance:import",
  export: "aha:appearance:export",
  importImage: "aha:appearance:image-import",
  readImage: "aha:appearance:image-read",
  importPackage: "aha:appearance:package-import",
  exportPackage: "aha:appearance:package-export",
} as const;
export const profile = (dark: boolean): Profile => ({
  palette: dark
    ? { background: "#121212", foreground: "#ECECEC", accent: "#8AB4F8" }
    : { background: "#FAFAFA", foreground: "#202020", accent: "#245CCC" },
  uiFont: "System",
  contentFont: "Same as UI",
  codeFont: "System",
  uiWeight: "400",
  contentWeight: "400",
  codeWeight: "400",
});
export const defaultTheme = (): Theme => ({
  id: "aha-default",
  name: "Aha 默认",
  dark: profile(true),
  light: profile(false),
});
export const synaraTheme = (): Theme => ({
  id: "aha-synara",
  name: "Synara",
  dark: {
    ...profile(true),
    palette: { background: "#181818", foreground: "#FFFFFF", accent: "#339CFF" },
  },
  light: {
    ...profile(false),
    palette: { background: "#FFFFFF", foreground: "#1A1C1F", accent: "#096BC2" },
  },
});
export const builtinThemes = (): Theme[] => [
  synaraTheme(),
  defaultTheme(),
  {
    id: "aha-moon",
    name: "月白紫",
    dark: {
      ...profile(true),
      palette: { background: "#19181F", foreground: "#ECEAF4", accent: "#C5B2F3" },
    },
    light: {
      ...profile(false),
      palette: { background: "#FAF8FF", foreground: "#282335", accent: "#7452A4" },
    },
  },
  {
    id: "aha-night",
    name: "星夜蓝",
    dark: {
      ...profile(true),
      palette: { background: "#151B24", foreground: "#E7EDF6", accent: "#97BCEB" },
    },
    light: {
      ...profile(false),
      palette: { background: "#F5F9FF", foreground: "#202E40", accent: "#34669C" },
    },
  },
  {
    id: "aha-sakura",
    name: "樱灰粉",
    dark: {
      ...profile(true),
      palette: { background: "#20191D", foreground: "#F2E9ED", accent: "#E8AEC4" },
    },
    light: {
      ...profile(false),
      palette: { background: "#FFF7FA", foreground: "#38252E", accent: "#9C4568" },
    },
  },
];
export const isBuiltinTheme = (id: string): boolean => builtinThemes().some((t) => t.id === id);
export const themeVisual = (p: AppearancePreferences) => ({
  backgrounds: structuredClone(p.backgrounds),
  uiSize: p.uiSize,
  codeSize: p.codeSize,
  contrast: p.contrast,
});
export const defaults = (): AppearancePreferences => ({
  schemaVersion: 2,
  backgrounds: defaultBackgrounds(),
  clearMode: false,
  mode: "dark",
  themeId: "aha-synara",
  themes: builtinThemes(),
  separateModes: false,
  separateInitialized: false,
  shared: synaraTheme().dark,
  dark: synaraTheme().dark,
  light: synaraTheme().light,
  uiSize: 13,
  codeSize: 13,
  motion: "system",
  translucent: false,
  contrast: 60,
  diffMarkers: "color",
  pointer: false,
  dockIcon: "a",
  fontSmoothing: false,
});
const rgb = (hex: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
export const mix = (a: string, b: string, ratio: number): string =>
  "#" +
  rgb(a)
    .map((v, i) =>
      Math.round(v * (1 - ratio) + (rgb(b)[i] ?? 0) * ratio)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const luminance = (hex: string): number =>
  rgb(hex)
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
export const contrastRatio = (a: string, b: string): number =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
export const resolvedMode = (p: AppearancePreferences, systemDark: boolean): "dark" | "light" =>
  p.mode === "system" ? (systemDark ? "dark" : "light") : p.mode;
export const activeProfile = (p: AppearancePreferences, dark: boolean): Profile => {
  const mode = resolvedMode(p, dark);
  if (p.separateModes) return p[mode];
  const theme = p.themes.find((t) => t.id === p.themeId) ?? defaultTheme();
  // Shared overrides apply to the current colour mode; unedited defaults follow the selected theme.
  const same =
    p.shared.palette.background === theme.dark.palette.background &&
    p.shared.palette.foreground === theme.dark.palette.foreground &&
    p.shared.palette.accent === theme.dark.palette.accent;
  return mode === "light" && same ? { ...p.shared, palette: theme.light.palette } : p.shared;
};
export const tokens = (p: AppearancePreferences, dark: boolean): Record<string, string> => {
  const { palette } = activeProfile(p, dark);
  const { background: bg, foreground: fg, accent } = palette;
  const surface = mix(bg, fg, 0.02);
  const elevated = mix(bg, fg, 0.105);
  const input = mix(bg, fg, 0.045);
  const readable = (target: string, minimum: number, backgrounds: string[]): string => {
    let v = target;
    for (let i = 0; i < 100 && backgrounds.some((b) => contrastRatio(v, b) < minimum); i++)
      v = mix(v, fg, 0.08);
    return v;
  };
  const surfaces = [bg, surface, elevated, input, mix(bg, fg, 0.12)];
  const focus = readable(accent, 3, surfaces);
  return {
    "--canvas": bg,
    "--window": mix(bg, fg, 0.015),
    "--rail": mix(bg, fg, 0.015),
    "--composer": input,
    "--popover": mix(bg, fg, 0.09),
    "--outline": mix(bg, fg, 0.15),
    "--popup-border": mix(bg, fg, 0.18),
    "--sidebar": surface,
    "--surface": surface,
    "--elevated": elevated,
    "--input": input,
    "--selected": mix(bg, fg, 0.12),
    "--border": mix(bg, fg, 0.07 + p.contrast / 2000),
    "--separator": mix(bg, fg, 0.06),
    "--hover": mix(bg, fg, 0.07),
    "--control": readable(mix(bg, fg, 0.42), 3, surfaces),
    "--text": fg,
    "--secondary": readable(mix(bg, fg, 0.68), 4.5, surfaces),
    "--muted": readable(mix(bg, fg, 0.58), 4.5, surfaces),
    "--accent": focus,
    "--accent-text":
      contrastRatio(focus, "#000000") > contrastRatio(focus, "#FFFFFF") ? "#000000" : "#FFFFFF",
    "--danger": readable("#F18B8B", 4.5, surfaces),
    "--success": readable("#8DC891", 4.5, surfaces),
    "--warning": readable("#E6BD75", 4.5, surfaces),
  };
};
export class AppearanceValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}
export const validatePreferences = (input: unknown): AppearancePreferences => {
  const p = PreferencesSchema.parse(input);
  const ids = p.themes.map((t) => t.id);
  if (new Set(ids).size !== ids.length || !ids.includes(p.themeId) || !ids.includes("aha-default"))
    throw new AppearanceValidationError("THEME_IDENTITY", "主题身份不完整");
  if (
    builtinThemes().some((b) =>
      p.themes.some((t) => t.id === b.id && JSON.stringify(t) !== JSON.stringify(b)),
    )
  )
    throw new AppearanceValidationError("THEME_DEFAULT", "内置主题不可修改，请保存为副本");
  for (const v of [p.shared, p.dark, p.light, ...p.themes.flatMap((t) => [t.dark, t.light])]) {
    if (contrastRatio(v.palette.background, v.palette.foreground) < 4.5)
      throw new AppearanceValidationError("CONTRAST_TEXT", "背景与文字对比度须至少 4.5:1");
    if (contrastRatio(v.palette.background, v.palette.accent) < 3)
      throw new AppearanceValidationError("CONTRAST_ACCENT", "强调色对比度须至少 3:1");
  }
  for (const mode of ["dark", "light"] as const) {
    const t = tokens({ ...p, mode }, true);
    for (const s of ["--canvas", "--surface", "--input", "--selected"])
      if (contrastRatio(t["--text"]!, t[s]!) < 4.5)
        throw new AppearanceValidationError(
          "CONTRAST_SURFACE",
          "派生表面与正文对比度不足，请调整颜色",
        );
  }
  for (const backgrounds of [
    p.backgrounds,
    ...p.themes.flatMap((t) => (t.visual ? [t.visual.backgrounds] : [])),
  ]) {
    if (backgrounds.window.source === "inherit")
      throw new AppearanceValidationError("BACKGROUND_ROOT", "整窗背景不能继承自身");
    for (const b of Object.values(backgrounds))
      if (b.source === "image" && !b.imageId)
        throw new AppearanceValidationError("BACKGROUND_IMAGE", "请选择背景图片");
  }
  return p;
};
export const migratePreferences = (input: unknown): AppearancePreferences => {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === 1
  ) {
    const old = LegacyPreferencesSchema.parse(input);
    return validatePreferences({
      ...old,
      schemaVersion: 2,
      backgrounds: defaultBackgrounds(),
      clearMode: false,
      themes: [
        ...old.themes,
        ...builtinThemes().filter((t) => !old.themes.some((o) => o.id === t.id)),
      ],
    });
  }
  const existing = PreferencesSchema.parse(input);
  return validatePreferences({
    ...existing,
    themes: [
      ...existing.themes,
      ...builtinThemes().filter((t) => !existing.themes.some((o) => o.id === t.id)),
    ],
  });
};
export interface AppearanceBridge {
  get(): Promise<AppearanceSnapshot>;
  save(input: z.infer<typeof SaveAppearanceSchema>): Promise<AppearanceSnapshot>;
  reset(): Promise<AppearanceSnapshot>;
  importTheme(): Promise<AppearanceSnapshot | null>;
  exportTheme(themeId: string): Promise<boolean>;
  importImage(): Promise<{ id: string } | null>;
  readImage(id: string): Promise<ImageResource>;
  importPackage(): Promise<AppearanceSnapshot | null>;
  exportPackage(themeId: string): Promise<boolean>;
  onChanged(listener: (snapshot: AppearanceSnapshot) => void): () => void;
}
