import { writeFile, mkdir, rename, unlink, access, copyFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import {
  SkinLibraryFileSchema,
  SkinDefinitionSchema,
  SkinPackageSchema,
  SkinPaletteSchema,
  SkinApplySchema,
  SkinAppIconSchema,
  type SkinAppIcon,
  type SkinLibraryFile,
  type SkinDefinition,
  type SkinSnapshot,
  type SkinPalette,
  type SkinPreview,
  type SkinApply,
} from "@synara/contracts/ahaSkins";
import {
  AhaAppearanceSchema,
  defaultAhaAppearance,
  type AhaAppearance,
} from "@synara/contracts/ahaAppearance";
import { AhaAppearanceStore } from "./appearance-store";
import {
  AppearanceImages,
  readBounded,
  normalizeImage,
  imageHash,
  MAX_IMAGE_BYTES,
} from "./appearance-images";
import { BUILTIN_PALETTES, paletteFromPreview } from "./skin-palettes";
import { refreshBuiltinDefinition } from "./skin-upgrade";

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const definitionIds = (definition: SkinDefinition) => [
  ...new Set([
    ...Object.values(definition.backgrounds).flatMap((background) =>
      background.imageId ? [background.imageId] : [],
    ),
    ...(definition.iconId ? [definition.iconId] : []),
  ]),
];
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(
    typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? value.toLowerCase() : value,
  );
};
const fingerprint = (definition: SkinDefinition) =>
  createHash("sha256").update(stableJson(definition)).digest("hex");
