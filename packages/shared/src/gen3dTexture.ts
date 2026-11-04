// Seamless tiling for generated textures. Image models rarely make edges that match, so Aha
// cross-fades each axis with a half-offset copy: the borders come from the image's interior
// (continuous across the wrap) and the interior keeps the original pixels.

const smoothstep = (edge: number, x: number) => {
  const t = Math.min(1, Math.max(0, x / edge));
  return t * t * (3 - 2 * t);
};

/** Weight of the original pixel at index i of n: 0 at both borders, 1 beyond the band. */
function weights(n: number, band: number) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = smoothstep(band, Math.min(i, n - 1 - i) / (n / 2));
  return out;
}

/**
 * Returns a copy of an RGB (3 channels) or RGBA image that tiles seamlessly in both directions.
 * `band` is the cross-faded share of each half-axis (0–1).
 */
export function makeSeamless(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
  band = 0.35,
): Uint8Array {
  if (pixels.length !== width * height * channels) throw new Error("Image size mismatch.");
  if (width < 8 || height < 8) throw new Error("Texture is too small to tile.");
  const wx = weights(width, band),
    wy = weights(height, band);
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const w = horizontal ? wx[x]! : wy[y]!;
        const sx = horizontal ? (x + (width >> 1)) % width : x,
          sy = horizontal ? y : (y + (height >> 1)) % height;
        const i = (y * width + x) * channels,
          j = (sy * width + sx) * channels;
        for (let c = 0; c < channels; c++)
          out[i + c] = Math.round(src[i + c]! * w + src[j + c]! * (1 - w));
      }
    return out;
  };
  // Horizontal first; the vertical pass uses weights independent of x, so rows stay seamless.
  return pass(pass(pixels, true), false);
}
