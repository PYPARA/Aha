/** Deterministic local processing only; never calls an image API. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { imageHash, normalizeImage } from "../src/aha/appearance-images";

const root = resolve(import.meta.dirname, "../../..");
const version = "remaster-20261011";
const input = join(root, "output/imagegen", version);
const prepared: { skin: string; directory: string; icon: Buffer }[] = [];
for (const [skin, source, radius] of [
  ["elation", "references/xuzhao-user-avatar.png", 171],
  ["furina", "furina/icon.png", 224],
] as const) {
  const directory = join(root, "assets/aha", skin, version);
  await mkdir(directory, { recursive: true });
  const sourceBytes = await readFile(join(input, source));
  const sourceMetadata = await sharp(sourceBytes).metadata();
  const master = await sharp(sourceBytes).resize(1024, 1024).png().toBuffer();
  await writeFile(join(directory, "icon-master.png"), master);
  // Geometric alpha only. Black pixels inside the uploaded portrait stay untouched.
  const clipped = await sharp(master)
    .composite([
      {
        input: Buffer.from(
          `<svg width="1024" height="1024"><rect width="1024" height="1024" rx="${radius}" fill="white"/></svg>`,
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
  await writeFile(join(directory, "icon.png"), icon);
  for (const [file, size] of [
    ["favicon-16.png", 16],
    ["favicon-32.png", 32],
    ["apple-touch.png", 180],
  ] as const)
    await sharp(clipped).resize(size, size).png().toFile(join(directory, file));
  const iconset = join(root, ".tmp/skin-remaster", `${skin}.iconset`);
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
  const result = spawnSync(
    "iconutil",
    ["-c", "icns", iconset, "-o", join(directory, "icon.icns")],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ICNS export failed: ${result.stderr}`);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(
    sizes.map((size) => sharp(clipped).resize(size, size).png().toBuffer()),
  );
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  for (const [i, png] of pngs.entries()) {
    const pos = 6 + i * 16,
      size = sizes[i]!;
    header[pos] = size === 256 ? 0 : size;
    header[pos + 1] = header[pos];
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(png.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += png.length;
  }
  await writeFile(join(directory, "icon.ico"), Buffer.concat([header, ...pngs]));
  await writeFile(
    join(directory, "verification.json"),
    JSON.stringify(
      {
        source,
        sourceSize: [sourceMetadata.width, sourceMetadata.height],
        sourceAlpha: sourceMetadata.hasAlpha,
        finalSize: [1024, 1024],
        sha256: imageHash(icon),
        bytes: icon.length,
        processing:
          "Resize, geometric rounded mask, transparent outer padding; no black-pixel removal or synthesized detail.",
      },
      null,
      2,
    ) + "\n",
  );
  prepared.push({ skin, directory, icon });
}
// Keep the accepted content candidate outside the consumed bundle: the complete
// ten-background set is unavailable after the service's HTTP 524 failure.
await copyFile(
  join(input, "furina/content.png"),
  join(root, "assets/aha/furina", version, "content-candidate.png"),
);
// Both icons passed local decode/format checks before changing either runtime file.
for (const { skin, icon } of prepared)
  await writeFile(join(root, "apps/desktop/resources/aha", skin, "icon.png"), icon);
console.log(
  "Prepared two independent skin icons; installation artwork and background manifests preserved.",
);
