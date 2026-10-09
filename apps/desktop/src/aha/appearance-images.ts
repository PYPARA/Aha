import sharp from "sharp";
import { constants } from "node:fs";
import { open, mkdir, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ResourceIdSchema,
  type ImageResource,
  type Backgrounds,
} from "@synara/contracts/ahaLegacyAppearance";
import { PublicError } from "./public-error";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export const imageHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const invalid = () =>
  new PublicError("BACKGROUND_INVALID", "请选择静态 PNG、JPEG 或 WebP；图片上限 20MB、32MP");
// Check signatures before handing untrusted bytes to a decoder (in particular, no SVG/remote input).
function staticRaster(bytes: Buffer): void {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw invalid();
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let pos = 8; pos + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(pos),
        type = bytes.toString("ascii", pos + 4, pos + 8);
      if (type === "acTL" || pos + length + 12 > bytes.length) throw invalid();
      pos += length + 12;
    }
    return;
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return;
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    for (let pos = 12; pos + 8 <= bytes.length; ) {
      const type = bytes.toString("ascii", pos, pos + 4),
        length = bytes.readUInt32LE(pos + 4);
      if (type === "ANIM" || type === "ANMF" || pos + length + 8 > bytes.length) throw invalid();
      pos += 8 + length + (length % 2);
    }
    return;
  }
  throw invalid();
}
export async function normalizeImage(input: Buffer): Promise<Buffer> {
  staticRaster(input);
  try {
    const decoder = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
    const meta = await decoder.metadata();
    if (
      !meta.width ||
      !meta.height ||
      meta.width * meta.height > MAX_IMAGE_PIXELS ||
      (meta.pages ?? 1) > 1
    )
      throw invalid();
    const bytes = await decoder
      .rotate()
      .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (bytes.length > MAX_IMAGE_BYTES) throw invalid();
    return bytes;
  } catch {
    throw invalid();
  }
}
export async function readBounded(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) throw invalid();
    // Read no more than the limit even if the file changes after stat.
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw invalid();
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export const backgroundIds = (backgrounds: Backgrounds): string[] => [
  ...new Set(
    Object.values(backgrounds).flatMap((b) =>
      b.source === "image" && b.imageId ? [b.imageId] : [],
    ),
  ),
];
export class AppearanceImages {
  constructor(readonly directory: string) {}
  async importFile(path: string): Promise<string> {
    return this.store(await normalizeImage(await readBounded(path, MAX_IMAGE_BYTES)));
  }
  async store(bytes: Buffer): Promise<string> {
    const id = imageHash(bytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(this.directory, `.tmp-${randomUUID()}`);
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, join(this.directory, `${id}.png`));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    return id;
  }
  async read(id: string): Promise<ImageResource> {
    ResourceIdSchema.parse(id);
    try {
      const bytes = await readBounded(join(this.directory, `${id}.png`), MAX_IMAGE_BYTES);
      if (imageHash(bytes) !== id) throw invalid();
      return { id, mime: "image/png", bytes: new Uint8Array(bytes) };
    } catch {
      throw new PublicError(
        "BACKGROUND_MISSING",
        "背景图片丢失或损坏，已回退为主题底色；请重新导入",
      );
    }
  }
  async removeUnreferenced(keep: Set<string>): Promise<void> {
    const files = await readdir(this.directory).catch(() => [] as string[]);
    for (const file of files)
      if (/^[a-f0-9]{64}\.png$/.test(file) && !keep.has(file.slice(0, -4)))
        await unlink(join(this.directory, file)).catch(() => undefined);
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) {
      ResourceIdSchema.parse(id);
      await unlink(join(this.directory, `${id}.png`)).catch(() => undefined);
    }
  }
}
