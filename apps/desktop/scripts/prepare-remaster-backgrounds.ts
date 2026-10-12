/** Local-only preparation of the complete, visually reviewed remaster background set. */
import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { defaultBackgrounds, REGIONS } from "@synara/contracts/ahaLegacyAppearance";
import { AppearanceImages, normalizeImage, imageHash } from "../src/aha/appearance-images";
const root = resolve(import.meta.dirname, "../../..");
const version = "remaster-20261012";
const sizes = {
  window: [2048, 1152],
  rail: [768, 2048],
  sidebar: [1024, 2048],
  content: [2048, 1152],
  composer: [2048, 768],
} as const;
const opacity = { window: 0.48, rail: 0.2, sidebar: 0.23, content: 0.16, composer: 0.18 };
const sets = [];
// Decode and normalize the entire set before touching any consumed manifest.
for (const skin of ["elation", "furina"] as const) {
  const entries = [];
  for (const region of REGIONS) {
    const source = join(
      root,
      "output/imagegen",
      skin === "furina" && region === "content"
        ? "remaster-20261011"
        : "remaster-continuation-20261012",
      skin,
      skin === "elation" && region === "composer" ? "composer-local-crop.png" : `${region}.png`,
    );
    const original = await readFile(source),
      meta = await sharp(original).metadata();
    const [width, height] = sizes[region];
    const bytes = await normalizeImage(
      await sharp(original)
        .resize(width, height, {
          fit: "cover",
          position: region === "content" ? "right" : "centre",
        })
        .png()
        .toBuffer(),
    );
    entries.push({
      region,
      bytes,
      source: source.slice(root.length + 1),
      generatedSize: [meta.width, meta.height],
      method:
        skin === "elation" && region === "composer"
          ? "Local bottom-aligned 8:3 crop of this version’s window image; the distinct API request timed out and was not retried."
          : "Image API output, locally resized",
      size: [width, height],
      bytesCount: bytes.length,
      sha256: imageHash(bytes),
    });
  }
  const icon = await readFile(join(root, "assets/aha", skin, "remaster-20261011/icon.png"));
  const meta = await sharp(icon).metadata();
  if (meta.width !== 1024 || meta.height !== 1024 || !meta.hasAlpha)
    throw new Error("Invalid prepared skin icon");
  sets.push({ skin, entries, icon });
}
for (const { skin, entries, icon } of sets) {
  const directory = join(root, "assets/aha", skin, version);
  const runtime = join(root, "apps/desktop/resources/aha", skin);
  await mkdir(directory, { recursive: true });
  const images = new AppearanceImages(runtime),
    backgrounds = defaultBackgrounds();
  for (const entry of entries) {
    await writeFile(join(directory, `${entry.region}.png`), entry.bytes);
    backgrounds[entry.region] = {
      ...backgrounds[entry.region],
      source: "image",
      imageId: await images.store(entry.bytes),
      opacity: opacity[entry.region],
      overlay: 0.2,
      x: entry.region === "content" ? 100 : 50,
    };
  }
  for (const file of [
    "icon.png",
    "icon-master.png",
    "icon.icns",
    "icon.ico",
    "favicon-16.png",
    "favicon-32.png",
    "apple-touch.png",
  ])
    await copyFile(
      join(root, "assets/aha", skin, "remaster-20261011", file),
      join(directory, file),
    );
  await writeFile(
    join(directory, "verification.json"),
    JSON.stringify(
      {
        version,
        icon: { sha256: imageHash(icon), size: [1024, 1024], bytes: icon.length },
        backgrounds: entries.map(({ bytes: _bytes, ...data }) => data),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(runtime, "manifest.json.remaster-tmp"),
    JSON.stringify(
      { id: skin === "elation" ? "aha-elation" : "furina-chanson", backgrounds },
      null,
      2,
    ) + "\n",
  );
}
// No paid generation or icon/installation identity change occurs here. Old hashed
// resources remain for active appearances and subsequent restart recovery.
for (const { skin } of sets) {
  const runtime = join(root, "apps/desktop/resources/aha", skin);
  await rename(join(runtime, "manifest.json.remaster-tmp"), join(runtime, "manifest.json"));
}
console.log(
  "Prepared ten normalized backgrounds and two full versioned asset sets; old resources retained.",
);
