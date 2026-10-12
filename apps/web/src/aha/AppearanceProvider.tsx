import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  defaultAhaAppearance,
  type AhaAppearance,
  type AhaAppearanceSnapshot,
} from "@synara/contracts/ahaAppearance";
import { BackgroundsSchema, REGIONS } from "@synara/contracts/ahaLegacyAppearance";
import { copy } from "./translations";
import type { SkinSnapshot, SkinPreview } from "@synara/contracts/ahaSkins";
import { useTheme, applyAhaThemeState } from "../hooks/useTheme";
import { skinPaletteFromTheme, themeWithSkinPalette } from "./skin-colors";
import "./backgrounds.css";

const initial: AhaAppearanceSnapshot = {
  preferences: defaultAhaAppearance(),
  revision: 0,
  warning: null,
};
let currentLanguage: AhaAppearance["language"] = "zh-CN";
export const originalCopy = (text: string) =>
  Object.keys(copy).find((key) => copy[key] === text) ?? text;
export const tr = (text: string) => (currentLanguage === "en" ? text : (copy[text] ?? text));
const Context = createContext({
  skins: null as SkinSnapshot | null,
  skinDraft: null as SkinPreview | null,
  iconUrl: "/aha-logo.png",
  previewSkin: (_value: SkinPreview | null) => {},
  refreshSkins: async () => {},
  restoreDefaultSkin: async () => {},
  acceptSkins: (_value: SkinSnapshot) => {},
  snapshot: initial,
  savedPreferences: initial.preferences,
  preview: (_value: AhaAppearance | null) => {},
  save: async (_value: AhaAppearance) => initial,
});
export function useAhaAppearance() {
  return useContext(Context);
}
export function useAhaTranslation() {
  const { snapshot } = useContext(Context);
  const language = snapshot.preferences.language;
  return useCallback(
    (text: string) => (language === "en" ? text : (copy[text] ?? text)),
    [language],
  );
}

