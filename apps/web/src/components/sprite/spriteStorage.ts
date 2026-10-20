import { SpriteProjectDataSchema } from "@synara/contracts/spriteLibrarySchema";
import { awaitIdbRequest, waitForIdbTransaction } from "~/lib/indexedDb";
import {
  type SpriteProjectData,
  type SpriteLibrarySnapshot,
  type SpriteProjectSummary,
} from "@synara/contracts/spriteLibrary";
import { renderSpriteFrame } from "./spriteFiles";
import type { SpriteProject } from "./spriteModel";
import { drawingApi } from "../drawing/useDrawing";

const bridge = () => {
  const desktop = window.desktopBridge;
  if (desktop && !desktop.spriteLibrary)
    throw new Error("Update the desktop app to enable sprite file storage.");
  return desktop?.spriteLibrary;
};
// A fresh store: intentionally never opens aha-sprites-v1.
const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("aha-sprite-library-v2", 2);
    request.onupgradeneeded = () => {
      for (const name of ["projects", "summaries", "thumbnails", "deleted", "migrationBackups"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open sprite storage.")),
    );
    request.onblocked = () =>
      reject(new Error("Sprite storage is blocked. Close other app windows."));
  });
let tail: Promise<unknown> = Promise.resolve();
const blockedIds = new Set<string>();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn);
  tail = next.catch(() => {});
  return next;
}
async function transaction<T>(
  names: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
) {
  const db = await open();
  try {
    const tx = db.transaction(names, mode),
      done = waitForIdbTransaction(tx, "Sprite storage");
    // Observe rejection even when an individual request rejects first.
    void done.catch(() => {});
    const result = await run(tx);
    await done;
    return result;
  } finally {
    db.close();
  }
}
async function thumbnail(project: SpriteProject): Promise<Blob | null> {
  const source = project.actions.some((a) => a.frames.length) ? undefined : project.sources[0];
  const frame = project.actions.flatMap((a) => a.frames)[0];
  if (!source && !frame) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const bitmap = source
    ? await createImageBitmap(source.blob)
    : await createImageBitmap(await renderSpriteFrame(project, frame!));
  try {
    const scale = Math.min(128 / bitmap.width, 128 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)),
      height = Math.max(1, Math.round(bitmap.height * scale));
    ctx.drawImage(bitmap, (128 - width) / 2, (128 - height) / 2, width, height);
  } finally {
    bitmap.close();
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not save sprite thumbnail."))),
      "image/png",
    ),
  );
}
export async function serializeSpriteProject(project: SpriteProject) {
  const images = [];
  const sources = [];
  for (const { blob, ...source } of project.sources) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1];
    const file = `images/${hash}.${ext}`;
    images.push({ file, bytes });
    sources.push({ ...source, file, mimeType: blob.type });
  }
  const data = SpriteProjectDataSchema.parse({ ...project, sources });
  return { data, images };
}
export function saveSpriteProject(project: SpriteProject): Promise<void> {
  if (blockedIds.has(project.id))
    return Promise.reject(new Error("This sprite project is being deleted."));
  return serial(async () => {
    if (blockedIds.has(project.id)) throw new Error("This sprite project is being deleted.");
    if (!project.name.trim() || project.name.trim().length > 200)
      throw new Error("Enter a project name (1–200 characters).");
    const thumb = await thumbnail(project);
    if (bridge()) {
      const { data, images } = await serializeSpriteProject(project);
      await bridge()!.request({
        op: "save",
        project: data,
        images,
        thumbnail: thumb ? new Uint8Array(await thumb.arrayBuffer()) : null,
      });
    } else {
      await transaction(
        ["projects", "summaries", "thumbnails", "deleted", "migrationBackups"],
        "readwrite",
        async (tx) => {
          if (
            await awaitIdbRequest(
              tx.objectStore("deleted").get(project.id),
              "Could not read sprite deletion state.",
            )
          )
            throw new Error("This sprite project is being deleted.");
          const previous = (await awaitIdbRequest(
            tx.objectStore("projects").get(project.id),
            "Could not read sprite backup.",
          )) as SpriteProject | undefined;
          if (
            previous &&
            project.sources.some((s) => s.usage === "generated-frame") &&
            !previous.sources.some((s) => s.usage === "generated-frame") &&
            !(await awaitIdbRequest(
              tx.objectStore("migrationBackups").get(project.id),
              "Could not read sprite backup.",
            ))
          )
            tx.objectStore("migrationBackups").put(previous, project.id);
          tx.objectStore("projects").put(project, project.id);
          tx.objectStore("summaries").put(
            {
              id: project.id,
              name: project.name,
              updatedAt: project.updatedAt,
              actionCount: project.actions.length,
              deleting: false,
            } satisfies SpriteProjectSummary,
            project.id,
          );
          if (thumb) tx.objectStore("thumbnails").put(thumb, project.id);
          else tx.objectStore("thumbnails").delete(project.id);
        },
      );
    }
  });
}
export async function listSpriteProjects(): Promise<SpriteLibrarySnapshot> {
  await tail;
  if (bridge()) {
    const snapshot = await bridge()!.request<SpriteLibrarySnapshot>({ op: "list" });
    return {
      ...snapshot,
      projects: snapshot.projects.map((p) =>
        blockedIds.has(p.id) ? Object.assign({}, p, { deleting: true }) : p,
      ),
    };
  }
  const projects = (await transaction(["summaries"], "readonly", (tx) =>
    awaitIdbRequest(tx.objectStore("summaries").getAll(), "Could not load sprite projects."),
  )) as SpriteProjectSummary[];
  return {
    root: null,
    projects: projects.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
export async function getSpriteProject(id: string): Promise<SpriteProject> {
  await tail;
  if (bridge()) {
    const data = await bridge()!.request<SpriteProjectData>({ op: "get", id });
    const sources = await Promise.all(
      data.sources.map(async ({ file, mimeType, ...s }) => {
        const bytes = await bridge()!.request<Uint8Array>({ op: "readImage", id, file });
        return { ...s, blob: new Blob([new Uint8Array(bytes)], { type: mimeType }) };
      }),
    );
    return { ...data, sources };
  }
  const project = (await transaction(["projects", "deleted"], "readonly", async (tx) => {
    if (
      await awaitIdbRequest(
        tx.objectStore("deleted").get(id),
        "Could not read sprite deletion state.",
      )
    )
      throw new Error("This sprite project is being deleted.");
    return awaitIdbRequest(tx.objectStore("projects").get(id), "Could not open sprite project.");
  })) as SpriteProject | undefined;
  if (!project) throw new Error("Sprite project not found.");
  const { sources, ...raw } = project;
  // Normalize the current v2 browser library; never open the retired v1 database.
  const { threadId: legacyId, ...clean } = raw as typeof raw & { threadId?: string | null };
  const normalized = {
    ...clean,
    threadIds: raw.threadIds ?? (legacyId ? [legacyId] : []),
    activeThreadId: raw.activeThreadId ?? legacyId ?? null,
  };
  return { ...normalized, sources };
}
export async function readSpriteThumbnail(id: string): Promise<Blob | null> {
  if (bridge()) {
    try {
      const bytes = await bridge()!.request<Uint8Array>({
        op: "readImage",
        id,
        file: "thumbnail.png",
      });
      return new Blob([new Uint8Array(bytes)], { type: "image/png" });
    } catch {
      return null;
    }
  }
  return (
    (await transaction(["thumbnails"], "readonly", (tx) =>
      awaitIdbRequest(tx.objectStore("thumbnails").get(id), "Could not load sprite thumbnail."),
    )) ?? null
  );
}
export async function renameSpriteProject(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new Error("Enter a project name (1–200 characters).");
  if (bridge()) {
    await tail;
    await bridge()!.request({ op: "rename", id, name: trimmed });
  } else {
    const p = await getSpriteProject(id);
    await saveSpriteProject({ ...p, name: trimmed, updatedAt: new Date().toISOString() });
  }
}
export async function deleteSpriteProject(id: string) {
  blockedIds.add(id);
  let intentPersisted = false;
  try {
    // Finish outstanding writes before persisting the deletion intent.
    await tail;
    if (bridge()) await bridge()!.request({ op: "beginDelete", id });
    else
      await transaction(["deleted", "summaries"], "readwrite", async (tx) => {
        tx.objectStore("deleted").put(true, id);
        const summary = (await awaitIdbRequest(
          tx.objectStore("summaries").get(id),
          "Could not read sprite project.",
        )) as SpriteProjectSummary | undefined;
        if (summary) tx.objectStore("summaries").put({ ...summary, deleting: true }, id);
      });
    intentPersisted = true;
    await drawingApi().spriteCommand({ operation: "delete", projectId: id });
    if (bridge()) await bridge()!.request({ op: "finishDelete", id });
    else
      await transaction(
        ["projects", "summaries", "thumbnails", "migrationBackups"],
        "readwrite",
        async (tx) => {
          for (const store of ["projects", "summaries", "thumbnails", "migrationBackups"])
            tx.objectStore(store).delete(id);
        },
      );
  } catch (error) {
    if (!intentPersisted) blockedIds.delete(id);
    throw Object.assign(new Error(spriteErrorMessage(error)), { deletionStarted: intentPersisted });
  }
}
export async function revealSpriteDirectory() {
  await bridge()?.request({ op: "reveal" });
}

export function spriteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method ['"]aha:sprites:request['"]: (?:Error: )?/,
    "",
  );
}
