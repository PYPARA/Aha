import "../../index.css";
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { ThreadId, type DesktopBridge } from "@synara/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useBatchFileDraft } from "./useBatchFileDraft";
const original = window.desktopBridge;
afterEach(async () => {
  await cleanup();
  if (original) window.desktopBridge = original;
  else delete window.desktopBridge;
  vi.clearAllMocks();
});
function DraftFixture({ id }: { id: ThreadId }) {
  useBatchFileDraft(id, () => {});
  return <span>File draft</span>;
}
it("restores an arbitrary file draft after composer memory is lost, without sending it", async () => {
  const id = ThreadId.makeUnsafe("draft-" + crypto.randomUUID()),
    file = new File(["source brief"], "brief.custom", { type: "application/octet-stream" });
  const store = useComposerDraftStore.getState();
  store.addFiles(id, [
    { type: "file", id: "file", name: file.name, mimeType: file.type, sizeBytes: file.size, file },
  ]);
  await render(<DraftFixture id={id} />);
  await expect
    .poll(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("aha-batch-file-drafts", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        return await new Promise<boolean>((resolve) => {
          const tx = database.transaction("drafts", "readonly"),
            r = tx.objectStore("drafts").get(id);
          r.onsuccess = () => resolve(!!r.result?.files?.length);
        });
      } finally {
        database.close();
      }
    })
    .toBe(true);
  await cleanup();
  store.removeFile(id, "file");
  await render(<DraftFixture id={id} />);
  await expect
    .poll(() => useComposerDraftStore.getState().draftsByThreadId[id]?.files.length)
    .toBe(1);
  const restored = useComposerDraftStore.getState().draftsByThreadId[id]!.files[0]!;
  expect(restored.name).toBe("brief.custom");
  expect(await restored.file.text()).toBe("source brief");
});
