import { describe, expect, it } from "vitest";
import { makeSeamless } from "./gen3dTexture";

/** Mean absolute step between two columns (or rows) of an RGB image. */
function step(img: Uint8Array, w: number, h: number, a: number, b: number, rows = false) {
  let sum = 0;
  const n = rows ? w : h;
  for (let k = 0; k < n; k++)
    for (let c = 0; c < 3; c++) {
      const i = rows ? (a * w + k) * 3 + c : (k * w + a) * 3 + c;
      const j = rows ? (b * w + k) * 3 + c : (k * w + b) * 3 + c;
      sum += Math.abs(img[i]! - img[j]!);
    }
  return sum / (n * 3);
}

describe("makeSeamless", () => {
  // A diagonal gradient: smooth inside, with a hard jump where the left and right edges meet.
  const w = 64,
    h = 48;
  const gradient = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      gradient.set([x * 4, y * 5, (x * 2 + y * 3) % 256], (y * w + x) * 3);

  it("makes wrapped edges as continuous as the interior", () => {
    const out = makeSeamless(gradient, w, h, 3);
    const inner = step(out, w, h, 20, 21);
    expect(step(gradient, w, h, w - 1, 0)).toBeGreaterThan(100);
    expect(step(out, w, h, w - 1, 0)).toBeLessThanOrEqual(inner + 2);
    expect(step(out, w, h, h - 1, 0, true)).toBeLessThanOrEqual(step(out, w, h, 20, 21, true) + 2);
    // Continuity holds where the offset copy's own seam would sit (the image centre).
    expect(step(out, w, h, w / 2 - 1, w / 2)).toBeLessThanOrEqual(inner + 2);
  });
  it("keeps the interior beyond the blend band", () => {
    const out = makeSeamless(gradient, w, h, 3, 0.35);
    const i = ((h / 2) * w + w / 2) * 3;
    expect(Array.from(out.subarray(i, i + 3))).toEqual(Array.from(gradient.subarray(i, i + 3)));
  });
  it("validates the buffer", () => {
    expect(() => makeSeamless(new Uint8Array(10), 4, 4, 3)).toThrow(/size mismatch/);
    expect(() => makeSeamless(new Uint8Array(4 * 4 * 3), 4, 4, 3)).toThrow(/too small/);
  });
});
