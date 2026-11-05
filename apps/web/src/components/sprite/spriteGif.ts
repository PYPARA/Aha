import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { renderSpriteFrame } from "./spriteFiles";
import { spriteFrameDuration, type SpriteProject } from "./spriteModel";

/**
 * A shareable GIF of one action's exported frames, timed by each frame's duration.
 * GIF keeps at most 256 colors and 1-bit transparency, so game engines should use the PNG
 * frames and atlases instead.
 */
export async function encodeSpriteGifPreview(
  project: SpriteProject,
  actionId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const action = project.actions.find((a) => a.id === actionId);
  if (!action?.frames.length) throw new Error("No frames to export.");
  const gif = GIFEncoder();
  for (const frame of action.frames) {
    signal?.throwIfAborted();
    const canvas = await renderSpriteFrame(project, frame);
    const { data, width, height } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: true });
    const transparentIndex = palette.findIndex((color) => color[3] === 0);
    gif.writeFrame(applyPalette(data, palette, "rgba4444"), width, height, {
      palette,
      delay: spriteFrameDuration(action, frame),
      repeat: action.loop ? 0 : -1,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      // Clear each frame so transparent pixels never show the previous pose.
      dispose: 2,
    });
  }
  gif.finish();
  return gif.bytes();
}
