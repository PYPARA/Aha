/** Rebuild default branding from the checked-in master; never edits skin assets. */
import { copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "../../..");
const assets = join(root, "assets/aha/default");
const master = await sharp(join(assets, "icon-master.png")).resize(1024, 1024).png().toBuffer();
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
  .extend({
    top: 64,
    bottom: 64,
    left: 64,
    right: 64,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();
await writeFile(join(assets, "icon.png"), icon);
for (const [name, size] of [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch.png", 180],
] as const)
  await sharp(clipped).resize(size, size).png().toFile(join(assets, name));
// ICNS accepts PNG payloads for modern icon representations on all supported Macs.
const chunks = await Promise.all(
  (
    [
      ["icp4", 16],
      ["icp5", 32],
      ["icp6", 64],
      ["ic07", 128],
      ["ic08", 256],
      ["ic09", 512],
      ["ic10", 1024],
      ["ic11", 32],
      ["ic12", 64],
      ["ic13", 256],
      ["ic14", 512],
    ] as const
  ).map(async ([type, size]) => {
    const png = await sharp(icon).resize(size, size).png().toBuffer();
    const chunk = Buffer.alloc(8);
    chunk.write(type);
    chunk.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([chunk, png]);
  }),
);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns");
icnsHeader.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
await writeFile(join(assets, "icon.icns"), Buffer.concat([icnsHeader, ...chunks]));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => sharp(clipped).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
for (const [index, png] of pngs.entries()) {
  const entry = 6 + 16 * index,
    size = sizes[index]!;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(join(assets, "icon.ico"), Buffer.concat([header, ...pngs]));
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
])
  await copyFile(
    join(
      assets,
      name.endsWith(".ico") ? "icon.ico" : name.endsWith(".icns") ? "icon.icns" : "icon.png",
    ),
    join(root, "apps/desktop/resources", name),
  );
for (const [source, target] of [
  ["icon.png", "aha-logo.png"],
  ["icon.ico", "favicon.ico"],
  ["favicon-16.png", "favicon-16x16.png"],
  ["favicon-32.png", "favicon-32x32.png"],
  ["apple-touch.png", "apple-touch-icon.png"],
])
  await copyFile(join(assets, source!), join(root, "apps/web/public", target!));
await copyFile(
  join(assets, "icon.png"),
  join(root, "apps/desktop/resources/dmgly/assets/app-icon.png"),
);
console.log("Prepared default A icons for desktop and web.");
