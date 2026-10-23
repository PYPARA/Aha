import { useEffect, useRef, useState } from "react";
import type { AhaAppearance } from "@synara/contracts/ahaAppearance";
import { REGIONS, type BackgroundRegion } from "@synara/contracts/ahaLegacyAppearance";
import type { SkinPalette, SkinPreview } from "@synara/contracts/ahaSkins";
import { useAhaAppearance } from "./AppearanceProvider";
import {
  useTheme,
  applyAhaThemeState,
  previewAhaThemeState,
  beginAhaThemePreview,
  cancelAhaThemePreview,
} from "../hooks/useTheme";
import { serializeThemeState, type ThemeState } from "../theme/theme.logic";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../components/settings/SettingsPanelPrimitives";
import { SettingsSelectControl } from "../components/settings/SettingControls";
import { ComposerPickerMenuPopup } from "../components/chat/ComposerPickerMenuPopup";
import { SelectItem } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../components/ui/menu";
import { Slider } from "../components/ui/slider";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import { Input } from "../components/ui/input";
import { EllipsisIcon } from "../lib/icons";
import {
  defaultSkinFirst,
  skinName,
  skinPaletteFromTheme,
  themeWithSkinPalette,
} from "./skin-colors";
import { SkinPicker } from "./SkinPicker";

const labels = {
  window: ["窗口", "Window"],
  rail: ["功能栏", "Rail"],
  sidebar: ["会话侧栏", "Sidebar"],
  content: ["内容区", "Content"],
  composer: ["输入框", "Composer"],
};
const percent = (value: number) => `${Math.round(value * 100)}%`;
function themeLeavesPalette(theme: ThemeState, palette: SkinPalette | null) {
  if (!palette) return false;
  try {
    return (
      JSON.stringify(skinPaletteFromTheme(theme)).toLowerCase() !==
      JSON.stringify(palette).toLowerCase()
    );
  } catch {
    // Colors the skin schema cannot hold are not something Apply could save either.
    return false;
  }
}

