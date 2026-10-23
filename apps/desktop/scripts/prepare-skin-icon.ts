/** Replace one built-in skin icon from a local image; never touches backgrounds or app branding. */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { imageHash, normalizeImage } from "../src/aha/appearance-images";

const [skin, source, version] = process.argv.slice(2);
if ((skin !== "elation" && skin !== "furina") || !source || !version)
  throw new Error(
    "Usage: bun apps/desktop/scripts/prepare-skin-icon.ts <elation|furina> <image> <icon-YYYYMMDD>",
  );
const root = resolve(import.meta.dirname, "../../..");
const directory = join(root, "assets/aha", skin, version);
const master = await sharp(resolve(source)).resize(1024, 1024).png().toBuffer();
// Same geometry as the default app icon: rounded mask, transparent 64px padding.
const clipped = await sharp(master)
  .composite([
    {
      input: Buffer.from(
        '<svg width="1024" height="1024"><rect width="1024" height="1024" rx="224" fill="white"/></svg>',
      ),
      blend: "dest-in",
    },
  ])
  .png()
  .toBuffer();
const icon = await normalizeImage(
  await sharp(clipped)
    .resize(896, 896)
    .extend({
      top: 64,
      bottom: 64,
      left: 64,
      right: 64,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer(),
);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "icon-master.png"), master);
await writeFile(join(directory, "icon.png"), icon);
await writeFile(join(root, "apps/desktop/resources/aha", skin, "icon.png"), icon);
console.log(`Prepared ${skin} skin icon ${imageHash(icon)} (${icon.length} bytes).`);
