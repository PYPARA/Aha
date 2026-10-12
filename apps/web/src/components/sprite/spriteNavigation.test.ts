import { expect, it } from "vitest";
import {
  normalizeRailItemOrder,
  railItemForPathname,
  railItemShowsPanel,
  buildRailItemOrder,
} from "~/appRail.logic";
it("adds the sprite rail item after Drawing without moving existing user items", () => {
  const order = normalizeRailItemOrder([
    "spaces",
    "home",
    "drawing",
    "tasks",
    "inbox",
    "kanban",
    "pullRequests",
    "automations",
    "studio",
  ]);
  expect(order.slice(0, 6)).toEqual([
    "spaces",
    "home",
    "drawing",
    "spriteAnimation",
    "resources",
    "tasks",
  ]);
  expect(railItemForPathname("/sprite-animation")).toBe("spriteAnimation");
  expect(railItemShowsPanel("spriteAnimation")).toBe(false);
  expect(
    buildRailItemOrder({
      order,
      hidden: new Set(["spriteAnimation"]),
      activeItem: "home",
      studioAvailable: true,
      inboxAvailable: true,
    }),
  ).not.toContain("spriteAnimation");
  expect(
    buildRailItemOrder({
      order,
      hidden: new Set(["spriteAnimation"]),
      activeItem: "spriteAnimation",
      studioAvailable: true,
      inboxAvailable: true,
    }),
  ).toContain("spriteAnimation");
});
