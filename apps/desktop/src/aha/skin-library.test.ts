import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, it, expect, vi } from "vitest";
import { SkinLibrary, type SkinLibraryOptions } from "./skin-library";
import { AhaAppearanceStore } from "./appearance-store";
import { BUILTIN_PALETTES } from "./skin-palettes";
import { imageHash, normalizeImage } from "./appearance-images";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import type { SkinDefinition, SkinPreview } from "@synara/contracts/ahaSkins";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<SkinLibraryOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aha-skins-test-"));
  dirs.push(dir);
  const appearance = new AhaAppearanceStore(join(dir, "aha-appearance.json"));
  await appearance.load();
  const preferences = {
    ...defaultAhaAppearance(),
    language: "en" as const,
    uiWeight: "700" as const,
  };
  await appearance.save(preferences, 0);
  const applyIcon = vi.fn(
    async (_id: string | null, _images: import("./appearance-images").AppearanceImages) => {},
  );
  const root = resolve(import.meta.dirname, "../../../..");
  const options: SkinLibraryOptions = {
    builtinDirectory: (id) =>
      join(root, "apps/desktop/resources/aha", id === "aha-elation" ? "elation" : "furina"),
    defaultIcon: () => join(root, "assets/aha/default/icon.png"),
    applyIcon,
    ...overrides,
  };
  const library = new SkinLibrary(join(dir, "aha-skins.json"), appearance, options);
  await library.load();
  await library.list(BUILTIN_PALETTES["aha-elation"]);
  return { dir, appearance, options, library, applyIcon, preferences };
}
const apply = (
  library: SkinLibrary,
  preview: SkinPreview,
  preferences = library.snapshot().appearance.preferences,
) =>
  library.apply({
    id: preview.id,
    revision: library.snapshot().revision,
    definition: preview.definition,
    preferences: { ...preferences, backgrounds: preview.definition.backgrounds },
  });
