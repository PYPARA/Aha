import type { ImageBatchResult } from "@synara/contracts";

const EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};

/** Name used when a task has no output path: task name, attempt and position. */
export function resultFilename(r: ImageBatchResult) {
  const characters = [...r.taskName.replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_")].slice(0, 80);
  let name = "";
  const encoder = new TextEncoder();
  for (const character of characters) {
    if (encoder.encode(name + character).byteLength > 180) break;
    name += character;
  }
  name ||= "image";
  return (
    name +
    "_" +
    r.attemptId.slice(0, 8) +
    "_" +
    (r.position + 1) +
    "." +
    r.asset.mimeType.split("/")[1]
  );
}

/** Splits an output path into folder and file stem, keeping the extension that matches the image. */
function outputParts(output: string, mimeType: string) {
  const slash = output.lastIndexOf("/");
  const folder = slash < 0 ? "" : output.slice(0, slash);
  const file = output.slice(slash + 1);
  const allowed = EXTENSIONS[mimeType] ?? ["." + mimeType.split("/")[1]];
  const dot = file.lastIndexOf(".");
  const ext = dot > 0 ? file.slice(dot) : "";
  const known = Object.values(EXTENSIONS).flat().includes(ext.toLowerCase());
  return {
    folder,
    stem: known ? file.slice(0, dot) : file,
    ext: allowed.includes(ext.toLowerCase()) ? ext : allowed[0]!,
  };
}

/**
 * Delivery names for the selected results. With an output path, the first adopted candidate of a
 * task takes the exact file name and the others are numbered `-2`, `-3`…; a task without an
 * adopted candidate numbers all of them from `-1`. Without an output path the legacy name is used.
 */
export function resultFileNames(results: readonly ImageBatchResult[]) {
  const names = new Map<string, { name: string; folder?: string }>();
  const byTask = new Map<string, ImageBatchResult[]>();
  for (const r of results) {
    if (!r.output) names.set(r.id, { name: resultFilename(r) });
    else byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  }
  for (const group of byTask.values()) {
    const ordered = group.toSorted(
      (a, b) =>
        Number(b.adopted) - Number(a.adopted) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.attemptId.localeCompare(b.attemptId) ||
        a.position - b.position,
    );
    const exact = ordered[0]!.adopted;
    ordered.forEach((r, i) => {
      const { folder, stem, ext } = outputParts(r.output!, r.asset.mimeType);
      const name = exact && i === 0 ? stem + ext : `${stem}-${i + 1}${ext}`;
      names.set(r.id, { name, ...(folder ? { folder } : {}) });
    });
  }
  return names;
}
