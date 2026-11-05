import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { ImageAsset } from "@synara/contracts";
import { previewAhaThemeState } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { SpriteImageDialog } from "./SpriteImageDialog";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({ imageUrl: (asset: ImageAsset) => `/${asset.id}` }));
afterEach(async () => {
  await cleanup();
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }));
});
const asset = (id: string, width: number, height: number, frames?: number): ImageAsset => ({
  id,
  name: `${id}.${frames ? "gif" : "png"}`,
  mimeType: frames ? "image/gif" : "image/png",
  url: `/${id}`,
  thumbnailUrl: `/${id}`,
  width,
  height,
  bytes: 100,
  createdAt: "2026-11-05T00:00:00Z",
  ...(frames ? { animation: { frameCount: frames, durationMs: frames * 80 } } : {}),
});
it("plays the generated GIF first and switches to its expanded frames", async () => {
  await page.viewport(430, 900);
  await render(
    <SpriteImageDialog
      asset={asset("walk", 512, 512, 10)}
      frames={asset("walk-frames", 2560, 1024)}
      onClose={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "GIF animation" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByText("512 × 512 · 10 frames · 800ms")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "walk.gif" })).toHaveAttribute("src", "/walk");
  await page.getByRole("button", { name: "Expanded frames" }).click();
  await expect.element(page.getByText("2560 × 1024", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("img", { name: "walk-frames.png" }))
    .toHaveAttribute("src", "/walk-frames");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-gif-original-dark.png" });
});
it("shows still images without the animation switch", async () => {
  await render(<SpriteImageDialog asset={asset("sheet", 1152, 576)} onClose={() => {}} />);
  await expect.element(page.getByText("1152 × 576", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "GIF animation" })).not.toBeInTheDocument();
});
