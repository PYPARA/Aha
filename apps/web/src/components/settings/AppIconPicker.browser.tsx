import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { SkinSnapshot, SkinAppIcon } from "@synara/contracts/ahaSkins";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import { DEFAULT_THEME_STATE } from "../../theme/theme.logic";
import { AhaAppearanceProvider, useAhaAppearance } from "../../aha/AppearanceProvider";
import { SettingsRow } from "./SettingsPanelPrimitives";
import { AppIconPicker } from "./AppIconPicker";
import { useDesktopAppIcon } from "../../hooks/useDesktopAppIcon";
import furinaIconUrl from "../../../../desktop/resources/aha/furina/icon.png?url";
import elationIconUrl from "../../../../desktop/resources/aha/elation/icon.png?url";

vi.mock("../../appSettings", () => ({
  useAppSettings: () => ({ settings: { desktopAppIcon: "default" }, updateSettings: vi.fn() }),
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ themeState: DEFAULT_THEME_STATE }),
  applyAhaThemeState: vi.fn(),
}));
let state: SkinSnapshot;
let announce: (value: SkinSnapshot) => void;
const setAppIcon = vi.fn<(value: SkinAppIcon) => Promise<SkinSnapshot>>();
const customId = "custom-00000000-0000-0000-0000-000000000001";
function PreviewControls() {
  const { previewSkin, iconUrl } = useAhaAppearance();
  return (
    <>
      <img src={iconUrl} alt="Applied icon" />
      <button
        onClick={() =>
          previewSkin({
            id: "synara-default",
            effectiveIconId: null,
            definition: state.skins[0]!.original,
          })
        }
      >
        Preview default
      </button>
      <button onClick={() => previewSkin(null)}>Cancel preview</button>
    </>
  );
}
function View() {
  useDesktopAppIcon();
  return (
    <AhaAppearanceProvider>
      <div style={{ width: 360 }}>
        <SettingsRow
          title="App icon"
          description="Switching skins updates the icon automatically. You can also choose one here."
        >
          <div className="pt-3">
            <AppIconPicker />
          </div>
        </SettingsRow>
      </div>
      <PreviewControls />
    </AhaAppearanceProvider>
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  const [png, furinaPng, elationPng] = await Promise.all(
    ["/aha-logo.png", furinaIconUrl, elationIconUrl].map(
      async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
    ),
  );
  const definition = {
    backgrounds: defaultAhaAppearance().backgrounds,
    palette: null,
    iconId: "a".repeat(64),
  };
  state = {
    revision: 0,
    activeId: "furina-chanson",
    appIconOverrideSkinId: null,
    effectiveIconId: "b".repeat(64),
    palette: null,
    warning: null,
    appearance: {
      preferences: { ...defaultAhaAppearance(), language: "en" },
      revision: 0,
      warning: null,
    },
    skins: [
      {
        id: "synara-default",
        name: "默认样式",
        origin: "builtin",
        original: definition,
        adjusted: definition,
        fingerprint: null,
      },
      {
        id: "aha-elation",
        name: "虚照·欢愉",
        origin: "builtin",
        original: { ...definition, iconId: "c".repeat(64) },
        adjusted: { ...definition, iconId: "c".repeat(64) },
        fingerprint: null,
      },
      {
        id: "furina-chanson",
        name: "芙宁娜·众水之歌",
        origin: "builtin",
        original: { ...definition, iconId: "b".repeat(64) },
        adjusted: { ...definition, iconId: "b".repeat(64) },
        fingerprint: null,
      },
      {
        id: customId,
        name: "Custom",
        origin: "custom",
        original: { ...definition, iconId: null },
        adjusted: { ...definition, iconId: null },
        fingerprint: null,
      },
    ],
  };
  setAppIcon.mockImplementation(async ({ skinId, revision }) => {
    expect(revision).toBe(state.revision);
    const selected = state.skins.find((skin) => skin.id === (skinId ?? state.activeId))!;
    state = {
      ...state,
      revision: revision + 1,
      appIconOverrideSkinId: skinId,
      effectiveIconId: selected.adjusted.iconId ?? definition.iconId,
    };
    announce(structuredClone(state));
    return structuredClone(state);
  });
  window.desktopBridge = {
    getAppIcon: vi.fn(),
    setAppIcon: vi.fn(),
    ahaAppearance: {
      get: async () => structuredClone(state.appearance),
      readImage: async (id: string) => ({
        id,
        mime: "image/png",
        bytes: id === "b".repeat(64) ? furinaPng : id === "c".repeat(64) ? elationPng : png,
      }),
      onChanged: () => () => {},
      skins: {
        list: async () => structuredClone(state),
        setAppIcon,
        onChanged: (listener: typeof announce) => {
          announce = listener;
          return () => {};
        },
      },
    },
  } as never;
});
it("lists every skin, changes only the icon, and restores following", async () => {
  const screen = await render(<View />);
  const defaults = screen.getByRole("button", { name: "Default app icon", exact: true });
  await expect.element(defaults).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "虚照·欢愉", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Custom", exact: true }))
    .toHaveTextContent("Uses default icon");
  expect(window.desktopBridge!.getAppIcon).not.toHaveBeenCalled();
  expect(window.desktopBridge!.setAppIcon).not.toHaveBeenCalled();
  await expect
    .poll(() =>
      Array.from(
        screen.getByRole("group", { name: "App icon" }).element().querySelectorAll("img"),
      ).every((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await screen
    .getByRole("group", { name: "App icon" })
    .screenshot({ path: "../../../../../.tmp/aha-app-icon-picker.png" });
  const before = structuredClone(state);
  await defaults.click();
  await expect.element(defaults).toHaveAttribute("aria-pressed", "true");
  expect(state.activeId).toBe(before.activeId);
  expect(state.appearance).toEqual(before.appearance);
  expect(state.skins).toEqual(before.skins);
  await screen.getByRole("button", { name: "Follow current skin", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "芙宁娜·众水之歌", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(state.appIconOverrideSkinId).toBeNull();
  expect(
    screen
      .getByRole("group", { name: "App icon" })
      .element()
      .querySelectorAll('[aria-pressed="true"]'),
  ).toHaveLength(1);
  // A narrow settings card must wrap its choices rather than overflow or clip them.
  const group = screen.getByRole("group", { name: "App icon" }).element();
  expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);
});
it("surfaces errors and allows retry without moving the selected indicator", async () => {
  const screen = await render(<View />);
  const defaults = screen.getByRole("button", { name: "Default app icon", exact: true });
  await expect.element(defaults).toBeVisible();
  setAppIcon.mockRejectedValueOnce(new Error("Native icon failed"));
  await defaults.click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Native icon failed");
  await expect.element(defaults).toHaveAttribute("aria-pressed", "false");
  await defaults.click();
  await expect.element(defaults).toHaveAttribute("aria-pressed", "true");
});
it("follows skin notifications, updates names and removals, and previews null as the default image", async () => {
  const screen = await render(<View />);
  await expect.element(screen.getByRole("button", { name: "Custom", exact: true })).toBeVisible();
  await expect
    .poll(() => screen.getByRole("img", { name: "Applied icon" }).element().getAttribute("src"))
    .toMatch(/^blob:/);
  await screen.getByRole("button", { name: "Preview default", exact: true }).click();
  await expect
    .element(screen.getByRole("img", { name: "Applied icon" }))
    .toHaveAttribute("src", "/aha-logo.png");
  expect(setAppIcon).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Cancel preview", exact: true }).click();
  await expect
    .poll(() => screen.getByRole("img", { name: "Applied icon" }).element().getAttribute("src"))
    .toMatch(/^blob:/);
  state = {
    ...state,
    activeId: "aha-elation",
    skins: state.skins
      .filter((s) => s.id !== "furina-chanson")
      .map((s) => (s.id === customId ? { ...s, name: "Renamed" } : s)),
  };
  announce(state);
  await expect
    .element(screen.getByRole("button", { name: "虚照·欢愉", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByRole("button", { name: "Renamed", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "芙宁娜·众水之歌", exact: true }))
    .not.toBeInTheDocument();
});
