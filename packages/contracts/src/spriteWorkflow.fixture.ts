import type { SpritePlanConfiguration } from "./spriteAnimation";
import { DEFAULT_SPRITE_RENDER_SPEC } from "./spriteWorkflow";

export function workflowConfiguration(frames = 8): SpritePlanConfiguration {
  const asset = {
    id: "base",
    name: "base.png",
    mimeType: "image/png" as const,
    url: "/base",
    thumbnailUrl: "/base",
    width: 256,
    height: 256,
    bytes: 100,
    createdAt: "2026-10-18T00:00:00Z",
  };
  return {
    workflowVersion: 2,
    renderSpec: DEFAULT_SPRITE_RENDER_SPEC,
    canonical: {
      revision: "revision",
      source: asset,
      asset,
      renderSpec: DEFAULT_SPRITE_RENDER_SPEC,
      registration: { scale: 1, offsetX: 0, offsetY: 0 },
      pivotX: 32,
      pivotY: 57,
      confirmedAt: asset.createdAt,
    },
    kind: "animation",
    mode: "combined",
    prompt: "A fox",
    actions: [
      {
        id: "jump",
        name: "jump",
        description: "jump and land",
        enabled: true,
        frameCount: frames,
        fps: 24,
        loop: false,
      },
    ],
    references: [{ referenceId: "canonical:revision", asset, role: "character", actionId: null }],
    providerId: "test",
    model: "test",
    width: 256,
    height: 256,
    background: "transparent",
    chromaKey: "#00ff00",
    parameters: { n: 1, size: "auto", outputFormat: "png" },
  };
}