export function AhaAppearancePanel() {
  const { snapshot, savedPreferences, preview, skins, previewSkin, refreshSkins, acceptSkins } =
    useAhaAppearance();
  const { themeState, resolvedTheme } = useTheme();
  const [draft, setDraft] = useState(snapshot.preferences);
  const [region, setRegion] = useState<BackgroundRegion>("window");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSkin, setSelectedSkin] = useState<string | null>(null);
  const [skinPreview, setSkinPreview] = useState<SkinPreview | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const skinThemeBefore = useRef<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const restoreTheme = () => {
    cancelAhaThemePreview();
    beginAhaThemePreview();
  };
  useEffect(() => {
    if (!skinPreview) setDraft(savedPreferences);
  }, [savedPreferences, skinPreview]);
  useEffect(() => {
    mounted.current = true;
    beginAhaThemePreview();
    return () => {
      mounted.current = false;
      // This ref is a numeric response generation, never a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestId.current++;
      previewSkin(null);
      preview(null);
      cancelAhaThemePreview();
    };
  }, [preview, previewSkin]);
  const en = draft.language === "en";
  const t = (zh: string, english: string) => (en ? english : zh);
  const api = window.desktopBridge?.ahaAppearance;
  const activeSkinId = selectedSkin ?? skins?.activeId;
  const selectedEntry = skins?.skins.find((s) => s.id === activeSkinId);
  const defaultIconId =
    skins?.skins.find((skin) => skin.id === "synara-default")?.original.iconId ?? null;
  // Theme colors edited on this page stay a preview until applied to the active skin.
  const dirty =
    skinPreview !== null ||
    JSON.stringify(draft) !== JSON.stringify(savedPreferences) ||
    themeLeavesPalette(themeState, skins?.palette ?? null);
  const edit = (next: AhaAppearance) => {
    setDraft(next);
    preview(next);
  };
  const loadSkin = (result: SkinPreview) => {
    restoreTheme();
    skinThemeBefore.current = serializeThemeState(themeState);
    previewAhaThemeState(themeWithSkinPalette(themeState, result.definition.palette));
    setSelectedSkin(result.id);
    setSkinPreview(result);
    previewSkin(result);
    setRenameValue(skins?.skins.find((s) => s.id === result.id)?.name ?? "");
    edit({ ...draft, backgrounds: result.definition.backgrounds, clearMode: false });
  };
  const selectSkin = async (id: string) => {
    const token = ++requestId.current;
    const result = await api!.skins!.preview(id);
    if (mounted.current && token === requestId.current) loadSkin(result);
  };
  const background = draft.backgrounds[region];
  const setBackground = (patch: Partial<typeof background>) =>
    edit({
      ...draft,
      backgrounds: { ...draft.backgrounds, [region]: { ...background, ...patch } },
    });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const importInto = (read: () => Promise<SkinPreview | null>) =>
    void run(async () => {
      const result = await read();
      await refreshSkins();
      if (result && mounted.current) loadSkin(result);
    });
  const applyChanges = () =>
    void run(async () => {
      if (!skins || !activeSkinId) return;
      const base = skinPreview ?? (await api!.skins!.preview(activeSkinId));
      const themeChanged =
        skinThemeBefore.current !== null &&
        serializeThemeState(themeState) !== skinThemeBefore.current;
      const definition = {
        ...base.definition,
        backgrounds: draft.backgrounds,
        palette:
          !skinPreview || themeChanged ? skinPaletteFromTheme(themeState) : base.definition.palette,
      };
      const value = await api!.skins!.apply({
        id: base.id,
        revision: skins.revision,
        preferences: draft,
        definition,
      });
      acceptSkins(value);
      preview(null);
      previewSkin(null);
      setSkinPreview(null);
      setSelectedSkin(null);
      applyAhaThemeState(themeWithSkinPalette(themeState, value.palette));
      beginAhaThemePreview();
      skinThemeBefore.current = null;
    });
  const cancelChanges = () =>
    void run(async () => {
      requestId.current++;
      setSelectedSkin(null);
      setSkinPreview(null);
      previewSkin(null);
      skinThemeBefore.current = null;
      const value = await api!.get();
      setDraft(value.preferences);
      preview(null);
      restoreTheme();
    });
  if (!api?.skins)
    return (
      <SettingsSection title={t("皮肤", "Skins")}>
        <p className="p-4 text-ui">
          {t("皮肤与背景请使用桌面应用。", "Use the desktop app for skins and backgrounds.")}
        </p>
      </SettingsSection>
    );
  const sliders = [
    ["opacity", t("图片不透明度", "Image opacity"), 0, 1, 0.05, percent],
    ["overlay", t("遮罩强度", "Overlay"), 0, 1, 0.05, percent],
    ["blur", t("模糊", "Blur"), 0, 24, 1, (value: number) => `${value}px`],
    ["x", t("水平位置", "Horizontal position"), 0, 100, 1, (value: number) => `${value}%`],
    ["y", t("垂直位置", "Vertical position"), 0, 100, 1, (value: number) => `${value}%`],
  ] as const;
  const originLabel = {
    builtin: t("内置皮肤", "Built-in skin"),
    imported: t("导入的皮肤", "Imported skin"),
    custom: t("自定义皮肤", "Custom skin"),
  };
  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title={t("皮肤", "Skins")}
        action={
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  shape="capsule"
                  label={t("更多皮肤操作", "More skin actions")}
                  disabled={busy || !skins}
                >
                  <EllipsisIcon className="size-4" />
                </IconButton>
              }
            />
            <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="min-w-48">
              <MenuItem onClick={() => importInto(() => api.skins!.importPackage())}>
                {t("导入皮肤包", "Import skin package")}
              </MenuItem>
              <MenuItem onClick={() => importInto(() => api.skins!.importDirectory())}>
                {t("从旧目录导入外观", "Import appearance directory")}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void run(async () => {
                    await api.skins!.exportPackage();
                  })
                }
              >
                {t("导出当前皮肤", "Export current skin")}
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        }
      >
        <SettingsCard>
          {skins && selectedEntry ? (
            <>
              <SettingsRow
                title={t("皮肤库", "Skin library")}
                description={t(
                  "选择即预览图标、五区域背景和配色，应用后保存。",
                  "Choosing a skin previews its icon, backgrounds and colors. Apply to save.",
                )}
              >
                <div className="pt-3">
                  <SkinPicker
                    skins={defaultSkinFirst(skins.skins)}
                    selectedId={selectedEntry.id}
                    activeId={skins.activeId}
                    defaultIconId={defaultIconId}
                    variant={resolvedTheme}
                    en={en}
                    disabled={busy}
                    onSelect={(id) => void run(() => selectSkin(id))}
                  />
                </div>
              </SettingsRow>
              <SettingsRow
                title={skinName(selectedEntry.id, selectedEntry.name, en)}
                description={originLabel[selectedEntry.origin]}
                control={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await api.skins!.importIcon();
                          if (!result || !mounted.current) return;
                          const base = skinPreview ?? (await api.skins!.preview(selectedEntry.id));
                          loadSkin({
                            ...base,
                            definition: {
                              ...base.definition,
                              backgrounds: draft.backgrounds,
                              palette: skinPaletteFromTheme(themeState),
                              iconId: result.id,
                            },
                            effectiveIconId: result.id,
                          });
                        })
                      }
                    >
                      {t("更换图标", "Change icon")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const validated = await api.skins!.preview(selectedEntry.id);
                          if (mounted.current)
                            loadSkin({
                              ...validated,
                              definition: selectedEntry.original,
                              effectiveIconId: selectedEntry.original.iconId ?? defaultIconId,
                            });
                        })
                      }
                    >
                      {t("恢复此皮肤默认", "Reset skin defaults")}
                    </Button>
                  </div>
                }
              />
              {selectedEntry.origin !== "builtin" && (
                <SettingsRow
                  title={t("名称", "Name")}
                  control={
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="Skin name"
                        value={renameValue}
                        placeholder={selectedEntry.name}
                        maxLength={80}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !renameValue.trim() || renameValue === selectedEntry.name}
                        onClick={() =>
                          void run(async () => {
                            acceptSkins(
                              await api.skins!.rename({
                                id: selectedEntry.id,
                                name: renameValue,
                                revision: skins.revision,
                              }),
                            );
                          })
                        }
                      >
                        {t("重命名", "Rename")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || selectedEntry.id === skins.activeId}
                        title={
                          selectedEntry.id === skins.activeId
                            ? t("使用中的皮肤不能删除", "The skin in use cannot be deleted")
                            : undefined
                        }
                        onClick={() =>
                          void run(async () => {
                            acceptSkins(
                              await api.skins!.remove({
                                id: selectedEntry.id,
                                revision: skins.revision,
                              }),
                            );
                            setSelectedSkin(null);
                            setSkinPreview(null);
                            previewSkin(null);
                            preview(null);
                            restoreTheme();
                          })
                        }
                      >
                        {t("删除皮肤", "Delete skin")}
                      </Button>
                    </div>
                  }
                />
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 p-4 text-ui text-muted-foreground">
              {snapshot.warning ? (
                <span role="alert" className="text-destructive">
                  {snapshot.warning}
                </span>
              ) : (
                <>
                  <Spinner className="size-4" />
                  {t("正在加载皮肤库…", "Loading skin library…")}
                </>
              )}
            </div>
          )}
          {(error ?? (skins ? snapshot.warning : null)) && (
            <p role="alert" className="px-3 py-2.5 text-ui-sm text-destructive">
              {error ?? snapshot.warning}
            </p>
          )}
        </SettingsCard>
      </SettingsSectionShell>
      <SettingsSection title={t("背景", "Backgrounds")}>
        <SettingsRow
          title={t("清晰模式", "Clear mode")}
          description={t("暂时隐藏全部背景图片。", "Temporarily hide all background images.")}
          control={
            <Switch
              checked={draft.clearMode}
              onCheckedChange={(checked) => edit({ ...draft, clearMode: Boolean(checked) })}
              aria-label="Clear mode"
            />
          }
        />
        <SettingsRow
          title={t("背景区域", "Background region")}
          description={t(
            "以下设置只作用于所选区域。",
            "The settings below apply to the selected region.",
          )}
          control={
            <SettingsSelectControl
              value={region}
              valueContent={labels[region][en ? 1 : 0]}
              ariaLabel="Background region"
              onValueChange={(value) => {
                if (REGIONS.includes(value as BackgroundRegion))
                  setRegion(value as BackgroundRegion);
              }}
            >
              {REGIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {labels[r][en ? 1 : 0]}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          title={t("背景来源", "Background source")}
          control={
            <>
              {background.source === "image" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.importImage();
                      if (result) setBackground({ source: "image", imageId: result.id });
                    })
                  }
                >
                  {t("更换图片", "Change image")}
                </Button>
              )}
              <SettingsSelectControl
                value={background.source}
                valueContent={
                  background.source === "image"
                    ? t("图片", "Image")
                    : background.source === "inherit"
                      ? t("继承窗口", "Inherit window")
                      : t("主题底色", "Theme surface")
                }
                ariaLabel="Background source"
                onValueChange={(value) => {
                  if (value === "image" && !background.imageId) {
                    void run(async () => {
                      const result = await api.importImage();
                      if (result) setBackground({ source: "image", imageId: result.id });
                    });
                  } else if (value === "solid" || value === "inherit" || value === "image")
                    setBackground({ source: value });
                }}
              >
                <SelectItem value="solid">{t("主题底色", "Theme surface")}</SelectItem>
                {region !== "window" && (
                  <SelectItem value="inherit">{t("继承窗口", "Inherit window")}</SelectItem>
                )}
                <SelectItem value="image">{t("图片", "Image")}</SelectItem>
              </SettingsSelectControl>
            </>
          }
        />
        {background.source === "image" && (
          <>
            {sliders.map(([key, label, min, max, step, format]) => (
              <SettingsRow
                key={key}
                title={label}
                control={
                  <div className="flex w-full items-center gap-3 sm:w-56">
                    <Slider
                      aria-label={label}
                      min={min}
                      max={max}
                      step={step}
                      value={background[key]}
                      getAriaValueText={format}
                      onValueChange={(value) => setBackground({ [key]: value })}
                    />
                    <span className="w-11 shrink-0 text-right text-ui-sm text-muted-foreground tabular-nums">
                      {format(background[key])}
                    </span>
                  </div>
                }
              />
            ))}
            <SettingsRow
              title={t("图片适应", "Image fit")}
              control={
                <SettingsSelectControl
                  value={background.fit}
                  valueContent={
                    background.fit === "contain" ? t("完整显示", "Contain") : t("填充", "Cover")
                  }
                  ariaLabel="Image fit"
                  onValueChange={(value) =>
                    setBackground({ fit: value === "contain" ? "contain" : "cover" })
                  }
                >
                  <SelectItem value="cover">{t("填充", "Cover")}</SelectItem>
                  <SelectItem value="contain">{t("完整显示", "Contain")}</SelectItem>
                </SettingsSelectControl>
              }
            />
          </>
        )}
      </SettingsSection>
      <SettingsSection title={t("语言与字重", "Language and weight")}>
        <SettingsRow
          title={t("界面语言", "Language")}
          description={t(
            "核心页面提供双语，其他页面暂保留英文。",
            "Core pages are bilingual; other upstream pages retain English.",
          )}
          control={
            <SettingsSelectControl
              value={draft.language}
              valueContent={en ? "English" : "简体中文"}
              ariaLabel="Language"
              onValueChange={(value) =>
                edit({ ...draft, language: value === "en" ? "en" : "zh-CN" })
              }
            >
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SettingsSelectControl>
          }
        />
        {(
          [
            ["uiWeight", t("界面字重", "UI weight")],
            ["contentWeight", t("正文字重", "Message weight")],
            ["codeWeight", t("代码字重", "Code weight")],
          ] as const
        ).map(([key, label]) => (
          <SettingsRow
            key={key}
            title={label}
            description={t("开启后使用粗体。", "Use bold when on.")}
            control={
              <Switch
                checked={draft[key] === "700"}
                onCheckedChange={(checked) => edit({ ...draft, [key]: checked ? "700" : "400" })}
                aria-label={label}
              />
            }
          />
        ))}
        <SettingsRow
          title={t("代码字号", "Code font size")}
          control={
            <SettingsSelectControl
              value={draft.codeSize ? String(draft.codeSize) : "default"}
              valueContent={draft.codeSize ?? t("跟随上游字号", "Follow app size")}
              ariaLabel="Code font size"
              onValueChange={(value) =>
                edit({ ...draft, codeSize: value === "default" ? null : Number(value) })
              }
            >
              <SelectItem value="default">{t("跟随上游字号", "Follow app size")}</SelectItem>
              {Array.from({ length: 10 }, (_, i) => i + 11).map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
      {dirty && (
        <div
          role="region"
          aria-label={t("未应用的外观更改", "Pending appearance changes")}
          className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2"
        >
          <span className="min-w-0 truncate text-ui text-muted-foreground">
            {skinPreview && selectedEntry
              ? t(
                  `正在预览「${skinName(selectedEntry.id, selectedEntry.name, en)}」`,
                  `Previewing "${skinName(selectedEntry.id, selectedEntry.name, en)}"`,
                )
              : t("有未应用的外观更改", "You have unapplied appearance changes")}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={cancelChanges}>
              {t("取消", "Cancel")}
            </Button>
            <Button size="sm" disabled={busy} onClick={applyChanges}>
              {t("应用", "Apply")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
