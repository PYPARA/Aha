import "../index.css";
import { beforeEach, afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import {
  useTheme,
  previewAhaThemeState,
  applyAhaThemeState,
  beginAhaThemePreview,
  cancelAhaThemePreview,
} from "../hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "../theme/theme.logic";
const view = () => <Probe />;
function Probe() {
  const theme = useTheme();
  return (
    <div>
      <output data-testid="surface">{theme.themeState.chromeThemes.dark.surface}</output>
      <output data-testid="mode">{theme.theme}</output>
      <button onClick={() => theme.updateThemePack("dark", { surface: "#123456" })}>
        Edit color
      </button>
      <button onClick={() => theme.setTheme("light")}>Global light mode</button>
      <button onClick={() => theme.updateThemeFonts("dark", { ui: "Custom" })}>Global font</button>
      <button onClick={() => theme.setCodeThemeId("dark", "github")}>Global code theme</button>
    </div>
  );
}
beforeEach(() => {
  delete window.desktopBridge;
  cancelAhaThemePreview();
  applyAhaThemeState(serializeThemeState(DEFAULT_THEME_STATE));
});
afterEach(() => {
  cancelAhaThemePreview();
});
it("exposes preview colors to the actual theme editor without saving them, and cancels", async () => {
  const screen = await render(view());
  const state = structuredClone(DEFAULT_THEME_STATE);
  state.chromeThemes.dark.surface = "#0b172a";
  previewAhaThemeState(serializeThemeState(state));
  await expect.element(screen.getByTestId("surface")).toHaveTextContent("#0b172a");
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.surface).toBe(
    DEFAULT_THEME_STATE.chromeThemes.dark.surface,
  );
  await screen.getByRole("button", { name: "Edit color" }).click();
  await expect.element(screen.getByTestId("surface")).toHaveTextContent("#123456");
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.surface).toBe(
    DEFAULT_THEME_STATE.chromeThemes.dark.surface,
  );
  cancelAhaThemePreview();
  await expect
    .element(screen.getByTestId("surface"))
    .toHaveTextContent(DEFAULT_THEME_STATE.chromeThemes.dark.surface);
});
it("persists global mode and typography during preview, keeps colors transient, then commits", async () => {
  const screen = await render(view());
  beginAhaThemePreview();
  await screen.getByRole("button", { name: "Edit color" }).click();
  await screen.getByRole("button", { name: "Global light mode" }).click();
  await screen.getByRole("button", { name: "Global font" }).click();
  let stored = JSON.parse(localStorage.getItem("synara:theme")!);
  expect(stored.mode).toBe("light");
  expect(stored.chromeThemes.dark.fonts.ui).toBe("Custom");
  expect(stored.chromeThemes.dark.surface).toBe(DEFAULT_THEME_STATE.chromeThemes.dark.surface);
  cancelAhaThemePreview();
  await expect.element(screen.getByTestId("mode")).toHaveTextContent("light");
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.fonts.ui).toBe(
    "Custom",
  );
  beginAhaThemePreview();
  await screen.getByRole("button", { name: "Edit color" }).click();
  stored = JSON.parse(localStorage.getItem("synara:theme")!);
  stored.chromeThemes.dark.surface = "#123456";
  applyAhaThemeState(JSON.stringify(stored));
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.surface).toBe(
    "#123456",
  );
});
