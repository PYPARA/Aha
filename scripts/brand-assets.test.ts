import { expect, it } from "vitest";
import { desktopIconAssetPaths, publishIconOverrides } from "./lib/brand-assets";

it("uses the default A icon for desktop and web assets in every packaged flavor", () => {
  for (const flavor of ["production", "beta"] as const) {
    expect(desktopIconAssetPaths(flavor).macIconPng).toBe("assets/aha/default/icon.png");
    expect(desktopIconAssetPaths(flavor).windowsIconIco).toBe("assets/aha/default/icon.ico");
    for (const override of publishIconOverrides(flavor))
      expect(override.sourceRelativePath).toMatch(/^assets\/aha\/default\//);
  }
});
