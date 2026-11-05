import { describe, expect, it } from "vitest";
import { strongestEffort, withStrongestEffort } from "./gen3dModelEffort";

describe("gen3d reasoning effort", () => {
  it("picks the strongest known effort", () => {
    expect(strongestEffort(["low", "medium", "high", "xhigh", "max"])).toBe("max");
    expect(strongestEffort(["medium", "high", "xhigh"])).toBe("xhigh");
    expect(strongestEffort(["custom-early-access"])).toBeNull();
  });
  it("raises a Codex selection to the model's discovered maximum", () => {
    const selection = {
      provider: "codex",
      model: "gpt-6.1-sol",
      options: { reasoningEffort: "medium", fastMode: false },
    } as const;
    const raised = withStrongestEffort(
      selection as never,
      {
        slug: "gpt-6.1-sol",
        supportedReasoningEfforts: [{ value: "medium" }, { value: "high" }, { value: "max" }],
      } as never,
    );
    expect(raised).toMatchObject({ options: { reasoningEffort: "max", fastMode: false } });
  });
  it("leaves providers without an effort ladder unchanged", () => {
    const selection = { provider: "cursor", model: "x" } as never;
    expect(withStrongestEffort(selection, undefined)).toBe(selection);
  });
});
