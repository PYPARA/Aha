import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "~/lib/indexedDb";
import type { SpriteProject } from "./spriteModel";
const open = () =>
  openIndexedDbDatabase({
    name: "aha-sprites-v1",
    version: 1,
    storeName: "projects",
    keyPath: "id",
    label: "sprite projects",
  });
let tail: Promise<unknown> = Promise.resolve();
export function saveSpriteProject(project: SpriteProject): Promise<void> {
  const result = tail.then(async () => {
    const db = await open();
    try {
      const tx = db.transaction("projects", "readwrite");
      const done = waitForIdbTransaction(tx, "Save sprite project");
      tx.objectStore("projects").put(project);
      await done;
    } finally {
      db.close();
    }
  });
  tail = result.catch(() => {});
  return result;
}
export async function listSpriteProjects(): Promise<SpriteProject[]> {
  await tail;
  const db = await open();
  try {
    const tx = db.transaction("projects", "readonly");
    const done = waitForIdbTransaction(tx, "Read sprite projects");
    const result = await awaitIdbRequest(
      tx.objectStore("projects").getAll(),
      "Could not load sprite projects.",
    );
    await done;
    return (result as SpriteProject[]).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } finally {
    db.close();
  }
}
export async function deleteSpriteProject(id: string) {
  await tail;
  const db = await open();
  try {
    const tx = db.transaction("projects", "readwrite");
    const done = waitForIdbTransaction(tx, "Delete sprite project");
    tx.objectStore("projects").delete(id);
    await done;
  } finally {
    db.close();
  }
}
