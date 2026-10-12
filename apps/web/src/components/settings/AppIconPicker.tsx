// Select application artwork independently; the next skin switch follows that skin again.
import { useEffect, useState } from "react";

import { useAhaTranslation, useAhaAppearance } from "~/aha/AppearanceProvider";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

function IconThumbnail({ iconId }: { readonly iconId: string | null }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!iconId) return;
    let live = true;
    let url: string | undefined;
    void window.desktopBridge?.ahaAppearance
      ?.readImage(iconId)
      .then((image) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
        setImage({ id: iconId, url });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [iconId]);
  return (
    <img
      src={image?.id === iconId ? image.url : "/aha-logo.png"}
      alt=""
      draggable={false}
      className="size-12 object-contain"
    />
  );
}

export function AppIconPicker() {
  const tr = useAhaTranslation();
  const { skins, acceptSkins } = useAhaAppearance();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!skins) return <Spinner aria-label={tr("Loading app icons")} className="size-4" />;

  const choices = skins.skins.toSorted(
    (a, b) => Number(b.id === "synara-default") - Number(a.id === "synara-default"),
  );
  const selectedId = skins.appIconOverrideSkinId ?? skins.activeId;
  const select = async (skinId: string | null) => {
    const api = window.desktopBridge?.ahaAppearance?.skins;
    if (!api || pending !== null) return;
    setPending(skinId ?? "follow");
    setError(null);
    try {
      acceptSkins(await api.setAppIcon({ skinId, revision: skins.revision }));
    } catch (error) {
      setError(error instanceof Error ? error.message : tr("Could not update app icon"));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="min-w-0 space-y-2">
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={tr("App icon")}
        aria-busy={pending !== null}
      >
        {choices.map((skin) => {
          const label = skin.id === "synara-default" ? tr("Default app icon") : skin.name;
          const applying = pending === skin.id;
          return (
            <button
              key={skin.id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={selectedId === skin.id}
              disabled={pending !== null}
              className={cn(
                "relative flex w-24 flex-col items-center gap-1 rounded-xl border-2 p-2 text-xs transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none",
                selectedId === skin.id
                  ? "border-foreground"
                  : "border-transparent hover:border-foreground/25",
              )}
              onClick={() => void select(skin.id)}
            >
              <IconThumbnail iconId={skin.adjusted.iconId} />
              <span className="w-full break-words text-center">{label}</span>
              {!skin.adjusted.iconId && (
                <span className="text-muted-foreground">{tr("Uses default icon")}</span>
              )}
              {applying && (
                <Spinner aria-label={tr("Updating app icon")} className="absolute top-6 size-4" />
              )}
            </button>
          );
        })}
      </div>
      {skins.appIconOverrideSkinId !== null && (
        <button
          type="button"
          disabled={pending !== null}
          className="rounded text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => void select(null)}
        >
          {tr("Follow current skin")}
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