function projectAppearance(preferences: AhaAppearance, urls: Record<string, string>) {
  const root = document.documentElement;
  root.lang = preferences.language;
  root.dataset.ahaClear = String(preferences.clearMode);
  root.style.setProperty("--aha-ui-weight", preferences.uiWeight);
  root.style.setProperty("--aha-content-weight", preferences.contentWeight);
  root.style.setProperty("--aha-code-weight", preferences.codeWeight);
  if (preferences.codeSize) root.style.setProperty("--aha-code-size", `${preferences.codeSize}px`);
  else root.style.removeProperty("--aha-code-size");
  const backgrounds = BackgroundsSchema.parse(preferences.backgrounds);
  root.dataset.ahaBackgrounds = String(
    !preferences.clearMode &&
      Object.values(backgrounds).some(
        (background) =>
          background.source === "image" && background.imageId && urls[background.imageId],
      ),
  );
  for (const region of REGIONS) {
    const own = backgrounds[region],
      resolved = own.source === "inherit" ? backgrounds.window : own;
    const active =
      !preferences.clearMode &&
      resolved.source === "image" &&
      !!resolved.imageId &&
      !!urls[resolved.imageId];
    root.style.setProperty(
      `--aha-${region}-image`,
      active ? `url("${urls[resolved.imageId!]}")` : "none",
    );
    root.style.setProperty(`--aha-${region}-opacity`, String(active ? resolved.opacity : 0));
    root.style.setProperty(`--aha-${region}-overlay`, String(resolved.overlay));
    root.style.setProperty(`--aha-${region}-blur`, `${resolved.blur}px`);
    root.style.setProperty(`--aha-${region}-fit`, resolved.fit);
    root.style.setProperty(`--aha-${region}-position`, `${resolved.x}% ${resolved.y}%`);
    root.dataset[`aha${region[0]!.toUpperCase()}${region.slice(1)}`] = active ? "image" : "off";
  }
}
export function AhaAppearanceProvider({ children }: { children: ReactNode }) {
  const { themeState } = useTheme();
  const themeRef = useRef(themeState);
  themeRef.current = themeState;
  const [skins, setSkins] = useState<SkinSnapshot | null>(null);
  const [skinDraft, setSkinDraft] = useState<SkinPreview | null>(null);
  const committedPalette = useRef<string | null>(null);
  const [stored, setStored] = useState(initial);
  const [draft, setDraft] = useState<AhaAppearance | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const preferences = draft ?? stored.preferences;
  currentLanguage = preferences.language;
  const acceptSkins = useCallback((value: SkinSnapshot) => {
    setSkins(value);
    setStored(value.appearance);
  }, []);
  const refreshSkins = useCallback(async () => {
    const api = window.desktopBridge?.ahaAppearance?.skins;
    if (api) acceptSkins(await api.list({ initialPalette: skinPaletteFromTheme(themeState) }));
  }, [acceptSkins, themeState]);
  useEffect(() => {
    const api = window.desktopBridge?.ahaAppearance?.skins;
    if (!api) return;
    let live = true;
    api
      .list({ initialPalette: skinPaletteFromTheme(themeState) })
      .then((value) => {
        if (live) acceptSkins(value);
      })
      .catch((error) => {
        if (live) setStored((value) => ({ ...value, warning: String(error) }));
      });
    const dispose = api.onChanged((value) => {
      if (live) acceptSkins(value);
    });
    return () => {
      live = false;
      dispose();
    };
    // Initialization captures existing colors once; subsequent edits belong to the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptSkins]);
  useEffect(() => {
    if (!skinDraft && skins?.palette) {
      const key = JSON.stringify(skins.palette);
      if (committedPalette.current === key) return;
      committedPalette.current = key;
      const next = themeWithSkinPalette(themeRef.current, skins.palette);
      if (
        JSON.stringify(skinPaletteFromTheme(themeRef.current)).toLowerCase() !==
        JSON.stringify(skins.palette).toLowerCase()
      )
        applyAhaThemeState(next);
    }
  }, [skinDraft, skins?.palette]);
  const iconId = skinDraft?.effectiveIconId ?? skins?.effectiveIconId;
  const [iconUrl, setIconUrl] = useState("/aha-logo.png");
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    if (!iconId) {
      setIconUrl("/aha-logo.png");
      return;
    }
    window.desktopBridge?.ahaAppearance
      ?.readImage(iconId)
      .then((image) => {
        url = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
        if (live) setIconUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (live) setIconUrl("/aha-logo.png");
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [iconId]);
  useEffect(() => {
    const links = [
      ...document.querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"], link[rel="apple-touch-icon"]',
      ),
    ];
    const previous = links.map((link) => link.href);
    links.forEach((link) => {
      link.href = iconUrl;
    });
    return () =>
      links.forEach((link, index) => {
        link.href = previous[index]!;
      });
  }, [iconUrl]);
  useEffect(() => {
    const bridge = window.desktopBridge?.ahaAppearance;
    if (!bridge) return;
    let live = true;
    bridge
      .get()
      .then((value) => {
        if (live) setStored(value);
      })
      .catch((error) => {
        if (live) setStored({ ...initial, warning: String(error) });
      });
    const unsubscribe = bridge.onChanged((value) => {
      if (live) setStored(value);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const ids = [
      ...new Set(
        Object.values(preferences.backgrounds).flatMap((b) =>
          b.source === "image" && b.imageId ? [b.imageId] : [],
        ),
      ),
    ];
    const bridge = window.desktopBridge?.ahaAppearance;
    let live = true;
    const created: string[] = [];
    Promise.all(
      ids.map(async (id) => {
        if (!bridge) return [id, ""] as const;
        try {
          const image = await bridge.readImage(id);
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
          );
          created.push(url);
          return [id, url] as const;
        } catch {
          return [id, ""] as const;
        }
      }),
    ).then((entries) => {
      if (live) setUrls(Object.fromEntries(entries));
      else created.forEach(URL.revokeObjectURL);
    });
    return () => {
      live = false;
      created.forEach(URL.revokeObjectURL);
    };
  }, [preferences.backgrounds]);
  useEffect(() => {
    projectAppearance(preferences, urls);
  }, [preferences, urls]);
  const preview = useCallback((value: AhaAppearance | null) => setDraft(value), []);
  const previewSkin = useCallback((value: SkinPreview | null) => setSkinDraft(value), []);
  const restoreDefaultSkin = useCallback(async () => {
    const api = window.desktopBridge?.ahaAppearance?.skins;
    if (!api) throw new Error("This appearance extension requires the desktop app.");
    const current = await api.list();
    const definition = current.skins.find((skin) => skin.id === "synara-default")?.original;
    if (!definition) throw new Error("The default style is unavailable.");
    const result = await api.apply({
      id: "synara-default",
      definition,
      revision: current.revision,
      preferences: {
        ...current.appearance.preferences,
        backgrounds: definition.backgrounds,
        clearMode: false,
      },
    });
    acceptSkins(result);
    setDraft(null);
    setSkinDraft(null);
    applyAhaThemeState(themeWithSkinPalette(themeRef.current, result.palette));
  }, [acceptSkins]);
  const value = useMemo(
    () => ({
      skins,
      skinDraft,
      iconUrl,
      previewSkin,
      refreshSkins,
      restoreDefaultSkin,
      acceptSkins,
      snapshot: { ...stored, preferences },
      savedPreferences: stored.preferences,
      preview,
      save: async (next: AhaAppearance) => {
        const bridge = window.desktopBridge?.ahaAppearance;
        if (!bridge) throw new Error("This appearance extension requires the desktop app.");
        const result = await bridge.save({ preferences: next, revision: stored.revision });
        setStored(result);
        setDraft(null);
        return result;
      },
    }),
    [
      stored,
      preferences,
      preview,
      skins,
      skinDraft,
      iconUrl,
      previewSkin,
      refreshSkins,
      restoreDefaultSkin,
      acceptSkins,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