export interface SkinLibraryOptions {
  builtinDirectory(id: string): string | null;
  defaultIcon(): string | null;
  applyIcon(id: string | null, images: AppearanceImages): Promise<void>;
}
/** One atomic authoritative record holds both skin selection and appearance preferences. */
export class SkinLibrary {
  private state!: SkinLibraryFile;
  private blocked = false;
  private needsInitialization = false;
  private warning: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly file: string,
    readonly appearance: AhaAppearanceStore,
    readonly options: SkinLibraryOptions,
  ) {}
  async load() {
    try {
      this.state = SkinLibraryFileSchema.parse(
        JSON.parse((await readBounded(this.file, 4 * 1024 * 1024)).toString("utf8")),
      );
      if (
        new Set(this.state.skins.map((s) => s.id)).size !== this.state.skins.length ||
        !this.state.skins.some((s) => s.id === this.state.activeId)
      )
        throw new Error("Invalid skin IDs");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const current = this.appearance.snapshot();
      const id = `custom-${randomUUID()}`;
      const definition: SkinDefinition = {
        backgrounds: current.preferences.backgrounds,
        palette: null,
        iconId: null,
      };
      this.state = {
        formatVersion: 1,
        revision: 0,
        appearanceRevision: current.revision,
        preferences: current.preferences,
        activeId: id,
        effectiveIconId: null,
        appIconOverrideSkinId: null,
        palette: null,
        skins: [
          {
            id,
            name: "当前自定义外观",
            origin: "custom",
            original: definition,
            adjusted: definition,
            fingerprint: null,
          },
        ],
      };
      this.needsInitialization = missing;
      this.blocked = !missing;
      if (!missing)
        this.warning =
          "皮肤库损坏，原文件已保留；当前外观未覆盖 / Skin library is corrupt; existing appearance was preserved.";
    }
    // Register built-ins independently; missing bundles produce preview errors, never erase the library.
    const beforeBuiltins = structuredClone(this.state);
    let refreshed = false;
    let refreshFailed = false;
    for (const [id, name] of [
      ["synara-default", "默认样式"],
      ["aha-elation", "虚照·欢愉"],
      ["furina-chanson", "芙宁娜·众水之歌"],
    ]) {
      const existing = this.state.skins.find((s) => s.id === id);
      try {
        const definition = await this.readBuiltin(id!);
        if (id === "synara-default" && existing) {
          definition.backgrounds = existing.original.backgrounds;
          definition.palette = existing.original.palette;
        }
        if (existing) {
          if (existing.origin !== "builtin") continue;
          if (stableJson(existing.original) === stableJson(definition)) continue;
          existing.adjusted = refreshBuiltinDefinition(
            existing.original,
            existing.adjusted,
            definition,
          );
          existing.original = definition;
          refreshed = true;
        } else
          this.state.skins.push({
            id: id!,
            name: name!,
            origin: "builtin",
            original: definition,
            adjusted: definition,
            fingerprint: null,
          });
      } catch {
        if (existing && id !== "synara-default") refreshFailed = true;
        this.warning ??= "部分内置皮肤资源不可用 / Some built-in skin assets are unavailable.";
      }
    }
    // Migrate the old unskinned/inherited artwork without changing an applied
    // character skin or a user-edited default icon. Manual choices survive load.
    const active = this.state.skins.find((s) => s.id === this.state.activeId)!;
    const oldDefault = beforeBuiltins.skins.find((s) => s.id === "synara-default");
    if (
      !this.blocked &&
      this.state.appIconOverrideSkinId === null &&
      (active.adjusted.iconId === null ||
        (active.id === "synara-default" &&
          (this.state.effectiveIconId === null ||
            this.state.effectiveIconId === oldDefault?.original.iconId)))
    ) {
      const icon = this.resolveIcon(active.id);
      if (icon !== this.state.effectiveIconId) {
        this.state.effectiveIconId = icon;
        refreshed = true;
      }
    }
    if (refreshFailed || this.blocked) {
      if (refreshed) this.state = beforeBuiltins;
    } else if (refreshed && !this.needsInitialization) {
      const next = structuredClone(this.state);
      this.state = beforeBuiltins;
      next.revision++;
      try {
        await this.write(next);
      } catch {
        this.warning =
          "内置皮肤更新保存失败，旧配置已保留 / Built-in skin update could not be saved; previous settings were preserved.";
      }
    }
    for (const id of definitionIds({
      backgrounds: this.state.preferences.backgrounds,
      palette: this.state.palette,
      iconId: this.state.effectiveIconId,
    })) {
      try {
        await this.appearance.images.read(id);
      } catch {
        this.warning ??= "当前皮肤图片缺失或损坏 / Active skin images are missing or corrupt.";
      }
    }
  }
  private async readBuiltin(id: string): Promise<SkinDefinition> {
    if (id === "synara-default") {
      const icon = this.options.defaultIcon();
      if (!icon) throw new Error("默认图标缺失 / Default icon is missing.");
      return {
        backgrounds: defaultAhaAppearance().backgrounds,
        palette: BUILTIN_PALETTES[id]!,
        iconId: await this.appearance.images.store(
          await this.normalizeIcon(await readBounded(icon, MAX_IMAGE_BYTES)),
        ),
      };
    }
    const directory = this.options.builtinDirectory(id);
    if (!directory) throw new Error("内置皮肤尚未安装 / Built-in skin is not installed.");
    const preview = await this.appearance.previewBuiltin(
      id as "aha-elation" | "furina-chanson",
      directory,
    );
    const icon = join(directory, "icon.png");
    const iconId = await this.appearance.images.store(
      await this.normalizeIcon(await readBounded(icon, MAX_IMAGE_BYTES)),
    );
    return SkinDefinitionSchema.parse({
      backgrounds: preview.preferences.backgrounds,
      palette: BUILTIN_PALETTES[id],
      iconId,
    });
  }
  snapshot(): SkinSnapshot {
    return structuredClone({
      revision: this.state.revision,
      activeId: this.state.activeId,
      effectiveIconId: this.state.effectiveIconId,
      appIconOverrideSkinId: this.state.appIconOverrideSkinId,
      palette: this.state.palette,
      skins: this.state.skins,
      warning: this.warning,
      appearance: {
        preferences: this.state.preferences,
        revision: this.state.appearanceRevision,
        warning: this.warning ?? this.appearance.snapshot().warning,
      },
    });
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private assertWritable(revision?: number) {
    if (this.blocked) throw new Error(this.warning ?? "皮肤库损坏 / Skin library is corrupt.");
    if (revision !== undefined && revision !== this.state.revision)
      throw new Error("皮肤库已变化，请重新加载 / Skin library changed; reload before saving.");
  }
  private async write(next: SkinLibraryFile) {
    SkinLibraryFileSchema.parse(next);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    if (this.needsInitialization) {
      try {
        await access(this.appearance.file);
        await copyFile(this.appearance.file, `${this.appearance.file}.before-skins`, 1);
      } catch (error) {
        if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
    const temp = `${this.file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    this.state = next;
    this.needsInitialization = false;
  }
  list(initialPalette?: SkinPalette): Promise<SkinSnapshot> {
    return this.serial(async () => {
      if (this.needsInitialization && initialPalette) {
        this.assertWritable();
        const next = structuredClone(this.state);
        const palette = SkinPaletteSchema.parse(initialPalette);
        const current = next.skins.find((s) => s.id === next.activeId)!;
        current.original.palette = palette;
        current.adjusted.palette = palette;
        next.palette = palette;
        await this.write(next);
      }
      return this.snapshot();
    });
  }
  async preview(id: string, original = false): Promise<SkinPreview> {
    const entry = this.state.skins.find((s) => s.id === id);
    if (!entry) throw new Error("皮肤不存在 / Skin not found.");
    if (entry.origin === "builtin") await this.readBuiltin(id);
    const definition = structuredClone(original ? entry.original : entry.adjusted);
    await this.validate(definition);
    return { id, definition, effectiveIconId: definition.iconId ?? this.defaultIconId() };
  }
  private defaultIconId(): string | null {
    return this.state.skins.find((skin) => skin.id === "synara-default")?.original.iconId ?? null;
  }
  private resolveIcon(skinId: string): string | null {
    const skin = this.state.skins.find((entry) => entry.id === skinId);
    if (!skin) throw new Error("皮肤不存在 / Skin not found.");
    return skin.adjusted.iconId ?? this.defaultIconId();
  }
  private async commitIcon(next: SkinLibraryFile) {
    await this.options.applyIcon(next.effectiveIconId, this.appearance.images);
    try {
      await this.write(next);
    } catch (error) {
      try {
        await this.options.applyIcon(this.state.effectiveIconId, this.appearance.images);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "皮肤保存失败，图标恢复失败 / Saving and icon rollback failed.",
          { cause: rollback },
        );
      }
      throw error;
    }
  }
  setAppIcon(input: SkinAppIcon): Promise<SkinSnapshot> {
    return this.serial(async () => {
      const parsed = SkinAppIconSchema.parse(input);
      this.assertWritable(parsed.revision);
      const next = structuredClone(this.state);
      next.appIconOverrideSkinId = parsed.skinId;
      next.effectiveIconId = this.resolveIcon(parsed.skinId ?? next.activeId);
      next.revision++;
      await this.commitIcon(next);
      return this.snapshot();
    });
  }
  private async validate(definition: SkinDefinition) {
    SkinDefinitionSchema.parse(definition);
    if (definition.backgrounds.window.source === "inherit")
      throw new Error("窗口背景不能继承自身 / Window cannot inherit itself.");
    for (const b of Object.values(definition.backgrounds))
      if (b.source === "image" && !b.imageId)
        throw new Error("背景图片引用不完整 / Background image missing.");
    for (const id of definitionIds(definition)) await this.appearance.images.read(id);
    if (definition.iconId) {
      const icon = await this.appearance.images.read(definition.iconId);
      const meta = await sharp(Buffer.from(icon.bytes)).metadata();
      if (meta.width !== 1024 || meta.height !== 1024)
        throw new Error("皮肤图标必须为1024px / Skin icon must be 1024px square.");
    }
  }
  apply(input: SkinApply): Promise<SkinSnapshot> {
    return this.serial(async () => {
      const parsed = SkinApplySchema.parse(input);
      this.assertWritable(parsed.revision);
      const entry = this.state.skins.find((s) => s.id === parsed.id);
      if (!entry) throw new Error("皮肤不存在 / Skin not found.");
      await this.validate(parsed.definition);
      const preferences = AhaAppearanceSchema.parse({
        ...parsed.preferences,
        backgrounds: parsed.definition.backgrounds,
      });
      const next = structuredClone(this.state);
      next.skins.find((s) => s.id === parsed.id)!.adjusted = parsed.definition;
      next.activeId = parsed.id;
      if (parsed.id !== this.state.activeId || parsed.definition.iconId !== entry.adjusted.iconId)
        next.appIconOverrideSkinId = null;
      next.effectiveIconId =
        next.appIconOverrideSkinId === null
          ? (parsed.definition.iconId ?? this.defaultIconId())
          : this.state.effectiveIconId;
      next.palette = parsed.definition.palette;
      next.preferences = preferences;
      next.revision++;
      next.appearanceRevision++;
      await this.commitIcon(next);
      return this.snapshot();
    });
  }
  saveAppearance(preferences: AhaAppearance, revision: number) {
    return this.serial(async () => {
      this.assertWritable();
      if (revision !== this.state.appearanceRevision)
        throw new Error("外观已变化，请重新加载后保存。");
      const parsed = AhaAppearanceSchema.parse(preferences);
      const next = structuredClone(this.state);
      const skin = next.skins.find((s) => s.id === next.activeId)!;
      const definition = { ...skin.adjusted, backgrounds: parsed.backgrounds };
      await this.validate(definition);
      skin.adjusted = definition;
      next.preferences = parsed;
      next.revision++;
      next.appearanceRevision++;
      await this.write(next);
      return this.snapshot().appearance;
    });
  }
  private async normalizeIcon(bytes: Buffer) {
    const png = await normalizeImage(bytes);
    return sharp(png).resize(1024, 1024, { fit: "cover" }).png().toBuffer();
  }
  async importIcon(file: string) {
    return this.appearance.images.store(
      await this.normalizeIcon(await readBounded(file, MAX_IMAGE_BYTES)),
    );
  }
  private async normalizePackage(
    file: string,
  ): Promise<{ name: string; definition: SkinDefinition }> {
    const raw = JSON.parse((await readBounded(file, MAX_PACKAGE_BYTES)).toString("utf8"));
    if (raw.schemaVersion !== 4) {
      const preview = await this.appearance.previewPackage(file);
      return {
        name: basename(file).replace(/\.json$/i, ""),
        definition: {
          backgrounds: preview.preferences.backgrounds,
          palette: paletteFromPreview(preview),
          iconId: null,
        },
      };
    }
    const pack = SkinPackageSchema.parse(raw);
    const expected = new Set(definitionIds(pack.skin));
    if (
      pack.images.length !== expected.size ||
      new Set(pack.images.map((i) => i.id)).size !== expected.size
    )
      throw new Error("皮肤包图片引用不完整 / Skin images are incomplete.");
    const normalized = new Map<string, Buffer>();
    for (const image of pack.images) {
      const bytes = Buffer.from(image.data, "base64");
      if (
        !expected.has(image.id) ||
        bytes.toString("base64") !== image.data ||
        imageHash(bytes) !== image.id
      )
        throw new Error("皮肤包图片校验失败 / Skin image integrity failed.");
      normalized.set(
        image.id,
        image.id === pack.skin.iconId
          ? await this.normalizeIcon(bytes)
          : await normalizeImage(bytes),
      );
    }
    const definition = structuredClone(pack.skin);
    for (const b of Object.values(definition.backgrounds))
      if (b.imageId) b.imageId = imageHash(normalized.get(b.imageId)!);
    if (definition.iconId) definition.iconId = imageHash(normalized.get(definition.iconId)!);
    for (const bytes of normalized.values()) await this.appearance.images.store(bytes);
    await this.validate(definition);
    return { name: pack.name, definition };
  }
  importPackage(file: string): Promise<SkinPreview> {
    return this.importDefinition(() => this.normalizePackage(file));
  }
  importDirectory(directory: string): Promise<SkinPreview> {
    return this.importDefinition(async () => {
      const preview = await this.appearance.previewDirectory(directory);
      return {
        name: basename(directory),
        definition: {
          backgrounds: preview.preferences.backgrounds,
          palette: paletteFromPreview(preview),
          iconId: null,
        },
      };
    });
  }
  private importDefinition(
    read: () => Promise<{ name: string; definition: SkinDefinition }>,
  ): Promise<SkinPreview> {
    return this.serial(async () => {
      this.assertWritable();
      const { name, definition } = await read();
      await this.validate(definition);
      const hash = fingerprint(definition);
      const existing = this.state.skins.find(
        (s) =>
          s.fingerprint === hash ||
          fingerprint(s.original) === hash ||
          fingerprint(s.adjusted) === hash,
      );
      if (existing) return this.preview(existing.id);
      if (this.state.skins.length >= 100)
        throw new Error("皮肤库最多100套 / Skin library is limited to 100 skins.");
      const next = structuredClone(this.state);
      const base = name.trim().slice(0, 70) || "导入皮肤";
      let unique = base;
      for (let n = 2; next.skins.some((s) => s.name === unique); n++) unique = `${base} (${n})`;
      const id = `import-${randomUUID()}`;
      next.skins.push({
        id,
        name: unique,
        origin: "imported",
        original: definition,
        adjusted: definition,
        fingerprint: hash,
      });
      next.revision++;
      await this.write(next);
      return this.preview(id);
    });
  }
  rename(id: string, name: string, revision: number) {
    return this.serial(async () => {
      this.assertWritable(revision);
      const next = structuredClone(this.state),
        entry = next.skins.find((s) => s.id === id);
      if (!entry || entry.origin === "builtin")
        throw new Error("无法修改内置皮肤 / Cannot rename built-in skin.");
      entry.name = name.trim();
      next.revision++;
      await this.write(next);
      return this.snapshot();
    });
  }
  remove(id: string, revision: number) {
    return this.serial(async () => {
      this.assertWritable(revision);
      const entry = this.state.skins.find((s) => s.id === id);
      if (!entry || entry.origin === "builtin")
        throw new Error("无法删除内置皮肤 / Cannot remove built-in skin.");
      if (id === this.state.activeId)
        throw new Error("请先切换到另一套皮肤 / Switch to another skin before deleting.");
      const next = structuredClone(this.state);
      next.skins = next.skins.filter((s) => s.id !== id);
      next.revision++;
      if (next.appIconOverrideSkinId === id) {
        next.appIconOverrideSkinId = null;
        next.effectiveIconId = this.resolveIcon(next.activeId);
        await this.commitIcon(next);
      } else await this.write(next);
      return this.snapshot();
    });
  }
  async exportPackage(file: string) {
    const entry = this.state.skins.find((s) => s.id === this.state.activeId)!;
    // A bundle refresh only changes future previews. Export the applied appearance,
    // including its old resources, until the user explicitly applies the new skin.
    const definition: SkinDefinition = {
      backgrounds: structuredClone(this.state.preferences.backgrounds),
      palette: this.state.palette,
      iconId:
        entry.adjusted.iconId === null
          ? null
          : this.state.appIconOverrideSkinId === null
            ? this.state.effectiveIconId
            : entry.adjusted.iconId,
    };
    const images = await Promise.all(
      definitionIds(definition).map(async (id) => ({
        id,
        data: Buffer.from((await this.appearance.images.read(id)).bytes).toString("base64"),
      })),
    );
    const bytes = JSON.stringify(
      SkinPackageSchema.parse({ schemaVersion: 4, name: entry.name, skin: definition, images }),
    );
    if (Buffer.byteLength(bytes) > MAX_PACKAGE_BYTES)
      throw new Error("皮肤包上限100MB / Skin package exceeds 100MB.");
    const temp = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, bytes + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
  reapplyIcon() {
    return this.serial(() =>
      this.options.applyIcon(this.state.effectiveIconId, this.appearance.images),
    );
  }
}
