import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageAsset } from "@synara/contracts";
import { Effect } from "effect";
import type { ImageGenerationRepositoryShape } from "../persistence/Services/ImageGenerationRepository";
import { writeFileStringAtomically } from "../atomicWrite";
import { ImageApiError } from "./imageApi";

export class ImageAssetStore {
  constructor(
    readonly root: string,
    readonly repository: ImageGenerationRepositoryShape,
  ) {}
  filePath(id: string, variant: "original" | "edit" | "thumbnail" = "original") {
    if (!/^[0-9a-f]{64}$/u.test(id))
      throw new ImageApiError("invalid_asset", "Invalid image asset.");
    return path.join(this.root, "assets", `${id}.${variant}`);
  }
  async save(bytes: Uint8Array, name: string, maxBytes = 20 * 1024 * 1024): Promise<ImageAsset> {
    if (bytes.length === 0 || bytes.length > maxBytes)
      throw new ImageApiError("image_too_large", "Image exceeds the size limit.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await Effect.runPromise(this.repository.findAsset(hash));
    if (existing) return existing;
    await mkdir(path.join(this.root, "assets"), { recursive: true, mode: 0o700 });
    const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" });
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) > 1
    )
      throw new ImageApiError(
        "invalid_image",
        "Only still PNG, JPEG and WebP images are supported.",
      );
    const { data: normalized, info } = await image
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(normalized)
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    for (const [variant, data] of [
      ["original", bytes],
      ["edit", normalized],
      ["thumbnail", thumbnail],
    ] as const)
      await Effect.runPromise(
        writeFileStringAtomically({ filePath: this.filePath(hash, variant), contents: data }),
      );
    const mimeType = `image/${metadata.format}` as ImageAsset["mimeType"];
    const cleanName =
      // eslint-disable-next-line no-control-regex -- filenames must exclude NUL and header controls
      name.replace(/[\u0000\r\n/\\]/gu, "_").slice(0, 200) || `image.${metadata.format}`;
    const asset: ImageAsset = {
      id: hash,
      name: cleanName.replace(/\.(png|jpe?g|webp)$/iu, `.${metadata.format}`),
      mimeType,
      url: `/api/drawing/assets/${hash}`,
      thumbnailUrl: `/api/drawing/assets/${hash}?variant=thumbnail`,
      width: info.width,
      height: info.height,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    await Effect.runPromise(this.repository.saveAsset(asset, hash));
    return asset;
  }
  async read(asset: ImageAsset, variant: "original" | "edit" | "thumbnail" = "edit") {
    return new Uint8Array(await readFile(this.filePath(asset.id, variant)));
  }
  async validateMask(mask: ImageAsset, base: ImageAsset) {
    if (mask.mimeType !== "image/png" || mask.width !== base.width || mask.height !== base.height)
      throw new ImageApiError(
        "invalid_mask",
        "Mask must be a PNG with the same dimensions as the first reference image.",
      );
    const stats = await sharp(await this.read(mask))
      .ensureAlpha()
      .stats();
    if (stats.channels[3]!.min === 255)
      throw new ImageApiError(
        "empty_mask",
        "Paint an area to regenerate before submitting the mask.",
      );
  }
  async remove(id: string) {
    for (const variant of ["original", "edit", "thumbnail"] as const)
      await rm(this.filePath(id, variant), { force: true });
    await Effect.runPromise(this.repository.deleteAsset(id));
  }
}
