// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { describe, expect, it } from "vitest";
import { isLiveThreadStreamDelivering } from "./threadDetailCatchupPolicy";
describe("isLiveThreadStreamDelivering", () => {
  it("is false before the thread stream applied any event", () => {
    expect(isLiveThreadStreamDelivering(null, 10000, 1500)).toBe(false);
  });
  it("is true only while the last live event is inside the window", () => {
    expect(isLiveThreadStreamDelivering(9000, 10000, 1500)).toBe(true);
    expect(isLiveThreadStreamDelivering(8500, 10000, 1500)).toBe(false);
  });
});
