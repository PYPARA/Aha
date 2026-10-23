import { useEffect, useRef, useState } from "react";
import type { ImageAsset, ImageBatchSource, ImageInputReference } from "@synara/contracts";
import { Button } from "../ui/button";
import { OptionSelect } from "../ui/option-select";
import { useBatchResults } from "./useImageBatches";
import { imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";

/** Reference picker shared by the task editor and the batch style settings. */
export function BatchReferenceList({
  title,
  references,
  sources,
  batchId,
  max,
  disabled,
  onChange,
  onBusy,
  onError,
}: {
  title: string;
  references: ImageInputReference[];
  sources: readonly ImageBatchSource[];
  /** Offers this batch's saved results as references (task editor only). */
  batchId?: string | undefined;
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
  const pick = (assetId: string) => {
    if (references.length >= max || references.some((r) => r.assetId === assetId)) return;
    onChange([...references, { id: crypto.randomUUID(), assetId, documentId: null }]);
  };
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
              onClick={() => pick(s.asset!.id)}
            >
              <img
                src={imageUrl(s.asset!, "thumbnail")}
                alt={s.name}
                className="size-16 rounded object-contain"
              />
            </button>
          ))}
      </div>
      {batchId && (
        <ResultReferences
          batchId={batchId}
          disabled={disabled || references.length >= max}
          picked={(assetId) => references.some((r) => r.assetId === assetId)}
          onLoaded={(assets) =>
            setUploaded((current) =>
              assets.every((a) => current[a.id]) ? current : { ...current, ...byId(assets) },
            )
          }
          onPick={pick}
        />
      )}
    </div>
  );
}

const byId = (assets: readonly ImageAsset[]) => Object.fromEntries(assets.map((a) => [a.id, a]));

/** Saved results of the same batch, so an adopted sample can guide later tasks. */
function ResultReferences({
  batchId,
  disabled,
  picked,
  onLoaded,
  onPick,
}: {
  batchId: string;
  disabled?: boolean | undefined;
  picked: (assetId: string) => boolean;
  onLoaded: (assets: ImageAsset[]) => void;
  onPick: (assetId: string) => void;
}) {
  const tr = useAhaTranslation();
  const [filter, setFilter] = useState<"adopted" | "all">("adopted");
  const page = useBatchResults({ batchId, filter });
  const results = page.data?.pages.flatMap((p) => p.results) ?? [];
  useEffect(() => {
    if (results.length) onLoaded(results.map((r) => r.asset));
  }, [results.map((r) => r.id).join(",")]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 text-ui-sm font-medium">{tr("From this batch's results")}</h4>
        <div className="w-32">
          <OptionSelect
            label={tr("Result filter")}
            value={filter}
            onValueChange={(v) => setFilter(v as typeof filter)}
          >
            <option value="adopted">{tr("Adopted")}</option>
            <option value="all">{tr("All results")}</option>
          </OptionSelect>
        </div>
      </div>
      {!results.length && !page.isPending && (
        <p className="text-ui-sm text-muted-foreground">
          {tr(
            filter === "adopted"
              ? "No adopted results yet. Generate and adopt a sample first."
              : "No results",
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            disabled={disabled || picked(r.asset.id)}
            aria-label={tr("Use reference") + ": " + r.taskName + " " + (r.position + 1)}
            className="rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={() => onPick(r.asset.id)}
          >
            <img
              src={imageUrl(r.asset, "thumbnail")}
              alt={r.taskName}
              className="size-16 rounded object-contain"
            />
          </button>
        ))}
      </div>
      {page.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          disabled={page.isFetchingNextPage}
          onClick={() => void page.fetchNextPage()}
        >
          {tr("Load more")}
        </Button>
      )}
    </div>
  );
}
