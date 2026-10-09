import { useEffect, useRef, useState } from "react";
import type { AhaAppearance, AhaThemePreview } from "@synara/contracts/ahaAppearance";
import { defaultAhaAppearance } from "@synara/contracts/ahaAppearance";
import { REGIONS, type BackgroundRegion } from "@synara/contracts/ahaLegacyAppearance";
import { useAhaAppearance } from "./AppearanceProvider";
import { useTheme, applyAhaThemeState, previewAhaThemeState } from "../hooks/useTheme";
import { serializeThemeState } from "../theme/theme.logic";
import { useAppSettings } from "../appSettings";
import { SettingsRow, SettingsSection } from "../components/settings/SettingsPanelPrimitives";
import { SettingsSelectControl } from "../components/settings/SettingControls";
import { SelectItem } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";

const labels = {
  window: ["窗口", "Window"],
  rail: ["功能栏", "Rail"],
  sidebar: ["会话侧栏", "Sidebar"],
  content: ["内容区", "Content"],
  composer: ["输入框", "Composer"],
};
export function AhaAppearancePanel() {
  const { snapshot, savedPreferences, preview, save } = useAhaAppearance();
  const { themeState } = useTheme();
  const { updateSettings } = useAppSettings();
  const [draft, setDraft] = useState(snapshot.preferences);
  const [region, setRegion] = useState<BackgroundRegion>("window");
  const [pendingTheme, setPendingTheme] = useState<AhaThemePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const themeBeforePreview = useRef<string | null>(null);
  const themeToApply = useRef<string | null>(null);
  const restoreTheme = () => {
    if (themeBeforePreview.current) previewAhaThemeState(themeBeforePreview.current);
    themeBeforePreview.current = null;
    themeToApply.current = null;
  };
  useEffect(() => {
    setDraft(savedPreferences);
  }, [savedPreferences]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      preview(null);
      if (themeBeforePreview.current) previewAhaThemeState(themeBeforePreview.current);
    };
  }, [preview]);
  const en = draft.language === "en";
  const t = (zh: string, english: string) => (en ? english : zh);
  const edit = (next: AhaAppearance) => {
    setDraft(next);
    preview(next);
  };
  const background = draft.backgrounds[region];
  const setBackground = (patch: Partial<typeof background>) =>
    edit({
      ...draft,
      backgrounds: { ...draft.backgrounds, [region]: { ...background, ...patch } },
    });
  const loadPreview = (result: AhaThemePreview) => {
    if (!themeBeforePreview.current) themeBeforePreview.current = serializeThemeState(themeState);
    let nextTheme = result.nativeTheme;
    if (result.legacyTheme) {
      const state = structuredClone(themeState);
      for (const mode of ["dark", "light"] as const) {
        const legacy = result.legacyTheme[mode];
        const palette = legacy.palette;
        state.chromeThemes[mode] = {
          ...state.chromeThemes[mode],
          surface: palette.background,
          ink: palette.foreground,
          accent: palette.accent,
          fonts: {
            ui: legacy.uiFont && legacy.uiFont !== "System" ? legacy.uiFont : null,
            code: legacy.codeFont && legacy.codeFont !== "System" ? legacy.codeFont : null,
          },
        };
      }
      state.systemUiFont = !state.chromeThemes.dark.fonts.ui && !state.chromeThemes.light.fonts.ui;
      nextTheme = serializeThemeState(state);
    }
    if (nextTheme) previewAhaThemeState(nextTheme);
    themeToApply.current = nextTheme;
    setPendingTheme(result);
    edit(result.preferences);
  };
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
  if (!window.desktopBridge?.ahaAppearance)
    return (
      <SettingsSection title="Aha">
        <p className="p-4 text-ui">
          {t(
            "背景与主题包导入请使用桌面应用。",
            "Use the desktop app for backgrounds and theme packages.",
          )}
        </p>
      </SettingsSection>
    );
  return (
    <SettingsSection title={t("Aha 背景与语言", "Aha backgrounds and language")}>
      <SettingsRow
        title={t("虚照·欢愉", "Xuzhao · Elation")}
        description={t(
          "预览星神阿哈主题的五区域背景，应用后保存。",
          "Preview five backgrounds inspired by Aeon Aha, then apply to save.",
        )}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result =
                  await window.desktopBridge!.ahaAppearance!.previewBuiltin("aha-elation");
                if (!mounted.current) return;
                restoreTheme();
                setPendingTheme(null);
                edit({ ...draft, backgrounds: result.preferences.backgrounds, clearMode: false });
              })
            }
          >
            {t("预览背景", "Preview backgrounds")}
          </Button>
        }
      />
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
            onValueChange={(value) => edit({ ...draft, language: value === "en" ? "en" : "zh-CN" })}
          >
            <SelectItem value="zh-CN">简体中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SettingsSelectControl>
        }
      />
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
        control={
          <SettingsSelectControl
            value={region}
            valueContent={labels[region][en ? 1 : 0]}
            ariaLabel="Background region"
            onValueChange={(value) => {
              if (REGIONS.includes(value as BackgroundRegion)) setRegion(value as BackgroundRegion);
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
                  const result = await window.desktopBridge!.ahaAppearance!.importImage();
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
        }
      />
      <SettingsRow
        title={t("背景图片", "Background image")}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.desktopBridge!.ahaAppearance!.importImage();
                if (result) setBackground({ source: "image", imageId: result.id });
              })
            }
          >
            {t("选择图片", "Choose image")}
          </Button>
        }
      />
      {background.source === "image" && (
        <>
          {(
            [
              ["opacity", t("图片不透明度", "Image opacity"), 0, 1, 0.05],
              ["overlay", t("遮罩强度", "Overlay"), 0, 1, 0.05],
              ["blur", t("模糊", "Blur"), 0, 24, 1],
              ["x", t("水平位置", "Horizontal position"), 0, 100, 1],
              ["y", t("垂直位置", "Vertical position"), 0, 100, 1],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <SettingsRow
              key={key}
              title={label}
              control={
                <div className="flex items-center gap-2">
                  <input
                    aria-label={label}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={background[key]}
                    onChange={(event) => setBackground({ [key]: Number(event.target.value) })}
                  />
                  <span className="text-ui-xs">{background[key]}</span>
                </div>
              }
            />
          ))}
          <SettingsRow
            title={t("图片适应", "Image fit")}
            control={
              <SettingsSelectControl
                value={background.fit}
                valueContent={background.fit}
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
      <div className="flex flex-wrap items-center gap-2 p-4">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await save(draft);
              if (themeToApply.current) applyAhaThemeState(themeToApply.current);
              if (pendingTheme?.uiSize) updateSettings({ chatFontSizePx: pendingTheme.uiSize });
              themeBeforePreview.current = null;
              themeToApply.current = null;
              setPendingTheme(null);
            })
          }
        >
          {t("应用", "Apply")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await window.desktopBridge!.ahaAppearance!.get();
              setDraft(value.preferences);
              preview(null);
              restoreTheme();
              setPendingTheme(null);
            })
          }
        >
          {t("取消", "Cancel")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await window.desktopBridge!.ahaAppearance!.previewPackage();
              if (result) loadPreview(result);
            })
          }
        >
          {t("导入主题包", "Import theme package")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await window.desktopBridge!.ahaAppearance!.previewDirectory();
              if (result) loadPreview(result);
            })
          }
        >
          {t("从旧目录导入外观", "Import appearance directory")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await window.desktopBridge!.ahaAppearance!.exportPackage({
                nativeTheme: serializeThemeState(themeState),
              });
            })
          }
        >
          {t("导出主题包", "Export theme package")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            restoreTheme();
            setPendingTheme(null);
            edit(defaultAhaAppearance());
          }}
        >
          {t("恢复默认", "Reset")}
        </Button>
        {pendingTheme && (
          <span className="text-ui-sm">
            {t("主题已导入预览，点击应用保存。", "Theme preview loaded. Apply to save.")}
          </span>
        )}
        {(error ?? snapshot.warning) && (
          <p role="alert" className="w-full text-ui-sm text-destructive">
            {error ?? snapshot.warning}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
