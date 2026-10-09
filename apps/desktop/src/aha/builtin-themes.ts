import { z } from "zod";
import { AhaBuiltinThemeIdSchema } from "@synara/contracts/ahaAppearance";
import { BackgroundsSchema, REGIONS } from "@synara/contracts/ahaLegacyAppearance";
import { AppearanceImages, backgroundIds, imageHash, normalizeImage } from "./appearance-images";

const ManifestSchema = z.strictObject({
  id: AhaBuiltinThemeIdSchema,
  backgrounds: BackgroundsSchema,
});

/** Internal bundled manifest; user-supplied paths never cross the IPC boundary. */
export async function readBuiltinBackgrounds(
  manifest: Buffer,
  directory: string,
  expectedId?: string,
) {
  const { id, backgrounds } = ManifestSchema.parse(JSON.parse(manifest.toString("utf8")));
  if (expectedId && id !== expectedId)
    throw new Error("内置皮肤身份不匹配 / Built-in skin identity mismatch.");
  for (const region of REGIONS) {
    if (backgrounds[region].source !== "image" || !backgrounds[region].imageId)
      throw new Error("内置主题图片引用不完整 / Built-in theme images are incomplete.");
  }
  const bundled = new AppearanceImages(directory);
  const images = new Map<string, Buffer>();
  for (const id of backgroundIds(backgrounds)) {
    const image = await bundled.read(id);
    images.set(id, await normalizeImage(Buffer.from(image.bytes)));
  }
  for (const region of REGIONS) {
    const background = backgrounds[region];
    background.imageId = imageHash(images.get(background.imageId!)!);
  }
  return { backgrounds, images: [...images.values()] };
}
