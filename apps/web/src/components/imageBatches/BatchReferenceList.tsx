import { useRef, useState } from "react";
import type { ImageAsset, ImageBatchSource, ImageInputReference } from "@synara/contracts";
import { Button } from "../ui/button";
import { imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";

/** Reference picker shared by the task editor and the batch style settings. */
export function BatchReferenceList({
  title,
  references,
  sources,
  max,
  disabled,
  onChange,
  onBusy,
  onError,
}: {
  title: string;
  references: ImageInputReference[];
  sources: readonly ImageBatchSource[];
  max: number;
  disabled?: boolean;
  onChange: (references: ImageInputReference[]) => void;
  onBusy?: (busy: boolean) => void;
  onError: (cause: unknown) => void;
}) {
  const tr = useAhaTranslation();
  const file = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<Record<string, ImageAsset>>({});
  const known = (assetId: string) =>
    uploaded[assetId] ?? sources.find((s) => s.asset?.id === assetId)?.asset ?? null;
  const limit = tr("At most {count} reference images are allowed.").replace("{count}", String(max));
  return (
    <div className="space-y-2 text-ui">
      <h3 className="font-medium">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {references.map((r, i) => {
          const asset = known(r.assetId);
          return (
            <Button
              key={r.id}
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-label={tr("Remove reference") + " " + (i + 1)}
              onClick={() => onChange(references.filter((x) => x.id !== r.id))}
            >
              {asset && (
                <img src={imageUrl(asset, "thumbnail")} alt="" className="size-5 object-contain" />
              )}
              {tr("Reference")} {i + 1} ×
            </Button>
          );
        })}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          onBusy?.(true);
          void (async () => {
            const next = [...references];
            const assets: Record<string, ImageAsset> = {};
            for (const f of files) {
              if (next.length >= max) throw new Error(limit);
              const a = await uploadDrawingImage(f, f.name);
              assets[a.id] = a;
              next.push({ id: crypto.randomUUID(), assetId: a.id, documentId: null });
            }
            setUploaded((current) => ({ ...current, ...assets }));
            onChange(next);
          })()
            .catch(onError)
            .finally(() => onBusy?.(false));
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || references.length >= max}
        onClick={() => file.current?.click()}
      >
        {tr("Add reference image")}
      </Button>
      <div className="flex flex-wrap gap-2">
        {sources
          .filter((s) => s.asset)
          .map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              aria-label={tr("Use reference") + ": " + s.name}
              className="rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                if (references.length >= max || references.some((r) => r.assetId === s.asset!.id))
                  return;
                onChange([
                  ...references,
                  { id: crypto.randomUUID(), assetId: s.asset!.id, documentId: null },
                ]);
              }}
            >
              <img
                src={imageUrl(s.asset!, "thumbnail")}
                alt={s.name}
                className="size-16 rounded object-contain"
              />
            </button>
          ))}
      </div>
    </div>
  );
}