async function packageFile(dir: string, definition: SkinDefinition, name = "Test") {
  const file = join(dir, `${name}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 4, name, skin: definition, images: [] }));
  return file;
}
describe("Aha skin library", () => {
  it("preserves existing appearance and original file, initializes only once, lists all built-ins", async () => {
    const { library, appearance, preferences, dir, options } = await fixture();
    expect(library.snapshot().appearance.preferences).toEqual(preferences);
    expect(library.snapshot().skins.map((s) => s.id)).toEqual(
      expect.arrayContaining(["synara-default", "aha-elation", "furina-chanson"]),
    );
    expect(await readFile(`${appearance.file}.before-skins`, "utf8")).toBe(
      await readFile(appearance.file, "utf8"),
    );
    const restarted = new SkinLibrary(join(dir, "aha-skins.json"), appearance, options);
    await restarted.load();
    const initial = restarted.snapshot();
    await restarted.list(BUILTIN_PALETTES["furina-chanson"]);
    expect(restarted.snapshot()).toEqual(initial);
  });
  it("switches to the unskinned defaults with the Aha icon, restores original colors, and survives restart", async () => {
    const { library, appearance, dir, options, applyIcon } = await fixture();
    const furina = await library.preview("furina-chanson");
    furina.definition.backgrounds.window.opacity = 0.3;
    await apply(library, furina);
    const previousFile = JSON.parse(await readFile(library.file, "utf8"));
    previousFile.skins = previousFile.skins.filter(
      (skin: { id: string }) => skin.id !== "synara-default",
    );
    await writeFile(library.file, JSON.stringify(previousFile));
    const upgraded = new SkinLibrary(library.file, appearance, options);
    await upgraded.load();
    expect(upgraded.snapshot()).toMatchObject({
      activeId: library.snapshot().activeId,
      effectiveIconId: library.snapshot().effectiveIconId,
      palette: library.snapshot().palette,
      appearance: library.snapshot().appearance,
    });
    expect((await upgraded.preview("synara-default")).definition.palette).toEqual(
      BUILTIN_PALETTES["synara-default"],
    );
    const defaults = await library.preview("synara-default");
    expect(defaults.definition.backgrounds).toEqual(defaultAhaAppearance().backgrounds);
    expect(defaults.definition.palette).toEqual(BUILTIN_PALETTES["synara-default"]);
    expect(defaults.effectiveIconId).not.toBe(furina.effectiveIconId);
    defaults.definition.palette!.dark.surface = "#123456";
    await apply(library, defaults);
    expect(applyIcon.mock.calls.at(-1)?.[0]).toBe(defaults.effectiveIconId);
    const original = library
      .snapshot()
      .skins.find((skin) => skin.id === "synara-default")!.original;
    await library.apply({
      id: "synara-default",
      revision: library.snapshot().revision,
      definition: original,
      preferences: {
        ...library.snapshot().appearance.preferences,
        backgrounds: original.backgrounds,
      },
    });
    expect(library.snapshot().palette).toEqual(BUILTIN_PALETTES["synara-default"]);
    expect((await library.preview("furina-chanson")).definition.backgrounds.window.opacity).toBe(
      0.3,
    );
    const restarted = new SkinLibrary(join(dir, "aha-skins.json"), appearance, options);
    await restarted.load();
    expect(restarted.snapshot()).toEqual(library.snapshot());
    expect(restarted.snapshot().activeId).toBe("synara-default");
    expect(restarted.snapshot().appearance.preferences.language).toBe("en");
    expect(restarted.snapshot().appearance.preferences.uiWeight).toBe("700");
    await expect(
      restarted.remove("synara-default", restarted.snapshot().revision),
    ).rejects.toThrow();
  });
  it("previews without persisting, remembers per-skin changes and restores after restart", async () => {
    const { library, appearance, dir, options } = await fixture();
    const before = library.snapshot();
    const furina = await library.preview("furina-chanson");
    expect(library.snapshot()).toEqual(before);
    furina.definition.backgrounds.window.opacity = 0.31;
    await apply(library, furina);
    await apply(library, await library.preview("aha-elation"));
    expect((await library.preview("furina-chanson")).definition.backgrounds.window.opacity).toBe(
      0.31,
    );
    await apply(library, await library.preview("furina-chanson"));
    const restarted = new SkinLibrary(join(dir, "aha-skins.json"), appearance, options);
    await restarted.load();
    expect(restarted.snapshot()).toEqual(library.snapshot());
    expect(restarted.snapshot().appearance.preferences.language).toBe("en");
    expect(restarted.snapshot().appearance.preferences.uiWeight).toBe("700");
  });
  it("imports immediately, deduplicates content and gives different same-name skins unique names", async () => {
    const { library, dir } = await fixture();
    const initial = library.snapshot().activeId;
    const definition: SkinDefinition = {
      backgrounds: defaultAhaAppearance().backgrounds,
      palette: BUILTIN_PALETTES["furina-chanson"]!,
      iconId: null,
    };
    const file = await packageFile(dir, definition);
    const first = await library.importPackage(file);
    expect(library.snapshot().activeId).toBe(initial);
    expect((await library.importPackage(file)).id).toBe(first.id);
    definition.backgrounds.window.opacity = 0.33;
    const second = await library.importPackage(await packageFile(dir, definition));
    expect(second.id).not.toBe(first.id);
    expect(library.snapshot().skins.find((s) => s.id === second.id)?.name).toBe("Test (2)");
  });
  it("uses the default icon for icon-less skins and persists it across restarts", async () => {
    const { library, dir, appearance, options } = await fixture();
    await apply(library, await library.preview("furina-chanson"));
    const defaultIcon = (await library.preview("synara-default")).effectiveIconId;
    const definition: SkinDefinition = {
      backgrounds: defaultAhaAppearance().backgrounds,
      palette: BUILTIN_PALETTES["aha-elation"]!,
      iconId: null,
    };
    const imported = await library.importPackage(await packageFile(dir, definition));
    expect(imported.effectiveIconId).toBe(defaultIcon);
    await apply(library, imported);
    const restarted = new SkinLibrary(join(dir, "aha-skins.json"), appearance, options);
    await restarted.load();
    expect(restarted.snapshot().effectiveIconId).toBe(defaultIcon);
    await apply(library, await library.preview("aha-elation"));
    await apply(library, await library.preview(imported.id));
    expect(library.snapshot().effectiveIconId).toBe(defaultIcon);
  });
  it("validates revision and resources before native changes, and rolls back icons if atomic save fails", async () => {
    const { library, applyIcon, dir } = await fixture();
    const furina = await library.preview("furina-chanson"),
      before = library.snapshot();
    await expect(
      library.apply({
        id: furina.id,
        revision: 999,
        definition: furina.definition,
        preferences: before.appearance.preferences,
      }),
    ).rejects.toThrow("changed");
    const bad = structuredClone(furina);
    bad.definition.iconId = "f".repeat(64);
    await expect(apply(library, bad)).rejects.toThrow();
    expect(applyIcon).not.toHaveBeenCalled();
    await rm(library.file);
    await mkdir(library.file);
    await expect(apply(library, furina)).rejects.toThrow();
    expect(library.snapshot()).toEqual(before);
    expect(applyIcon.mock.calls).toHaveLength(2);
    expect(applyIcon.mock.calls[1]?.[0]).toBe(before.effectiveIconId);
    expect(await readFile(join(dir, "aha-appearance.json"), "utf8")).toContain('"language":"en"');
  });
  it("does not save selection when native icon application fails", async () => {
    const { library, applyIcon } = await fixture();
    const before = library.snapshot();
    applyIcon.mockRejectedValueOnce(new Error("native failed"));
    await expect(apply(library, await library.preview("furina-chanson"))).rejects.toThrow(
      "native failed",
    );
    expect(library.snapshot()).toEqual(before);
  });
  it("supports rename and delete while protecting built-in and active skins", async () => {
    const { library, dir } = await fixture();
    const imported = await library.importPackage(
      await packageFile(dir, {
        backgrounds: defaultAhaAppearance().backgrounds,
        palette: null,
        iconId: null,
      }),
    );
    await library.rename(imported.id, "Mine", library.snapshot().revision);
    expect(library.snapshot().skins.find((s) => s.id === imported.id)?.name).toBe("Mine");
    await expect(library.remove("aha-elation", library.snapshot().revision)).rejects.toThrow();
    await apply(library, await library.preview(imported.id));
    await expect(library.remove(imported.id, library.snapshot().revision)).rejects.toThrow(
      "Switch",
    );
    await apply(library, await library.preview("aha-elation"));
    await library.remove(imported.id, library.snapshot().revision);
    expect(library.snapshot().skins.some((s) => s.id === imported.id)).toBe(false);
  });
  it("exports six validated images with adjusted colors and imports a portable v4 package", async () => {
    const { library, dir } = await fixture();
    const furina = await library.preview("furina-chanson");
    furina.definition.palette!.dark.accent = "#69BBDD";
    // A temporarily disabled background retains its image for a later switch back.
    furina.definition.backgrounds.content.source = "solid";
    await apply(library, furina);
    const file = join(dir, "export.json");
    await library.exportPackage(file);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.schemaVersion).toBe(4);
    expect(raw.images).toHaveLength(6);
    const { library: destination } = await fixture();
    const imported = await destination.importPackage(file);
    expect(imported.definition).toEqual(furina.definition);
    await apply(destination, imported);
    expect(destination.snapshot().palette?.dark.accent).toBe("#69BBDD");
  });
  it("deduplicates a package that matches a built-in definition", async () => {
    const { library, dir } = await fixture();
    await apply(library, await library.preview("furina-chanson"));
    const file = join(dir, "builtin.json");
    await library.exportPackage(file);
    const before = library.snapshot();
    const pack = JSON.parse(await readFile(file, "utf8"));
    // Theme editors normalize hexadecimal colors to lowercase.
    pack.skin.palette.dark.accent = pack.skin.palette.dark.accent.toLowerCase();
    await writeFile(file, JSON.stringify(pack));
    const imported = await library.importPackage(file);
    expect(imported.id).toBe("furina-chanson");
    expect(library.snapshot()).toEqual(before);
  });
  it("rejects corrupt packages and keeps preferences when the library itself is corrupt", async () => {
    const { library, dir, appearance, options } = await fixture();
    const before = library.snapshot();
    const file = await packageFile(dir, {
      backgrounds: defaultAhaAppearance().backgrounds,
      palette: null,
      iconId: "a".repeat(64),
    });
    await expect(library.importPackage(file)).rejects.toThrow("incomplete");
    expect(library.snapshot()).toEqual(before);
    await writeFile(library.file, "corrupt");
    const broken = new SkinLibrary(library.file, appearance, options);
    await broken.load();
    expect(broken.snapshot().warning).toContain("corrupt");
    await expect(apply(broken, await broken.preview("aha-elation"))).rejects.toThrow("corrupt");
    expect(await readFile(library.file, "utf8")).toBe("corrupt");
  });
  it("serializes icon reapplication behind an in-flight skin commit", async () => {
    const { library, applyIcon } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    applyIcon.mockImplementationOnce(async () => gate);
    const chosen = await library.preview("furina-chanson");
    const commit = apply(library, chosen);
    await vi.waitFor(() => expect(applyIcon).toHaveBeenCalledTimes(1));
    const reapply = library.reapplyIcon();
    expect(applyIcon).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([commit, reapply]);
    expect(applyIcon).toHaveBeenCalledTimes(2);
    expect(applyIcon.mock.calls[1]![0]).toBe(chosen.effectiveIconId);
  });
  it("normalizes a local icon and rejects forged image hashes", async () => {
    const { library, dir } = await fixture();
    const file = join(dir, "icon.png");
    await writeFile(
      file,
      await sharp({ create: { width: 300, height: 200, channels: 4, background: "navy" } })
        .png()
        .toBuffer(),
    );
    const id = await library.importIcon(file);
    const bytes = Buffer.from((await library.appearance.images.read(id)).bytes);
    expect((await sharp(bytes).metadata()).width).toBe(1024);
    expect(imageHash(bytes)).toBe(id);
    const normalized = await normalizeImage(bytes);
    expect(imageHash(normalized)).toBe(id);
    const pack = await packageFile(dir, {
      backgrounds: defaultAhaAppearance().backgrounds,
      palette: null,
      iconId: id,
    });
    const raw = JSON.parse(await readFile(pack, "utf8"));
    raw.images = [{ id, data: Buffer.from("bad").toString("base64") }];
    await writeFile(pack, JSON.stringify(raw));
    await expect(library.importPackage(pack)).rejects.toThrow("integrity");
  });
  it.each([1, 2])("reads legacy v%s packages as inheriting-icon skins", async (schemaVersion) => {
    const { library, dir } = await fixture();
    const file = join(dir, "legacy-simple.json");
    const { defaultTheme } = await import("@synara/contracts/ahaLegacyAppearance");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion,
        theme: defaultTheme(),
        ...(schemaVersion === 2 ? { images: [] } : {}),
      }),
    );
    const imported = await library.importPackage(file);
    expect(imported.definition.iconId).toBeNull();
    expect(imported.definition.palette?.dark.surface).toBe("#121212");
    expect(library.snapshot().skins.some((s) => s.id === imported.id)).toBe(true);
  });
  it("converts v3 packages to color-only skins and preserves global language and font settings", async () => {
    const { library, dir } = await fixture();
    const file = join(dir, "legacy.json");
    const palette = BUILTIN_PALETTES["furina-chanson"]!;
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 3,
        appearance: { ...defaultAhaAppearance(), language: "zh-CN", uiWeight: "400" },
        nativeTheme: JSON.stringify({
          chromeThemes: {
            dark: { ...palette.dark, fonts: { ui: "Other", code: "Other" } },
            light: palette.light,
          },
          mode: "light",
        }),
        images: [],
      }),
    );
    const imported = await library.importPackage(file);
    expect(imported.definition.palette).toEqual(palette);
    expect(imported.definition.iconId).toBeNull();
    await apply(library, imported);
    expect(library.snapshot().appearance.preferences.language).toBe("en");
    expect(library.snapshot().appearance.preferences.uiWeight).toBe("700");
  });
});

it("refreshes built-in references once without applying them; preserves adjustments and exports the active old artwork", async () => {
  const { library, appearance, options, applyIcon, dir } = await fixture();
  const old = await library.preview("aha-elation");
  old.definition.backgrounds.window.opacity = 0.31;
  old.definition.backgrounds.content.x = 72;
  old.definition.palette!.dark.surface = "#123456";
  const userImage = await appearance.images.store(
    await sharp({ create: { width: 30, height: 30, channels: 4, background: "#789abc" } })
      .png()
      .toBuffer(),
  );
  old.definition.backgrounds.sidebar.imageId = userImage;
  await apply(library, old);
  const before = library.snapshot();
  applyIcon.mockClear();
  const replacement = await appearance.images.store(
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#234567" } })
      .png()
      .toBuffer(),
  );
  const definitions = new Map(
    before.skins
      .filter((s) => s.origin === "builtin")
      .map((s) => [s.id, structuredClone(s.original)]),
  );
  const newDefinition = definitions.get("aha-elation")!;
  newDefinition.iconId = replacement;
  for (const background of Object.values(newDefinition.backgrounds))
    background.imageId = replacement;
  const refreshed = new SkinLibrary(library.file, appearance, options);
  vi.spyOn(
    refreshed as unknown as { readBuiltin(id: string): Promise<SkinDefinition> },
    "readBuiltin",
  ).mockImplementation(async (id) => structuredClone(definitions.get(id)!));
  await refreshed.load();
  const next = refreshed.snapshot();
  expect(next.revision).toBe(before.revision + 1);
  expect(next.activeId).toBe(before.activeId);
  expect(next.effectiveIconId).toBe(before.effectiveIconId);
  expect(next.appearance).toEqual(before.appearance);
  expect(next.palette).toEqual(before.palette);
  expect(applyIcon).not.toHaveBeenCalled();
  const preview = await refreshed.preview("aha-elation");
  expect(preview.definition.iconId).toBe(replacement);
  expect(preview.definition.backgrounds.window).toMatchObject({
    imageId: replacement,
    opacity: 0.31,
  });
  expect(preview.definition.backgrounds.content.x).toBe(72);
  expect(preview.definition.backgrounds.sidebar.imageId).toBe(userImage);
  expect(preview.definition.palette!.dark.surface).toBe("#123456");
  expect((await refreshed.preview("aha-elation", true)).definition).toEqual(newDefinition);
  const file = join(dir, "active-before-apply.json");
  await refreshed.exportPackage(file);
  const exported = JSON.parse(await readFile(file, "utf8"));
  expect(exported.skin.iconId).toBe(before.effectiveIconId);
  expect(exported.skin.backgrounds).toEqual(before.appearance.preferences.backgrounds);
  const persisted = await readFile(library.file, "utf8");
  await refreshed.load();
  expect(refreshed.snapshot()).toEqual(next);
  expect(await readFile(library.file, "utf8")).toBe(persisted);
  await apply(refreshed, preview);
  expect(applyIcon.mock.calls.at(-1)?.[0]).toBe(replacement);
  expect(refreshed.snapshot().effectiveIconId).toBe(replacement);
  await refreshed.exportPackage(file);
  expect((await refreshed.importPackage(file)).definition).toEqual(preview.definition);
});

it.each(["missing", "save"])(
  "preserves the entire old library when a built-in refresh has a %s failure",
  async (failure) => {
    const { library, appearance, options, applyIcon } = await fixture();
    const before = library.snapshot(),
      file = await readFile(library.file, "utf8");
    const definitions = new Map(
      before.skins
        .filter((s) => s.origin === "builtin")
        .map((s) => [s.id, structuredClone(s.original)]),
    );
    definitions.get("furina-chanson")!.backgrounds.window.opacity = 0.75;
    const refreshed = new SkinLibrary(library.file, appearance, options);
    vi.spyOn(
      refreshed as unknown as { readBuiltin(id: string): Promise<SkinDefinition> },
      "readBuiltin",
    ).mockImplementation(async (id) => {
      if (failure === "missing" && id === "aha-elation") throw new Error("missing asset");
      return structuredClone(definitions.get(id)!);
    });
    if (failure === "save")
      vi.spyOn(
        refreshed as unknown as { write(value: unknown): Promise<void> },
        "write",
      ).mockRejectedValue(new Error("save failed"));
    await refreshed.load();
    expect(await readFile(library.file, "utf8")).toBe(file);
    expect(refreshed.snapshot()).toMatchObject({
      revision: before.revision,
      activeId: before.activeId,
      effectiveIconId: before.effectiveIconId,
      palette: before.palette,
      skins: before.skins,
    });
    expect(refreshed.snapshot().appearance.preferences).toEqual(before.appearance.preferences);
    expect(refreshed.snapshot().warning).toBeTruthy();
    expect(applyIcon).not.toHaveBeenCalled();
  },
);

it("persists an independent icon across restart, preserves background edits, and follows the next skin", async () => {
  const { library, appearance, options, dir } = await fixture();
  await apply(library, await library.preview("furina-chanson"));
  const before = library.snapshot();
  const defaults = await library.preview("synara-default");
  await library.setAppIcon({ skinId: "synara-default", revision: before.revision });
  expect(library.snapshot()).toMatchObject({
    activeId: before.activeId,
    appearance: before.appearance,
    skins: before.skins,
    palette: before.palette,
    appIconOverrideSkinId: "synara-default",
    effectiveIconId: defaults.effectiveIconId,
  });
  const restarted = new SkinLibrary(library.file, appearance, options);
  await restarted.load();
  expect(restarted.snapshot()).toEqual(library.snapshot());
  const adjusted = await restarted.preview("furina-chanson");
  adjusted.definition.backgrounds.window.opacity = 0.32;
  await apply(restarted, adjusted);
  expect(restarted.snapshot().appIconOverrideSkinId).toBe("synara-default");
  expect(restarted.snapshot().effectiveIconId).toBe(defaults.effectiveIconId);
  const exported = join(dir, "export-with-override.json");
  await restarted.exportPackage(exported);
  expect(JSON.parse(await readFile(exported, "utf8")).skin.iconId).toBe(adjusted.definition.iconId);
  await restarted.setAppIcon({ skinId: null, revision: restarted.snapshot().revision });
  expect(restarted.snapshot().effectiveIconId).toBe(adjusted.definition.iconId);
  await restarted.setAppIcon({ skinId: "synara-default", revision: restarted.snapshot().revision });
  const elation = await restarted.preview("aha-elation");
  await apply(restarted, elation);
  expect(restarted.snapshot().appIconOverrideSkinId).toBeNull();
  expect(restarted.snapshot().effectiveIconId).toBe(elation.definition.iconId);
});

it("explicit skin icon edits clear the override and deleting its source restores following", async () => {
  const { library } = await fixture();
  const customId = library.snapshot().activeId;
  await apply(library, await library.preview("furina-chanson"));
  await library.setAppIcon({ skinId: customId, revision: library.snapshot().revision });
  const before = library.snapshot();
  await library.remove(customId, before.revision);
  expect(library.snapshot().appIconOverrideSkinId).toBeNull();
  expect(library.snapshot().effectiveIconId).toBe(
    (await library.preview("furina-chanson")).definition.iconId,
  );
  await library.setAppIcon({ skinId: "synara-default", revision: library.snapshot().revision });
  const edited = await library.preview("furina-chanson");
  edited.definition.iconId = (await library.preview("aha-elation")).definition.iconId;
  await apply(library, edited);
  expect(library.snapshot().appIconOverrideSkinId).toBeNull();
  expect(library.snapshot().effectiveIconId).toBe(edited.definition.iconId);
});

it("rejects stale selections and missing sources; native and save failures preserve the prior choice", async () => {
  const { library, applyIcon } = await fixture();
  const before = library.snapshot();
  await expect(
    library.setAppIcon({ skinId: "aha-elation", revision: before.revision + 1 }),
  ).rejects.toThrow("changed");
  await expect(
    library.setAppIcon({
      skinId: "import-00000000-0000-0000-0000-000000000000",
      revision: before.revision,
    }),
  ).rejects.toThrow("not found");
  expect(applyIcon).not.toHaveBeenCalled();
  applyIcon.mockRejectedValueOnce(new Error("Native icon failed"));
  await expect(
    library.setAppIcon({ skinId: "aha-elation", revision: before.revision }),
  ).rejects.toThrow("Native icon failed");
  expect(library.snapshot()).toEqual(before);
  applyIcon.mockClear();
  await rm(library.file);
  await mkdir(library.file);
  await expect(
    library.setAppIcon({ skinId: "aha-elation", revision: before.revision }),
  ).rejects.toThrow();
  expect(library.snapshot()).toEqual(before);
  expect(applyIcon.mock.calls.at(-1)?.[0]).toBe(before.effectiveIconId);
});

it("serializes manual selection with skin changes and rejects the stale queued change", async () => {
  const { library, applyIcon } = await fixture();
  const revision = library.snapshot().revision;
  let release!: () => void;
  applyIcon.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const selection = library.setAppIcon({ skinId: "aha-elation", revision });
  await vi.waitFor(() => expect(applyIcon).toHaveBeenCalledTimes(1));
  const skin = await library.preview("furina-chanson");
  const pending = apply(library, skin);
  const rejected = expect(pending).rejects.toThrow("changed");
  release();
  await selection;
  await rejected;
  expect(library.snapshot().appIconOverrideSkinId).toBe("aha-elation");
  await apply(library, skin);
  expect(library.snapshot().appIconOverrideSkinId).toBeNull();
});

it.each(["default", "customized", "iconless", "character"])(
  "migrates legacy %s artwork without losing user appearance",
  async (kind) => {
    const root = resolve(import.meta.dirname, "../../../..");
    const { library, appearance, options } = await fixture({
      defaultIcon: () => join(root, "assets/aha/elation/icon.png"),
    });
    const chosen = await library.preview(
      kind === "character"
        ? "furina-chanson"
        : kind === "iconless"
          ? library.snapshot().activeId
          : "synara-default",
    );
    if (kind === "customized")
      chosen.definition.iconId = (await library.preview("furina-chanson")).definition.iconId;
    chosen.definition.palette!.dark.surface = "#234567";
    await apply(library, chosen);
    const before = library.snapshot();
    const raw = JSON.parse(await readFile(library.file, "utf8"));
    delete raw.appIconOverrideSkinId;
    await writeFile(library.file, JSON.stringify(raw));
    const upgraded = new SkinLibrary(library.file, appearance, {
      ...options,
      defaultIcon: () => join(root, "assets/aha/default/icon.png"),
    });
    await upgraded.load();
    const after = upgraded.snapshot();
    expect(after.appIconOverrideSkinId).toBeNull();
    expect(after.appearance).toEqual(before.appearance);
    expect(after.palette).toEqual(before.palette);
    expect(after.activeId).toBe(before.activeId);
    if (kind === "default" || kind === "iconless") {
      expect(after.effectiveIconId).toBe(
        after.skins.find((s) => s.id === "synara-default")!.original.iconId,
      );
      expect(after.effectiveIconId).not.toBe(before.effectiveIconId);
    } else expect(after.effectiveIconId).toBe(before.effectiveIconId);
  },
);
