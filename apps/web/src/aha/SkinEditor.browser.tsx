import "../index.css";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import type { SkinSnapshot, SkinApply } from "@synara/contracts/ahaSkins";
import { DEFAULT_THEME_STATE, serializeThemeState } from "../theme/theme.logic";
import { useTheme, applyAhaThemeState, cancelAhaThemePreview } from "../hooks/useTheme";
import { skinPaletteFromTheme } from "./skin-colors";
import { AhaAppearancePanel } from "./AppearancePanel";
import { AhaAppearanceProvider, useAhaAppearance } from "./AppearanceProvider";
vi.mock("../appSettings", () => ({ useAppSettings: () => ({ updateSettings: vi.fn() }) }));
let state: SkinSnapshot;
const apply = vi.fn<(value: SkinApply) => Promise<SkinSnapshot>>();
const custom = "custom-00000000-0000-0000-0000-000000000003";
function Editor() {
  const theme = useTheme();
  return (
    <div>
      <output data-testid="preview-color">{theme.themeState.chromeThemes.dark.surface}</output>
      <button onClick={() => theme.updateThemePack("dark", { surface: "#123456" })}>
        Adjust color
      </button>
      <button onClick={() => theme.setTheme("light")}>Keep global light</button>
    </div>
  );
}
function ResettableEditor() {
  const { restoreDefaultSkin } = useAhaAppearance();
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState("");
  return (
    <>
      <button
        onClick={async () => {
          setEpoch((value) => value + 1);
          try {
            await restoreDefaultSkin();
            setEpoch((value) => value + 1);
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        Restore default style
      </button>
      <output data-testid="reset-error">{error}</output>
      <AhaAppearancePanel key={epoch} />
      <Editor />
    </>
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  cancelAhaThemePreview();
  applyAhaThemeState(serializeThemeState(DEFAULT_THEME_STATE));
  const png = new Uint8Array(await (await fetch("/aha-logo.png")).arrayBuffer());
  const original = {
    backgrounds: defaultAhaAppearance().backgrounds,
    palette: skinPaletteFromTheme(DEFAULT_THEME_STATE),
    iconId: null,
  };
  const furina = structuredClone(original);
  furina.palette.dark.surface = "#0b172a";
  state = {
    revision: 0,
    activeId: custom,
    effectiveIconId: null,
    appIconOverrideSkinId: null,
    palette: original.palette,
    warning: null,
    appearance: { preferences: defaultAhaAppearance(), revision: 0, warning: null },
    skins: [
      {
        id: "synara-default",
        name: "默认样式",
        origin: "builtin",
        original: { ...original, iconId: "a".repeat(64) },
        adjusted: {
          ...original,
          iconId: "a".repeat(64),
          palette: { ...original.palette, dark: { ...original.palette.dark, surface: "#654321" } },
        },
        fingerprint: null,
      },
      {
        id: custom,
        name: "当前自定义外观",
        origin: "custom",
        original,
        adjusted: original,
        fingerprint: null,
      },
      {
        id: "furina-chanson",
        name: "芙宁娜·众水之歌",
        origin: "builtin",
        original: furina,
        adjusted: furina,
        fingerprint: null,
      },
    ],
  };
  apply.mockImplementation(async (value) => {
    state = {
      ...state,
      revision: state.revision + 1,
      activeId: value.id,
      palette: value.definition.palette,
      effectiveIconId: value.definition.iconId,
      appearance: { ...state.appearance, preferences: value.preferences },
      skins: state.skins.map((s) => (s.id === value.id ? { ...s, adjusted: value.definition } : s)),
    };
    return structuredClone(state);
  });
  window.desktopBridge = {
    setTheme: async () => {},
    setWindowMaterial: async () => true,
    ahaAppearance: {
      get: async () => structuredClone(state.appearance),
      readImage: async (id: string) => ({ id, mime: "image/png", bytes: png }),
      onChanged: () => () => {},
      skins: {
        list: async () => structuredClone(state),
        onChanged: () => () => {},
        preview: async (id: string) => {
          const entry = state.skins.find((s) => s.id === id)!;
          return {
            id,
            definition: structuredClone(entry.adjusted),
            effectiveIconId: entry.adjusted.iconId ?? state.effectiveIconId,
          };
        },
        apply,
        importIcon: async () => ({ id: "c".repeat(64) }),
      },
    },
  } as never;
});
afterEach(() => cancelAhaThemePreview());
it("keeps preview colors when adding an icon, cancels edits, and applies adjustments without undoing global mode", async () => {
  const screen = await render(
    <AhaAppearanceProvider>
      <AhaAppearancePanel />
      <Editor />
    </AhaAppearanceProvider>,
  );
  await expect.element(screen.getByRole("radiogroup", { name: "Skin library" })).toBeVisible();
  await screen.getByRole("radio", { name: "芙宁娜·众水之歌" }).click();
  await expect.element(screen.getByTestId("preview-color")).toHaveTextContent("#0b172a");
  await screen.getByRole("button", { name: "更换图标" }).click();
  await expect.element(screen.getByTestId("preview-color")).toHaveTextContent("#0b172a");
  await screen.getByRole("button", { name: "Adjust color" }).click();
  await screen.getByRole("button", { name: "Keep global light" }).click();
  await screen.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .element(screen.getByTestId("preview-color"))
    .toHaveTextContent(DEFAULT_THEME_STATE.chromeThemes.dark.surface);
  expect(JSON.parse(localStorage.getItem("synara:theme")!).mode).toBe("light");
  expect(apply).not.toHaveBeenCalled();
  await screen.getByRole("radio", { name: "芙宁娜·众水之歌" }).click();
  await screen.getByRole("button", { name: "Adjust color" }).click();
  await screen.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => state.activeId).toBe("furina-chanson");
  expect(state.palette?.dark.surface).toBe("#123456");
  await screen.unmount();
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.surface).toBe(
    "#123456",
  );
  expect(JSON.parse(localStorage.getItem("synara:theme")!).mode).toBe("light");
});
it("restores the original default style from a preview and keeps global settings and other skins", async () => {
  const screen = await render(
    <AhaAppearanceProvider>
      <ResettableEditor />
    </AhaAppearanceProvider>,
  );
  await screen.getByRole("radio", { name: "芙宁娜·众水之歌" }).click();
  await screen.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => state.activeId).toBe("furina-chanson");
  const savedFurina = structuredClone(state.skins.find((skin) => skin.id === "furina-chanson"));
  await screen.getByRole("radio", { name: "默认样式", exact: true }).click();
  await expect.element(screen.getByTestId("preview-color")).toHaveTextContent("#654321");
  await screen.getByRole("button", { name: "Keep global light" }).click();
  await screen.getByRole("button", { name: "Restore default style", exact: true }).click();
  await expect.poll(() => state.activeId).toBe("synara-default");
  await expect.element(screen.getByTestId("preview-color")).toHaveTextContent("#111111");
  expect(state.palette).toEqual(skinPaletteFromTheme(DEFAULT_THEME_STATE));
  expect(state.appearance.preferences.backgrounds).toEqual(defaultAhaAppearance().backgrounds);
  expect(state.effectiveIconId).toBe("a".repeat(64));
  expect(state.skins.find((skin) => skin.id === "furina-chanson")).toEqual(savedFurina);
  expect(JSON.parse(localStorage.getItem("synara:theme")!).mode).toBe("light");
  await screen.unmount();
  expect(JSON.parse(localStorage.getItem("synara:theme")!).chromeThemes.dark.surface).toBe(
    "#111111",
  );
});
it("keeps the applied appearance when restoring the default style fails", async () => {
  const screen = await render(
    <AhaAppearanceProvider>
      <ResettableEditor />
    </AhaAppearanceProvider>,
  );
  await screen.getByRole("radio", { name: "芙宁娜·众水之歌" }).click();
  await screen.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => state.activeId).toBe("furina-chanson");
  const saved = structuredClone(state);
  apply.mockRejectedValueOnce(new Error("native icon failed"));
  await screen.getByRole("button", { name: "Restore default style", exact: true }).click();
  await expect.element(screen.getByTestId("reset-error")).toHaveTextContent("native icon failed");
  expect(state).toEqual(saved);
  await expect.element(screen.getByTestId("preview-color")).toHaveTextContent("#0b172a");
});
