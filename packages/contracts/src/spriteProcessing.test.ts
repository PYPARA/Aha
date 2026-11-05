import { it, expect } from "vitest";
import { spriteRecommendedSize, spritePlanIssues, spritePlanPrompt } from "./spritePlan";
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
it("no longer generates legacy sprite sheets for animation", () => {
  expect(spritePlanIssues(configuration)).toContain(
    "Sprite sheets are no longer generated. Confirm a character reference to generate actions as GIFs.",
  );
  expect(spritePlanPrompt(configuration)).toBe("A fox");
});
it("keeps static character requests and post-processing dimensions out of the prompt", () => {
  const character = { ...configuration, kind: "character" as const, mode: "separate" as const };
  expect(spriteRecommendedSize(character)).toBe("816x816");
  expect(spritePlanPrompt(character)).not.toContain("256");
  expect(spritePlanPrompt(character)).toContain("2048x2048");
  expect(spritePlanPrompt(character)).toContain("static sprite image");
});
