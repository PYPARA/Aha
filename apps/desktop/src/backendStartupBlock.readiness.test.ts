// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { describe, expect, it } from "vitest";
import { BackendStartupBlockDetector } from "./backendStartupBlock";
describe("BackendStartupBlockDetector", () => {
  it("ignores output that arrives after readiness froze the detector", () => {
    const detector = new BackendStartupBlockDetector();
    detector.push("server ready\n");
    detector.freeze();
    detector.push("DatabaseLifecycleLockedError: refusing concurrent database access\n");
    detector.push(Buffer.from("MigrationRecoveryRequiredError: late\n", "utf8"), "stderr");
    detector.end("stdout");
    detector.end("stderr");
    expect(detector.read()).toBeNull();
  });
  it("keeps a classification made before readiness after freezing", () => {
    const detector = new BackendStartupBlockDetector();
    detector.push("MigrationRecoveryRequiredError: Migration recovery is required");
    detector.freeze();
    detector.freeze();
    detector.push("Error: address already in use\n");
    expect(detector.read()).toEqual({ kind: "migration-recovery-required" });
  });
});
