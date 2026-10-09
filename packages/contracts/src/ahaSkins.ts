import { z } from "zod";
import { BackgroundsSchema, ResourceIdSchema } from "./ahaLegacyAppearance";
import { AhaAppearanceSchema, type AhaAppearanceSnapshot } from "./ahaAppearance";

export const SkinIdSchema = z
  .string()
  .regex(/^(synara-default|aha-elation|furina-chanson|custom-[a-f0-9-]{36}|import-[a-f0-9-]{36})$/);
const ColorSchema = z.string().regex(/^#[a-f0-9]{6}$/i);
export const SkinColorsSchema = z.strictObject({
  surface: ColorSchema,
  ink: ColorSchema,
  accent: ColorSchema,
  contrast: z.number().finite().min(0).max(100),
  semanticColors: z.strictObject({
    diffAdded: ColorSchema,
    diffRemoved: ColorSchema,
    skill: ColorSchema,
  }),
});
export const SkinPaletteSchema = z.strictObject({
  dark: SkinColorsSchema,
  light: SkinColorsSchema,
});
export type SkinPalette = z.infer<typeof SkinPaletteSchema>;
// Original unskinned chrome colors, shared by desktop defaults and renderer checks.
export const DEFAULT_SKIN_PALETTE: SkinPalette = {
  dark: {
    surface: "#111111",
    ink: "#fcfcfc",
    accent: "#0169cc",
    contrast: 0,
    semanticColors: { diffAdded: "#00a240", diffRemoved: "#e02e2a", skill: "#b06dff" },
  },
  light: {
    surface: "#ffffff",
    ink: "#0d0d0d",
    accent: "#0169cc",
    contrast: 0,
    semanticColors: { diffAdded: "#00a240", diffRemoved: "#e02e2a", skill: "#751ed9" },
  },
};
export const SkinDefinitionSchema = z.strictObject({
  backgrounds: BackgroundsSchema,
  palette: SkinPaletteSchema.nullable(),
  iconId: ResourceIdSchema.nullable(),
});
export type SkinDefinition = z.infer<typeof SkinDefinitionSchema>;
export const SkinEntrySchema = z.strictObject({
  id: SkinIdSchema,
  name: z.string().trim().min(1).max(80),
  origin: z.enum(["builtin", "imported", "custom"]),
  original: SkinDefinitionSchema,
  adjusted: SkinDefinitionSchema,
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type SkinEntry = z.infer<typeof SkinEntrySchema>;
export const SkinLibraryFileSchema = z.strictObject({
  formatVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  appearanceRevision: z.number().int().nonnegative(),
  preferences: AhaAppearanceSchema,
  activeId: SkinIdSchema,
  effectiveIconId: ResourceIdSchema.nullable(),
  palette: SkinPaletteSchema.nullable(),
  skins: z.array(SkinEntrySchema).min(1).max(100),
});
export type SkinLibraryFile = z.infer<typeof SkinLibraryFileSchema>;
export interface SkinSnapshot {
  revision: number;
  activeId: string;
  effectiveIconId: string | null;
  palette: SkinPalette | null;
  skins: SkinEntry[];
  appearance: AhaAppearanceSnapshot;
  warning: string | null;
}
export interface SkinPreview {
  id: string;
  definition: SkinDefinition;
  effectiveIconId: string | null;
}
export const SkinApplySchema = z.strictObject({
  id: SkinIdSchema,
  revision: z.number().int().nonnegative(),
  preferences: AhaAppearanceSchema,
  definition: SkinDefinitionSchema,
});
export type SkinApply = z.infer<typeof SkinApplySchema>;
export const SkinPackageSchema = z.strictObject({
  schemaVersion: z.literal(4),
  name: z.string().trim().min(1).max(80),
  skin: SkinDefinitionSchema,
  images: z
    .array(z.strictObject({ id: ResourceIdSchema, data: z.string().max(28 * 1024 * 1024) }))
    .max(6),
});
export interface AhaSkinsBridge {
  list(input?: { initialPalette: SkinPalette }): Promise<SkinSnapshot>;
  preview(id: string): Promise<SkinPreview>;
  importPackage(): Promise<SkinPreview | null>;
  importDirectory(): Promise<SkinPreview | null>;
  apply(input: SkinApply): Promise<SkinSnapshot>;
  rename(input: { id: string; name: string; revision: number }): Promise<SkinSnapshot>;
  remove(input: { id: string; revision: number }): Promise<SkinSnapshot>;
  importIcon(): Promise<{ id: string } | null>;
  exportPackage(): Promise<boolean>;
  reapplyIcon(): Promise<void>;
  onChanged(listener: (snapshot: SkinSnapshot) => void): () => void;
}
