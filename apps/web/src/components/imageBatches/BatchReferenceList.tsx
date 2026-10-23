import { useRef, useState } from "react";
import type { ImageBatchSource, ImageInputReference } from "@synara/contracts";
import { Button } from "../ui/button";
import { OptionSelect } from "../ui/option-select";
import { useBatchResults } from "./useImageBatches";
import { assetThumbnailUrl, imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { PreviewSurface } from "../ui/preview-surface";
import { XIcon } from "~/lib/icons";
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
  const limit = tr("At most {count} reference images are allowed.").replace("{count}", String(max));
  const pick = (assetId: string) => {
    if (references.length >= max || references.some((r) => r.assetId === assetId)) return;
    onChange([...references, { id: crypto.randomUUID(), assetId, documentId: null }]);
  };
  return (
    <div className="space-y-2 text-ui">
      <h3 className="font-medium">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {/* Removing is its own small button, so looking at or clicking a reference keeps it. */}
        {references.map((r, i) => (
          <figure key={r.id} className="relative w-20 space-y-1">
            <PreviewSurface checker className="size-20 rounded-md">
              <img
                src={assetThumbnailUrl(r.assetId)}
                alt={tr("Reference") + " " + (i + 1)}
                className="h-full w-full object-contain"
              />
            </PreviewSurface>
            <figcaption className="truncate text-center text-ui-xs text-muted-foreground">
              {tr("Reference")} {i + 1}
            </figcaption>
            <Button
              size="icon-xs"
              variant="secondary"
              className="absolute top-1 right-1"
              disabled={disabled}
              aria-label={tr("Remove reference") + " " + (i + 1)}
              onClick={() => onChange(references.filter((x) => x.id !== r.id))}
            >
              <XIcon className="size-3" />
            </Button>
          </figure>
        ))}
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
            for (const f of files) {
              if (next.length >= max) throw new Error(limit);
              const a = await uploadDrawingImage(f, f.name);
              next.push({ id: crypto.randomUUID(), assetId: a.id, documentId: null });
            }
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
          onPick={pick}
        />
      )}
    </div>
  );
}

/** Saved results of the same batch, so an adopted sample can guide later tasks. */
function ResultReferences({
  batchId,
  disabled,
  picked,
  onPick,
}: {
  batchId: string;
  disabled?: boolean | undefined;
  picked: (assetId: string) => boolean;
  onPick: (assetId: string) => void;
}) {
  const tr = useAhaTranslation();
  const [filter, setFilter] = useState<"adopted" | "all">("adopted");
  const page = useBatchResults({ batchId, filter });
  const results = page.data?.pages.flatMap((p) => p.results) ?? [];
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
