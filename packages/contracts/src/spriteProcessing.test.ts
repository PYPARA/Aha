import { it, expect } from "vitest";
import {
  spriteRecommendedSize,
  spritePlanPrompt,
  spriteLayoutGuideSvg,
  spriteSizeSummary,
} from "./spritePlan";
import type { SpritePlanConfiguration } from "./spriteAnimation";
const configuration: SpritePlanConfiguration = {
  kind: "animation",
  mode: "combined",
  prompt: "A fox",
  providerId: "p",
  model: "m",
  width: 256,
  height: 256,
  background: "transparent",
  chromaKey: "#00ff00",
  references: [],
  parameters: { n: 1, size: "2048x2048", outputFormat: "png" },
  actions: Array.from({ length: 8 }, (_, i) => ({
    id: `a-${i}`,
    name: `a-${i}`,
    description: "",
    enabled: true,
    frameCount: 8,
    fps: 12,
    loop: true,
  })),
};
it("recommends a full sized sheet and keeps post-processing dimensions out of the prompt", () => {
  expect(spriteRecommendedSize(configuration)).toBe("2048x2048");
  expect(spriteSizeSummary(configuration)).toMatchObject({
    cellWidth: 256,
    cellHeight: 256,
    scale: 1,
  });
  expect(spritePlanPrompt(configuration)).not.toContain("256");
  expect(spritePlanPrompt(configuration)).toContain("2048x2048");
});
it("keeps guide aspect and distinguishes planned empty positions", () => {
  const guide = spriteLayoutGuideSvg(8, 2, "1600x800", 256, 256, [8, 4]);
  expect(guide).toContain('width="1536" height="768"');
  expect(guide.match(/fill="#d1d5db"/g)).toHaveLength(4);
  const auto = spriteLayoutGuideSvg(2, 2, "auto", 128, 256);
  expect(auto).toContain('width="1024" height="2048"');
});
