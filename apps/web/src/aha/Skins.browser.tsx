import "../index.css";
import { beforeEach, it, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { SkinSnapshot, SkinPreview, SkinDefinition } from "@synara/contracts/ahaSkins";
import type { AhaAppearanceBridge } from "@synara/contracts/ahaAppearance";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import { DEFAULT_THEME_STATE } from "../theme/theme.logic";
import { skinPaletteFromTheme } from "./skin-colors";
import { AhaAppearanceProvider } from "./AppearanceProvider";
import { AhaAppearancePanel } from "./AppearancePanel";
import { SynaraLogo } from "../components/SynaraLogo";

const mocks = vi.hoisted(() => ({
  theme: { state: null as unknown },
  apply: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ themeState: mocks.theme.state }),
  applyAhaThemeState: mocks.apply,
  previewAhaThemeState: mocks.preview,
  beginAhaThemePreview: vi.fn(),
  cancelAhaThemePreview: vi.fn(),
}));
vi.mock("../appSettings", () => ({ useAppSettings: () => ({ updateSettings: vi.fn() }) }));
let state: SkinSnapshot;
const id = "custom-00000000-0000-0000-0000-000000000001";
const palette = skinPaletteFromTheme(DEFAULT_THEME_STATE);
const preview = vi.fn<(id: string) => Promise<SkinPreview>>();
const apply = vi.fn();
const importPackage = vi.fn();
let png: Uint8Array;
function result(skinId: string): SkinPreview {
  const entry = state.skins.find((s) => s.id === skinId)!;
  return {
    id: skinId,
    definition: structuredClone(entry.adjusted),
    effectiveIconId: entry.adjusted.iconId ?? state.effectiveIconId,
  };
}
const view = () => (
  <AhaAppearanceProvider>
    <SynaraLogo role="img" aria-label="Aha brand" />
    <AhaAppearancePanel />
  </AhaAppearanceProvider>
);
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.theme.state = structuredClone(DEFAULT_THEME_STATE);
  png = new Uint8Array(await (await fetch("/aha-logo.png")).arrayBuffer());
  const current: SkinDefinition = {
    backgrounds: defaultAhaAppearance().backgrounds,
    palette: structuredClone(palette),
    iconId: null,
  };
  const furina = structuredClone(current);
  furina.iconId = "b".repeat(64);
  furina.palette!.dark.accent = "#68B9F0";
  furina.backgrounds.window = {
    ...furina.backgrounds.window,
    source: "image",
    imageId: "a".repeat(64),
  };
  state = {
    revision: 0,
    activeId: id,
    effectiveIconId: null,
    palette: palette,
    warning: null,
    appearance: {
      revision: 0,
      preferences: { ...defaultAhaAppearance(), clearMode: true },
      warning: null,
    },
    skins: [
      {
        id,
        name: "当前自定义外观",
        origin: "custom",
        original: current,
        adjusted: current,
        fingerprint: null,
      },
      {
        id: "aha-elation",
        name: "虚照·欢愉",
        origin: "builtin",
        original: current,
        adjusted: current,
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
  preview.mockImplementation(async (key) => result(key));
  apply.mockImplementation(async (input) => {
    state = {
      ...state,
      revision: state.revision + 1,
      activeId: input.id,
      effectiveIconId: input.definition.iconId ?? state.effectiveIconId,
      palette: input.definition.palette,
      appearance: {
        revision: state.appearance.revision + 1,
        preferences: input.preferences,
        warning: null,
      },
      skins: state.skins.map((s) => (s.id === input.id ? { ...s, adjusted: input.definition } : s)),
    };
    return structuredClone(state);
  });
  window.desktopBridge = {
    ahaAppearance: {
      get: async () => structuredClone(state.appearance),
      save: vi.fn(),
      readImage: async (key: string) => ({ id: key, mime: "image/png", bytes: png }),
      onChanged: () => () => {},
      skins: {
        list: async () => structuredClone(state),
        preview,
        apply,
        importPackage,
        importDirectory: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
        importIcon: vi.fn(),
        exportPackage: vi.fn(),
        reapplyIcon: vi.fn(),
        onChanged: () => () => {},
      },
    } as unknown as AhaAppearanceBridge,
  } as NonNullable<typeof window.desktopBridge>;
});
async function choose(screen: Awaited<ReturnType<typeof render>>, name = "芙宁娜·众水之歌") {
  await screen.getByRole("combobox", { name: "Skin library" }).click();
  await screen.getByRole("option", { name, exact: true }).click();
  await expect.poll(() => document.documentElement.dataset.ahaClear).toBe("false");
}
it("previews, cancels and applies without native apply during preview; clear mode leaves skin icon visible", async () => {
  const screen = await render(view());
  await expect.element(screen.getByRole("combobox", { name: "Skin library" })).toBeVisible();
  await choose(screen);
  expect(apply).not.toHaveBeenCalled();
  await expect
    .poll(() =>
      screen
        .getByRole("img", { name: "Aha brand" })
        .element()
        .querySelector("image")
        ?.getAttribute("href"),
    )
    .toMatch(/^blob:/);
  await screen.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => document.documentElement.dataset.ahaClear).toBe("true");
  await choose(screen);
  await screen.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => state.activeId).toBe("furina-chanson");
  expect(apply.mock.calls[0]![0].definition.palette.dark.accent).toBe("#68B9F0");
  await screen.getByRole("switch", { name: "Clear mode" }).click();
  await expect.poll(() => document.documentElement.dataset.ahaWindow).toBe("off");
  expect(
    screen
      .getByRole("img", { name: "Aha brand" })
      .element()
      .querySelector("image")
      ?.getAttribute("href"),
  ).toMatch(/^blob:/);
});
it("keeps imported skin in library after cancel and previews it again", async () => {
  importPackage.mockImplementation(async () => {
    const entry = structuredClone(state.skins[2]!);
    entry.id = "import-00000000-0000-0000-0000-000000000002";
    entry.origin = "imported";
    entry.name = "Imported blue";
    state = { ...state, revision: 1, skins: [...state.skins, entry] };
    return result(entry.id);
  });
  const screen = await render(view());
  await expect.element(screen.getByRole("combobox", { name: "Skin library" })).toBeVisible();
  await screen.getByRole("button", { name: "导入皮肤包", exact: true }).click();
  await expect.poll(() => document.documentElement.dataset.ahaClear).toBe("false");
  await screen.getByRole("button", { name: "取消", exact: true }).click();
  await choose(screen, "Imported blue");
  expect(state.activeId).toBe(id);
  expect(state.skins).toHaveLength(4);
});
it("ignores a late preview when leaving settings and preserves saved appearance on errors", async () => {
  const screen = await render(view());
  await expect.element(screen.getByRole("combobox", { name: "Skin library" })).toBeVisible();
  preview.mockRejectedValueOnce(new Error("Missing skin asset"));
  await screen.getByRole("button", { name: "预览皮肤", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Missing skin asset");
  expect(apply).not.toHaveBeenCalled();
  let release: ((value: SkinPreview) => void) | undefined;
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await screen.getByRole("button", { name: "预览皮肤", exact: true }).click();
  await screen.unmount();
  release?.(result("furina-chanson"));
  await expect.poll(() => document.documentElement.dataset.ahaClear).toBe("true");
  expect(apply).not.toHaveBeenCalled();
});
