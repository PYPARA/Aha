import { readFile, writeFile, mkdir, rename, unlink, stat, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AhaAppearanceSchema,
  defaultAhaAppearance,
  AhaThemePackageSchema,
  AhaBuiltinThemeIdSchema,
  type AhaBuiltinThemeId,
  type AhaAppearance,
  type AhaAppearanceSnapshot,
  type AhaThemePreview,
} from "@synara/contracts/ahaAppearance";
import {
  ThemePackageSchema,
  ThemeFileSchema,
  PreferencesSchema,
  ThemeSchema,
} from "@synara/contracts/ahaLegacyAppearance";
import {
  AppearanceImages,
  backgroundIds,
  imageHash,
  normalizeImage,
  readBounded,
} from "./appearance-images";
import { readBuiltinBackgrounds } from "./builtin-themes";

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
export class AhaAppearanceStore {
  private preferences = defaultAhaAppearance();
  private revision = 0;
  private warning: string | null = null;
  private blocked = false;
  private queue: Promise<unknown> = Promise.resolve();
  readonly images: AppearanceImages;
  constructor(readonly file: string) {
    this.images = new AppearanceImages(join(dirname(file), "aha-backgrounds"));
  }
  async load() {
    try {
      if ((await stat(this.file)).size > 1024 * 1024) throw new Error("APPEARANCE_LIMIT");
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.preferences = AhaAppearanceSchema.parse(raw.preferences ?? raw);
      this.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
      for (const id of backgroundIds(this.preferences.backgrounds)) {
        try {
          await this.images.read(id);
        } catch {
          this.warning = "背景图片丢失或损坏，请重新导入。";
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.blocked = true;
        this.warning = "外观配置损坏，原文件已保留。请使用恢复默认。";
      }
    }
  }
  snapshot(): AhaAppearanceSnapshot {
    return structuredClone({
      preferences: this.preferences,
      revision: this.revision,
      warning: this.warning,
    });
  }
  save(input: AhaAppearance, revision: number): Promise<AhaAppearanceSnapshot> {
    const job = this.queue.then(async () => {
      if (revision !== this.revision) throw new Error("外观已变化，请重新加载后保存。");
      const next = AhaAppearanceSchema.parse(input);
      if (next.backgrounds.window.source === "inherit") throw new Error("窗口背景不能继承自身。");
      for (const b of Object.values(next.backgrounds))
        if (b.source === "image" && !b.imageId) throw new Error("请先选择背景图片。");
      const before = new Set(backgroundIds(this.preferences.backgrounds));
      let warning: string | null = null;
      for (const id of backgroundIds(next.backgrounds)) {
        try {
          await this.images.read(id);
        } catch (error) {
          if (!before.has(id)) throw error;
          warning = "背景图片丢失或损坏，请重新导入。";
        }
      }
      // Corrupt state can only be recovered by an explicit reset to defaults.
      if (this.blocked && JSON.stringify(next) !== JSON.stringify(defaultAhaAppearance()))
        throw new Error(this.warning ?? "配置损坏");
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      if (this.blocked) await copyFile(this.file, `${this.file}.recovery-${randomUUID()}`);
      const temp = `${this.file}.tmp-${randomUUID()}`;
      try {
        await writeFile(
          temp,
          JSON.stringify({ preferences: next, revision: this.revision + 1 }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        await rename(temp, this.file);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      this.preferences = next;
      this.revision++;
      this.blocked = false;
      this.warning = warning;
      return this.snapshot();
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  async previewPackage(file: string): Promise<AhaThemePreview> {
    if ((await stat(file)).size > MAX_PACKAGE_BYTES) throw new Error("主题包上限100MB。");
    const bytes = await readFile(file);
    if (bytes.length > MAX_PACKAGE_BYTES) throw new Error("主题包上限100MB。");
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const version = (raw as { schemaVersion?: number }).schemaVersion;
    let preview: AhaThemePreview;
    let images: { id: string; data: string }[] = [];
    if (version === 3) {
      const pack = AhaThemePackageSchema.parse(raw);
      JSON.parse(pack.nativeTheme);
      preview = { preferences: pack.appearance, nativeTheme: pack.nativeTheme };
      images = pack.images;
    } else {
      const pack = version === 2 ? ThemePackageSchema.parse(raw) : ThemeFileSchema.parse(raw);
      const theme = pack.theme;
      preview = {
        preferences: {
          ...this.preferences,
          backgrounds: theme.visual?.backgrounds ?? defaultAhaAppearance().backgrounds,
          codeSize: theme.visual?.codeSize ?? null,
          uiWeight: theme.dark.uiWeight,
          contentWeight: theme.dark.contentWeight,
          codeWeight: theme.dark.codeWeight,
        },
        nativeTheme: null,
        legacyTheme: { dark: theme.dark, light: theme.light },
        ...(theme.visual ? { uiSize: theme.visual.uiSize, codeSize: theme.visual.codeSize } : {}),
      };
      if ("images" in pack) images = pack.images;
    }
    const expected = new Set(backgroundIds(preview.preferences.backgrounds));
    if (images.length !== expected.size || new Set(images.map((i) => i.id)).size !== expected.size)
      throw new Error("主题包图片引用不完整。");
    const normalized = new Map<string, Buffer>();
    for (const image of images) {
      const rawImage = Buffer.from(image.data, "base64");
      if (
        !expected.has(image.id) ||
        rawImage.toString("base64") !== image.data ||
        imageHash(rawImage) !== image.id
      )
        throw new Error("主题包图片身份不正确。");
      normalized.set(image.id, await normalizeImage(rawImage));
    }
    for (const b of Object.values(preview.preferences.backgrounds))
      if (b.imageId && normalized.has(b.imageId)) b.imageId = imageHash(normalized.get(b.imageId)!);
    // Resources are content-addressed; preview never changes active preferences.
    for (const image of normalized.values()) await this.images.store(image);
    return preview;
  }
  async previewBuiltin(id: AhaBuiltinThemeId, directory: string): Promise<AhaThemePreview> {
    AhaBuiltinThemeIdSchema.parse(id);
    const manifest = await readBounded(join(directory, "manifest.json"), 16 * 1024);
    const { backgrounds, images } = await readBuiltinBackgrounds(manifest, directory);
    // Validate every resource before adding any to the user image cache.
    for (const image of images) await this.images.store(image);
    return {
      preferences: { ...this.snapshot().preferences, backgrounds, clearMode: false },
      nativeTheme: null,
    };
  }
  async previewDirectory(directory: string): Promise<AhaThemePreview> {
    const path = join(directory, "appearance.json");
    if ((await stat(path)).size > 1024 * 1024) throw new Error("外观配置过大。");
    const old = PreferencesSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const selected = old.themes.find((theme) => theme.id === old.themeId);
    if (!selected) throw new Error("旧外观主题不存在。");
    const sourceImages = new AppearanceImages(join(directory, "appearance-images"));
    for (const id of backgroundIds(old.backgrounds)) await sourceImages.read(id);
    for (const id of backgroundIds(old.backgrounds))
      await this.images.store(Buffer.from((await sourceImages.read(id)).bytes));
    return {
      preferences: {
        ...defaultAhaAppearance(),
        backgrounds: old.backgrounds,
        clearMode: old.clearMode,
        codeSize: old.codeSize,
        uiWeight: old.shared.uiWeight,
        contentWeight: old.shared.contentWeight,
        codeWeight: old.shared.codeWeight,
      },
      nativeTheme: null,
      legacyTheme: ThemeSchema.parse(selected),
      uiSize: old.uiSize,
      codeSize: old.codeSize,
    };
  }
  async exportPackage(file: string, nativeTheme: string) {
    if (nativeTheme.length > 256 * 1024) throw new Error("主题过大。");
    JSON.parse(nativeTheme);
    const appearance = this.snapshot().preferences;
    const images = [];
    for (const id of backgroundIds(appearance.backgrounds))
      images.push({ id, data: Buffer.from((await this.images.read(id)).bytes).toString("base64") });
    const json = JSON.stringify(
      AhaThemePackageSchema.parse({ schemaVersion: 3, appearance, nativeTheme, images }),
    );
    if (Buffer.byteLength(json) > MAX_PACKAGE_BYTES) throw new Error("主题包上限100MB。");
    const temp = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, json + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
