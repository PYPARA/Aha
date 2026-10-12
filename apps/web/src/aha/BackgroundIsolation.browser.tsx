import "../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import { AhaAppearanceProvider, useAhaAppearance } from "./AppearanceProvider";
import { AhaBackgroundLayer } from "./BackgroundLayer";
import { DEFAULT_THEME_STATE } from "../theme/theme.logic";
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ themeState: DEFAULT_THEME_STATE }),
  applyAhaThemeState: vi.fn(),
}));
function Probe() {
  const { preview, snapshot } = useAhaAppearance();
  return (
    <div data-aha-region="window" style={{ width: 500, height: 300 }}>
      <AhaBackgroundLayer />
      <div data-aha-region="content" style={{ width: 250, height: 200 }}>
        <AhaBackgroundLayer />
        <div data-aha-region="composer">
          <AhaBackgroundLayer />
          <input aria-label="Message" />
        </div>
        <button onClick={() => preview({ ...snapshot.preferences, clearMode: true })}>Clear</button>
        <button onClick={() => preview(defaultAhaAppearance())}>Default</button>
      </div>
    </div>
  );
}
it("projects inherit independently, keeps local solid bases and restores upstream material in clear/default modes", async () => {
  const preferences = defaultAhaAppearance();
  preferences.backgrounds.window = {
    ...preferences.backgrounds.window,
    source: "image",
    imageId: "a".repeat(64),
    opacity: 0.5,
    overlay: 0,
    blur: 12,
  };
  preferences.backgrounds.content.source = "inherit";
  preferences.backgrounds.composer.source = "solid";
  const bytes = new Uint8Array(await (await fetch("/aha-logo.png")).arrayBuffer());
  window.desktopBridge = {
    ahaAppearance: {
      get: async () => ({ preferences, revision: 0, warning: null }),
      readImage: async () => ({ id: "a".repeat(64), mime: "image/png", bytes }),
      onChanged: () => () => {},
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;
  const screen = await render(
    <AhaAppearanceProvider>
      <Probe />
    </AhaAppearanceProvider>,
  );
  await expect.poll(() => document.documentElement.dataset.ahaBackgrounds).toBe("true");
  const root = document.documentElement;
  expect(root.style.getPropertyValue("--aha-content-image")).toBe(
    root.style.getPropertyValue("--aha-window-image"),
  );
  expect(root.style.getPropertyValue("--aha-composer-image")).toBe("none");
  const layer = document.querySelector('[data-aha-region="composer"] > .aha-background-layer')!;
  expect(getComputedStyle(layer).display).toBe("block");
  expect(getComputedStyle(layer).pointerEvents).toBe("none");
  expect(getComputedStyle(layer).overflow).toBe("hidden");
  await screen.getByRole("textbox", { name: "Message" }).fill("Unblocked input");
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Unblocked input");
  await screen.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.poll(() => root.dataset.ahaBackgrounds).toBe("false");
  expect(getComputedStyle(layer).display).toBe("none");
  await screen.getByRole("button", { name: "Default", exact: true }).click();
  await expect.poll(() => root.dataset.ahaClear).toBe("false");
  expect(root.dataset.ahaBackgrounds).toBe("false");
  expect(getComputedStyle(layer).display).toBe("none");
});
