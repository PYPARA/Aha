// Desktop resource library contract. Keep channel names safe for the sandboxed preload.
export const RESOURCE_CHANNELS = {
  request: "aha:resources:request",
  changed: "aha:resources:changed",
  progress: "aha:resources:progress",
} as const;
export interface ResourceOrigin {
  kind: "drawing" | "chat" | "local" | "game";
  threadId?: string | undefined;
  messageId?: string | undefined;
  jobId?: string | undefined;
  batchId?: string | undefined;
  prompt?: string | undefined;
  model?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}
export interface ResourceEntry {
  id: string;
  path: string;
  name: string;
  kind: "directory" | "file";
  bytes: number;
  modifiedAt: number;
  tags: string[];
  notes: string;
  origin?: ResourceOrigin | undefined;
  hash: string;
  fileKey: string;
  deleted?: boolean | undefined;
}
export interface ResourceSnapshot {
  root: string | null;
  libraryId: string | null;
  directories: ResourceEntry[];
  count: number;
  error: string | null;
}
export interface ResourceQuery {
  path: string;
  recursive?: boolean | undefined;
  query?: string | undefined;
  tag?: string | undefined;
  type?: "all" | "image" | "audio" | "video" | "document" | "other" | undefined;
  sort?: "name" | "modified" | undefined;
  offset?: number | undefined;
}
export interface ResourcePage {
  entries: ResourceEntry[];
  total: number;
}
export interface ResourceImportResult {
  added: number;
  skipped: number;
  failed: { name: string; error: string; path?: string }[];
  cancelled: boolean;
}
export interface ResourceProgress {
  name: string;
  completed: number;
}
export type ResourceCommand =
  | { op: "snapshot" | "refresh" | "chooseRoot" | "cancelImport" }
  | { op: "list"; query: ResourceQuery }
  | { op: "createDirectory"; parent: string; name: string }
  | { op: "rename"; ids: string[]; name: string }
  | { op: "move"; ids: string[]; target: string }
  | { op: "metadata"; ids: string[]; tags?: string[] | undefined; notes?: string | undefined }
  | { op: "trash" | "export"; ids: string[] }
  | { op: "reveal"; id?: string | undefined }
  | { op: "read"; id: string; thumbnail?: boolean | undefined }
  | {
      op: "importPaths";
      target: string;
      paths?: string[] | undefined;
      directories?: boolean | undefined;
      origin?: ResourceOrigin | undefined;
    }
  | {
      op: "importBytes";
      target: string;
      name: string;
      bytes: Uint8Array;
      origin?: ResourceOrigin | undefined;
    };
export interface ResourceReadResult {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ResourceLibraryBridge {
  request<T = unknown>(command: ResourceCommand): Promise<T>;
  onChanged(listener: () => void): () => void;
  onProgress(listener: (progress: ResourceProgress) => void): () => void;
}
export function resourceType(name: string): NonNullable<ResourceQuery["type"]> {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tiff", "svg"].includes(ext))
    return "image";
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["pdf", "txt", "md", "json", "csv", "docx", "xlsx", "yaml", "xml"].includes(ext))
    return "document";
  return "other";
}
