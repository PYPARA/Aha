import { describe, expect, it } from "vitest";
import {
  normalizeRailItemOrder,
  railItemForPathname,
  railItemShowsPanel,
  buildRailItemOrder,
} from "~/appRail.logic";
describe("resource center navigation", () => {
  it("places the new destination after sprite animation for saved and fresh rail orders", () => {
    for (const saved of [[], ["home", "spaces", "inbox"], ["drawing", "home", "spaces"]]) {
      const result = normalizeRailItemOrder(saved);
      expect(result.indexOf("resources")).toBe(result.indexOf("spriteAnimation") + 1);
      expect(new Set(result).size).toBe(result.length);
    }
  });
  it("preserves a customized resource position and recognizes its full-width route", () => {
    expect(normalizeRailItemOrder(["resources", "home", "drawing"])[0]).toBe("resources");
    expect(railItemForPathname("/resources")).toBe("resources");
    expect(railItemForPathname("/resources-extra")).toBeNull();
    expect(railItemShowsPanel("resources")).toBe(false);
  });
  it("keeps a hidden resource destination visible while it is active", () => {
    expect(
      buildRailItemOrder({
        order: ["home", "resources"],
        hidden: new Set(["resources"]),
        activeItem: "resources",
        studioAvailable: true,
        inboxAvailable: true,
      }),
    ).toContain("resources");
  });
});
