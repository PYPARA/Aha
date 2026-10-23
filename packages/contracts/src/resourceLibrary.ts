// Desktop resource library contract. Keep channel names safe for the sandboxed preload.
export const RESOURCE_CHANNELS = {
  request: "aha:resources:request",
  changed: "aha:resources:changed",
  progress: "aha:resources:progress",
} as const;
export interface ResourceOrigin {
  kind: "drawing" | "chat" | "local" | "game" | "image-batch" | "sprite";
  threadId?: string | undefined;
  messageId?: string | undefined;
  jobId?: string | undefined;
  batchId?: string | undefined;
  taskId?: string | undefined;
  attemptId?: string | undefined;
  resultId?: string | undefined;
  /** Sprite project that exported the file (kind "sprite"). */
  projectId?: string | undefined;
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
  revision?: number;
  scan?: ResourceScanState;
  directoryStats?: ResourceDirectoryStats[];
}
export interface ResourceDirectoryStats {
  id: string | null;
  path: string;
  directFiles: number;
  directDirectories: number;
  recursiveFiles: number;
}
export interface ResourceScanState {
  phase: "loading" | "scanning" | "ready" | "failed";
  lastCompletedAt: number | null;
  failedPath: string | null;
  skipped: { system: number; temporary: number; symbolicLinks: number; unsupported: number };
}
export interface ResourceQuery {
  path: string;
  kind?: "file" | "directory" | undefined;
  recursive?: boolean | undefined;
  query?: string | undefined;
  searchIn?: "name" | "nameAndPath" | undefined;
  tag?: string | undefined;
  originKind?: ResourceOrigin["kind"] | undefined;
  type?: "all" | "image" | "audio" | "video" | "document" | "other" | undefined;
  sort?: "name" | "modified" | undefined;
  offset?: number | undefined;
}
export interface ResourcePage {
  entries: ResourceEntry[];
  total: number;
  revision?: number;
  stats?: { scopeFiles: number; matchedFiles: number; matchedDirectories: number };
}
export interface ResourceLocateResult {
  entry: ResourceEntry;
  parentId: string | null;
  parentPath: string;
  offset: number;
  revision: number;
}
export interface ResourceLinkState {
  status: "available" | "removed" | "other-library" | "unavailable";
  name?: string | undefined;
  error?: string | undefined;
}
export interface ResourceImportResult {
  added: number;
  skipped: number;
  failed: { name: string; error: string; path?: string }[];
  cancelled: boolean;
}
export interface ResourceCollectionItem {
  resultId: string;
  assetId: string;
  name: string;
  origin: ResourceOrigin;
  status: "queued" | "writing" | "committed" | "linked" | "failed" | "superseded";
  resourceId?: string | undefined;
  path?: string | undefined;
  fileKey?: string | undefined;
  error?: string | undefined;
}
/** Durable application-level copy receipt. The target is a stable library and directory identity. */
export interface ResourceCollectionOperation {
  id: string;
  libraryId: string;
  directoryId: string | null;
  directoryKey: string;
  createdAt: string;
  items: ResourceCollectionItem[];
  released?: boolean | undefined;
}
export interface ResourceProgress {
  name: string;
  completed: number;
}
export type ResourceTagMode = "add" | "remove" | "replace";
export type ResourceBatchAction = "rename" | "move" | "trash" | "export";
export interface ResourceBatchItem {
  id: string;
  source: string;
  target?: string | undefined;
  status: "ready" | "skipped" | "failed";
  error?: string | undefined;
}
export interface ResourceBatchPlan {
  id: string;
  libraryId: string;
  action: ResourceBatchAction;
  items: ResourceBatchItem[];
  affectedCount: number;
}
export interface ResourceBatchItemResult extends Omit<ResourceBatchItem, "status"> {
  status: "succeeded" | "skipped" | "failed" | "cancelled";
}
export interface ResourceBatchResult {
  planId: string;
  items: ResourceBatchItemResult[];
}
export const DRAWING_RESOURCE_LIMITS = {
  mimeTypes: ["image/png", "image/jpeg", "image/webp"] as readonly string[],
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 80 * 1024 * 1024,
  count: 16,
} as const;
export function drawingResourceError(
  file: { type: string; size: number },
  existing: { count: number; bytes: number },
): string | null {
  if (
    !DRAWING_RESOURCE_LIMITS.mimeTypes.includes(file.type) ||
    file.size > DRAWING_RESOURCE_LIMITS.fileBytes
  )
    return "Choose PNG, JPEG or WebP images up to 20 MiB each.";
  if (
    existing.count >= DRAWING_RESOURCE_LIMITS.count ||
    existing.bytes + file.size > DRAWING_RESOURCE_LIMITS.totalBytes
  )
    return "Reference image limit exceeded (16 images / 80 MiB).";
  return null;
}
export type ResourceCommand =
  | { op: "listCollections" }
  | {
      op: "prepareCollection";
      id: string;
      libraryId: string;
      directoryId: string | null;
      items: Pick<ResourceCollectionItem, "resultId" | "assetId" | "name" | "origin">[];
    }
  | { op: "commitCollection"; operationId: string; resultId: string; bytes: Uint8Array }
  | { op: "linkCollection"; operationId: string; resultId: string }
  | { op: "failCollection"; operationId: string; resultId: string; error: string }
  | { op: "retryCollection"; operationId: string }
  | { op: "finishCollection"; operationId: string }
  | { op: "snapshot" | "refresh" | "chooseRoot" | "cancelImport" }
  | { op: "list"; query: ResourceQuery }
  | { op: "locate"; id: string; sort?: ResourceQuery["sort"] }
  | { op: "resourceState"; libraryId: string; id: string }
  | { op: "createDirectory"; parent: string; name: string }
  | { op: "rename"; ids: string[]; name: string }
  | { op: "move"; ids: string[]; target: string }
  | {
      op: "metadata";
      ids: string[];
      tags?: string[] | undefined;
      tagMode?: ResourceTagMode | undefined;
      notes?: string | undefined;
    }
  | {
      op: "prepareBatch";
      action: ResourceBatchAction;
      ids: string[];
      name?: string | undefined;
      target?: string | undefined;
    }
  | { op: "executeBatch"; planId: string; retryFailed?: boolean | undefined }
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
