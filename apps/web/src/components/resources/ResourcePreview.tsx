import { lazy, Suspense, useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  resourceType,
  type ResourceEntry,
  type ResourceReadResult,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { FileIcon, FolderIcon } from "~/lib/icons";
import { resourceApi, resourceKey, ResourceLibraryIdContext } from "./resourceLibrary";
const ModelViewer = lazy(() => import("../model3d/ModelViewer"));
// One object URL per cached preview, released when the query cache drops that preview.
const previewUrls = new WeakMap<ResourceReadResult, string>();
const releasePreviewUrl = new FinalizationRegistry<string>((url) => URL.revokeObjectURL(url));
function previewUrl(data: ResourceReadResult) {
  let url = previewUrls.get(data);
  if (!url) {
    url = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mimeType }));
    previewUrls.set(data, url);
    releasePreviewUrl.register(data, url);
  }
  return url;
}

// Keep IPC and image decoding responsive when a full page mounts at once. Waiting
// reads are removed when their query is disposed (page/library changes).
let activeReads = 0;
const waitingReads: (() => void)[] = [];
function pumpPreviews() {
  // eslint-disable-next-line no-unmodified-loop-condition -- each queued start acquires a read slot.
  while (activeReads < 4 && waitingReads.length) waitingReads.shift()!();
}
function readPreview(id: string, thumbnail: boolean, signal: AbortSignal) {
  return new Promise<ResourceReadResult>((resolve, reject) => {
    const cancel = () => {
      const index = waitingReads.indexOf(start);
      if (index >= 0) waitingReads.splice(index, 1);
      reject(new DOMException("Preview cancelled", "AbortError"));
    };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) {
        cancel();
        return;
      }
      activeReads++;
      void resourceApi<ResourceReadResult>({ op: "read", id, thumbnail })
        .then(resolve, reject)
        .finally(() => {
          // Yield between groups so query notifications and image layout settle.
          setTimeout(() => {
            activeReads--;
            pumpPreviews();
          }, 0);
        });
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    waitingReads.push(start);
    pumpPreviews();
  });
}

export const humanResourceBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

export function ResourcePreview({
  entry,
  large = false,
}: {
  entry: ResourceEntry;
  large?: boolean;
}) {
  const tr = useAhaTranslation();
  const [decodeError, setDecodeError] = useState(false);
  const libraryId = useContext(ResourceLibraryIdContext);
  const isImage = entry.kind === "file" && resourceType(entry.name) === "image";
  const isModel = large && entry.kind === "file" && resourceType(entry.name) === "model3d";
  const preview = useQuery({
    queryKey: [...resourceKey, "preview", libraryId, entry.id, entry.hash, large],
    queryFn: ({ signal }) => readPreview(entry.id, !large, signal),
    enabled: isImage || isModel,
    retry: false,
    staleTime: Infinity,
  });
  // Read during render, so a remounted tile with a cached thumbnail shows it on the first frame.
  const url = preview.data && !isModel ? previewUrl(preview.data) : null;
  useEffect(() => setDecodeError(false), [url]);

  if (isModel && preview.data)
    return (
      <div className="flex h-[min(60vh,32rem)] w-full min-w-0">
        <Suspense fallback={<p className="p-3 text-ui-sm">{tr("Loading model…")}</p>}>
          <ModelViewer bytes={preview.data.bytes} />
        </Suspense>
      </div>
    );

  if (url && !decodeError)
    return (
      <img
        src={url}
        alt={entry.name}
        className={
          large ? "max-h-[60vh] max-w-full object-contain" : "h-full w-full object-contain p-2"
        }
        loading={large ? "eager" : "lazy"}
        onError={() => setDecodeError(true)}
      />
    );
  if ((isImage || isModel) && (large || preview.error || decodeError))
    return (
      <span
        role={large && (preview.error || decodeError) ? "alert" : "status"}
        className="flex max-w-full flex-col items-center gap-2 p-3 text-ui-xs text-muted-foreground"
      >
        <FileIcon className="size-6" />
        <span>{tr(preview.error || decodeError ? "Preview unavailable" : "Loading...")}</span>
      </span>
    );
  return entry.kind === "directory" ? (
    <FolderIcon className="size-10 text-muted-foreground" />
  ) : (
    <FileIcon className="size-9 text-muted-foreground" />
  );
}
