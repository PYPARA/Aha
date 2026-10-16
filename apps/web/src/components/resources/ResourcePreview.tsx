import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  resourceType,
  type ResourceEntry,
  type ResourceReadResult,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { FileIcon, FolderIcon } from "~/lib/icons";
import { resourceApi, resourceKey } from "./resourceLibrary";

export const resourceFieldClassName =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

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
  const [image, setImage] = useState<{ data: ResourceReadResult; url: string } | null>(null);
  const isImage = entry.kind === "file" && resourceType(entry.name) === "image";
  const preview = useQuery({
    queryKey: [...resourceKey, "preview", entry.id, entry.hash, large],
    queryFn: () => resourceApi<ResourceReadResult>({ op: "read", id: entry.id, thumbnail: !large }),
    enabled: isImage,
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!preview.data) return;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(preview.data.bytes)], { type: preview.data.mimeType }),
    );
    setImage({ data: preview.data, url });
    return () => URL.revokeObjectURL(url);
  }, [preview.data]);

  if (image && image.data === preview.data)
    return (
      <img
        src={image.url}
        alt={entry.name}
        className={
          large ? "max-h-[60vh] max-w-full object-contain" : "h-full w-full object-contain p-2"
        }
        loading={large ? "eager" : "lazy"}
      />
    );
  if (large && isImage)
    return (
      <p role={preview.error ? "alert" : "status"} className="text-sm text-muted-foreground">
        {tr(preview.error?.message ?? "Loading...")}
      </p>
    );
  return entry.kind === "directory" ? (
    <FolderIcon className="size-10 text-muted-foreground" />
  ) : (
    <FileIcon className="size-9 text-muted-foreground" />
  );
}
