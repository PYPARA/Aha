import { z } from "zod";
import { BackgroundsSchema, defaultBackgrounds, ResourceIdSchema } from "./ahaLegacyAppearance";

export { AHA_APPEARANCE_CHANNELS } from "./ahaChannels";

export const AhaBuiltinThemeIdSchema = z.literal("aha-elation");
export type AhaBuiltinThemeId = z.infer<typeof AhaBuiltinThemeIdSchema>;

export const AhaAppearanceSchema = z.strictObject({
  formatVersion: z.literal(1),
  backgrounds: BackgroundsSchema,
  codeSize: z.number().int().min(11).max(20).nullable().default(null),
  clearMode: z.boolean(),
  language: z.enum(["zh-CN", "en"]),
  uiWeight: z.enum(["400", "700"]),
  contentWeight: z.enum(["400", "700"]),
  codeWeight: z.enum(["400", "700"]),
});
export type AhaAppearance = z.infer<typeof AhaAppearanceSchema>;
export const defaultAhaAppearance = (): AhaAppearance => ({
  formatVersion: 1,
  backgrounds: defaultBackgrounds(),
  codeSize: null,
  clearMode: false,
  language: "zh-CN",
  uiWeight: "400",
  contentWeight: "400",
  codeWeight: "400",
});
export const AhaSaveAppearanceSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  preferences: AhaAppearanceSchema,
});
export interface AhaAppearanceSnapshot {
  preferences: AhaAppearance;
  revision: number;
  warning: string | null;
}
export const AhaThemePackageSchema = z.strictObject({
  schemaVersion: z.literal(3),
  appearance: AhaAppearanceSchema,
  nativeTheme: z.string().max(256 * 1024),
  images: z
    .array(z.strictObject({ id: ResourceIdSchema, data: z.string().max(28 * 1024 * 1024) }))
    .max(5),
});
export interface AhaThemePreview {
  preferences: AhaAppearance;
  nativeTheme: string | null;
  legacyTheme?: {
    dark: {
      palette: { background: string; foreground: string; accent: string };
      uiFont?: string;
      codeFont?: string;
    };
    light: {
      palette: { background: string; foreground: string; accent: string };
      uiFont?: string;
      codeFont?: string;
    };
  };
  uiSize?: number;
  codeSize?: number;
}
export interface AhaAppearanceBridge {
  get(): Promise<AhaAppearanceSnapshot>;
  save(input: z.infer<typeof AhaSaveAppearanceSchema>): Promise<AhaAppearanceSnapshot>;
  importImage(): Promise<{ id: string } | null>;
  readImage(id: string): Promise<{ id: string; mime: "image/png"; bytes: Uint8Array }>;
  previewDirectory(): Promise<AhaThemePreview | null>;
  previewPackage(): Promise<AhaThemePreview | null>;
  previewBuiltin(id: AhaBuiltinThemeId): Promise<AhaThemePreview>;
  exportPackage(input: { nativeTheme: string }): Promise<boolean>;
  onChanged(listener: (snapshot: AhaAppearanceSnapshot) => void): () => void;
}
