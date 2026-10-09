/** Local asset preparation only: no API access, credentials, or provider calls. */
import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { defaultBackgrounds, REGIONS } from "@synara/contracts/ahaLegacyAppearance";
import { AppearanceImages, normalizeImage } from "../src/aha/appearance-images";

const root = resolve(import.meta.dirname, "../../..");
const input = join(root, "output/imagegen/aha-elation");
const assets = join(root, "assets/aha/elation");
const runtime = join(root, "apps/desktop/resources/aha/elation");
const sizes = {
  window: [2048, 1152],
  rail: [768, 2048],
  sidebar: [1024, 2048],
  content: [2048, 1152],
  composer: [2048, 768],
} as const;
const opacity = { window: 0.48, rail: 0.2, sidebar: 0.23, content: 0.16, composer: 0.18 };
// Refuse a partial set before modifying any consumed artwork.
for (const name of ["icon", ...REGIONS]) await access(join(input, `${name}.png`));
await mkdir(assets, { recursive: true });
const images = new AppearanceImages(runtime);
const backgrounds = defaultBackgrounds();
for (const region of REGIONS) {
  const [width, height] = sizes[region];
  const bytes = await normalizeImage(
    await sharp(join(input, `${region}.png`))
      .resize(width, height, { fit: "cover", position: region === "window" ? "right" : "centre" })
      .png()
      .toBuffer(),
  );
  await writeFile(join(assets, `${region}.png`), bytes);
  backgrounds[region] = {
    ...backgrounds[region],
    source: "image",
    imageId: await images.store(bytes),
    opacity: opacity[region],
    overlay: 0.2,
    x: region === "window" ? 100 : 50,
  };
}
await writeFile(
  join(runtime, "manifest.json"),
  JSON.stringify({ id: "aha-elation", backgrounds }, null, 2) + "\n",
);
const master = await sharp(join(input, "icon.png")).resize(1024, 1024).png().toBuffer();
await writeFile(join(assets, "icon-master.png"), master);
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
const icon = await sharp(clipped)
  .resize(896, 896)
  .extend({ top: 64, bottom: 64, left: 64, right: 64, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
await writeFile(join(assets, "icon.png"), icon);
for (const [file, size] of [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch.png", 180],
] as const) {
  await sharp(clipped).resize(size, size).png().toFile(join(assets, file));
}
const iconset = join(root, ".tmp/aha-elation/icon.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  await sharp(icon)
    .resize(size, size)
    .png()
    .toFile(join(iconset, `icon_${size}x${size}.png`));
  await sharp(icon)
    .resize(size * 2, size * 2)
    .png()
    .toFile(join(iconset, `icon_${size}x${size}@2x.png`));
}
const icns = spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")], {
  encoding: "utf8",
});
if (icns.status !== 0) throw new Error(`ICNS export failed: ${icns.stderr}`);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  icoSizes.map((size) => sharp(clipped).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
for (const [index, png] of pngs.entries()) {
  const entry = 6 + 16 * index,
    size = icoSizes[index]!;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(join(assets, "icon.ico"), Buffer.concat([header, ...pngs]));
const resources = join(root, "apps/desktop/resources");
const preserved = join(root, "assets/aha/legacy-before-elation");
await mkdir(preserved, { recursive: true });
for (const name of [
  "dock-icon.png",
  "dock-icon-dark.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
  "synara.png",
  "app-icon-macos.png",
  "app-icon-linux.png",
  "app-icon-windows.ico",
]) {
  try {
    await copyFile(join(resources, name), join(preserved, name), 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await copyFile(
    join(
      assets,
      name.endsWith(".ico") ? "icon.ico" : name.endsWith(".icns") ? "icon.icns" : "icon.png",
    ),
    join(resources, name),
  );
}
const publicDir = join(root, "apps/web/public");
for (const [source, target] of [
  ["icon.png", "aha-logo.png"],
  ["icon.ico", "favicon.ico"],
  ["favicon-16.png", "favicon-16x16.png"],
  ["favicon-32.png", "favicon-32x32.png"],
  ["apple-touch.png", "apple-touch-icon.png"],
])
  await copyFile(join(assets, source!), join(publicDir, target!));
const generation = JSON.parse(await readFile(join(input, "generation.json"), "utf8"));
for (const job of generation.requests) {
  const meta = await sharp(join(input, job.output)).metadata();
  job.status = "generated";
  job.generatedSize = `${meta.width}x${meta.height}`;
}
await writeFile(join(input, "generation.json"), JSON.stringify(generation, null, 2) + "\n");
console.log("Prepared Aha icon formats and five normalized bundled backgrounds.");
