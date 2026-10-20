// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { describe, expect, it } from "vitest";
import { resolveMigrationLineageFamily, resolveReleaseTags } from "./check-migration-lineage";
describe("migration lineage guard", () => {
  it("checks every release tag, newest first, and degrades to an empty list", () => {
    // Users skip versions: a database is wedged by the release it was created
    // under, not by the newest one.
    expect(resolveReleaseTags(() => ["v0.6.0", "v0.5.5", "v0.5.4"], "shared")).toEqual([
      "v0.6.0",
      "v0.5.5",
      "v0.5.4",
    ]);
    expect(resolveReleaseTags(() => [])).toEqual([]);
  });
  it.each([
    ["1.0.5", "shared"],
    ["1.0.6-beta.1", "shared"],
    ["1.0.6-remote.14", "remote"],
  ] as const)("derives %s history from matching package metadata", (version, family) => {
    expect(resolveMigrationLineageFamily(version, version)).toBe(family);
  });
  it.each([
    [undefined, undefined],
    ["", ""],
    ["1.0.5", "1.0.6"],
    ["1.0.6-beta.1", "1.0.6-remote.1"],
    ["1.0.6-other.1", "1.0.6-other.1"],
    ["1.0.6-remote", "1.0.6-remote"],
  ])("refuses ambiguous package metadata %s / %s", (serverVersion, desktopVersion) => {
    expect(() => resolveMigrationLineageFamily(serverVersion, desktopVersion)).toThrow();
  });
  it.each([
    ["shared", ["v1.0.6-beta.1", "v1.0.5", "v0.0.18.1"]],
    ["remote", ["v1.0.6-remote.14", "v1.0.6-remote.8"]],
  ] as const)(
    "checks every tag in the %s database family without dropping legacy history",
    (family, expected) => {
      expect(
        resolveReleaseTags(
          () => ["v1.0.6-remote.14", "v1.0.6-remote.8", "v1.0.6-beta.1", "v1.0.5", "v0.0.18.1"],
          family,
        ),
      ).toEqual(expected);
    },
  );
});
