import { useEffect, useState } from "react";

/** Object URL for a stored appearance image; null while loading, missing or unreadable. */
export function useAhaImageUrl(id: string | null): string | null {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    let url: string | undefined;
    void window.desktopBridge?.ahaAppearance
      ?.readImage(id)
      .then((result) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mime }));
        setImage({ id, url });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return image?.id === id ? image.url : null;
}
