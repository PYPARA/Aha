import sharp from "sharp";
import type { SpriteContext } from "@synara/contracts";

/** Deterministic processing only: all frames share the source grid transform. */
export async function processSprite(bytes: Uint8Array, context: SpriteContext) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 64_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const count = context.frameCount;
  const warnings: string[] = [];
  const key = [1, 3, 5].map((i) => parseInt(context.chromaKey.slice(i, i + 2), 16));
  // Native transparent images must not be keyed again.
  let transparent = false;
  for (let i = 3; i < data.length; i += 4)
    if (data[i]! < 255) {
      transparent = true;
      break;
    }
  if (!transparent && context.background === "chroma") {
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.sqrt(
        key.reduce((sum, channel, j) => sum + (data[i + j]! - channel) ** 2, 0),
      );
      const alpha = Math.max(0, Math.min(1, (distance - 36) / 64));
      data[i + 3] = Math.round(alpha * 255);
      if (!alpha) {
        data[i] = data[i + 1] = data[i + 2] = 0;
        continue;
      }
      if (alpha < 1)
        for (let j = 0; j < 3; j++)
          data[i + j] = Math.round(
            Math.max(0, Math.min(255, (data[i + j]! - (1 - alpha) * key[j]!) / alpha)),
          );
    }
  } else if (!transparent)
    warnings.push("Expected transparency was not present; adjust background processing.");
  if (info.width < count)
    throw new Error("Source image is too narrow for the requested frame count.");
  const frames: Uint8Array[] = [];
  let previous: Buffer | undefined;
  for (let index = 0; index < count; index++) {
    const left = Math.floor((index * info.width) / count);
    const width = Math.floor(((index + 1) * info.width) / count) - left;
    const raw = await sharp(data, { raw: info })
      .extract({ left, top: 0, width, height: info.height })
      .raw()
      .toBuffer();
    let occupied = 0,
      edge = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < width; x++) {
        if (raw[(y * width + x) * 4 + 3]! > 24) {
          occupied++;
          if (x === 0 || y === 0 || x === width - 1 || y === info.height - 1) edge++;
        }
      }
    if (!occupied) warnings.push(`Frame ${index + 1} is empty.`);
    if (edge > 2)
      warnings.push(
        `Frame ${index + 1} touches its cell boundary; check clipping or overlapping poses.`,
      );
    if (occupied > width * info.height * 0.95)
      warnings.push(`Frame ${index + 1} may contain an unremoved background.`);
    const normalized = await sharp(raw, { raw: { width, height: info.height, channels: 4 } })
      .resize(context.width, context.height, {
        fit: "contain",
        background: "#00000000",
        kernel: "nearest",
      })
      .png()
      .toBuffer();
    const thumbnail = await sharp(normalized).resize(24, 24).raw().toBuffer();
    if (previous && previous.length === thumbnail.length) {
      let delta = 0;
      for (let i = 0; i < thumbnail.length; i++) delta += Math.abs(thumbnail[i]! - previous[i]!);
      if (delta / thumbnail.length < 1.5)
        warnings.push(`Frames ${index} and ${index + 1} are almost identical.`);
    }
    previous = thumbnail;
    frames.push(normalized);
  }
  return { frames, warnings };
}

export async function spriteLayoutGuide(count: number) {
  const width = 1536,
    height = Math.max(128, Math.round(1536 / count));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${Array.from({ length: count }, (_, i) => `<rect x="${(i * width) / count + 8}" y="8" width="${width / count - 16}" height="${height - 16}" fill="none" stroke="#999"/>`).join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
