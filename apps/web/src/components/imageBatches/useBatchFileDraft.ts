import { useEffect } from "react";
import type { ThreadId } from "@synara/contracts";
import { useComposerDraftStore, type ComposerFileAttachment } from "~/composerDraftStore";
import { openIndexedDbDatabase, awaitIdbRequest, waitForIdbTransaction } from "~/lib/indexedDb";

const open = () =>
  openIndexedDbDatabase({
    name: "aha-batch-file-drafts",
    version: 1,
    storeName: "drafts",
    keyPath: "threadId",
    label: "batch file drafts",
  });
/** Ordinary chat file intake stays shared; batch workspaces additionally retain unsent files on reload. */
export function useBatchFileDraft(threadId: ThreadId | null, onError: (error: unknown) => void) {
  useEffect(() => {
    if (!threadId) return;
    let stopped = false;
    let tail = Promise.resolve();
    let subscribed: (() => void) | undefined;
    const failure = onError;
    void (async () => {
      const database = await open();
      try {
        const tx = database.transaction("drafts", "readonly"),
          done = waitForIdbTransaction(tx, "Batch file draft");
        const record = (await awaitIdbRequest(
          tx.objectStore("drafts").get(threadId),
          "Could not restore file draft.",
        )) as { files: ComposerFileAttachment[] } | undefined;
        await done;
        if (stopped) return;
        const store = useComposerDraftStore.getState();
        if (record?.files?.length && !store.draftsByThreadId[threadId]?.files.length) {
          store.addFiles(
            threadId,
            record.files.map((attachment) => ({
              ...attachment,
              file: new File([attachment.file], attachment.name, { type: attachment.mimeType }),
            })),
          );
        }
      } finally {
        database.close();
      }
      if (stopped) return;
      let previous = useComposerDraftStore.getState().draftsByThreadId[threadId]?.files;
      const save = (files: ComposerFileAttachment[]) => {
        tail = tail
          .then(async () => {
            const database = await open();
            try {
              const tx = database.transaction("drafts", "readwrite"),
                done = waitForIdbTransaction(tx, "Batch file draft");
              if (files.length) tx.objectStore("drafts").put({ threadId, files });
              else tx.objectStore("drafts").delete(threadId);
              await done;
            } finally {
              database.close();
            }
          })
          .catch(failure);
      };
      save(previous ?? []);
      subscribed = useComposerDraftStore.subscribe((state) => {
        const files = state.draftsByThreadId[threadId]?.files;
        if (files !== previous) {
          previous = files;
          save(files ?? []);
        }
      });
    })().catch(failure);
    return () => {
      stopped = true;
      subscribed?.();
    };
    // Error reporting must not remount storage on every workbench event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
}
