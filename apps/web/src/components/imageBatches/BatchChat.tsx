import { useRef, useState, useEffect } from "react";
import { ThreadId, type ImageBatchState } from "@synara/contracts";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useAppSettings, getProviderInstanceOptions } from "~/appSettings";
import {
  useComposerDraftStore,
  resolvePreferredComposerModelSelection,
} from "~/composerDraftStore";
import { ensureHomeChatProject } from "~/lib/chatProjects";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { useStore } from "~/store";
import { createDraftThread } from "~/lib/draftThreadCreate";
import { DEFAULT_RUNTIME_MODE, DEFAULT_INTERACTION_MODE } from "~/types";
import { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { batchApi, useBatchCommand } from "./useImageBatches";
import { useBatchFileDraft } from "./useBatchFileDraft";

export function BatchChat({
  batch,
  onError,
}: {
  batch: ImageBatchState;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation();
  const { settings } = useAppSettings();
  const command = useBatchCommand();
  const creating = useRef<Promise<void> | null>(null);
  const preparedThread = useRef<ThreadId | null>(null);
  const [busy, setBusy] = useState(false);
  const [bridge] = useState(() => new EmbeddedChatAttachments());
  const id = batch.threadId ? ThreadId.makeUnsafe(batch.threadId) : null;
  useBatchFileDraft(id, onError);
  useEffect(() => (id ? retainThreadDetailSubscription(id) : undefined), [id]);
  const create = () => {
    if (creating.current) return creating.current;
    setBusy(true);
    creating.current = (async () => {
      const projectId = await ensureHomeChatProject(useWorkspacePathsStore.getState());
      if (!projectId)
        throw new Error(tr("Chat workspace is not ready. Try again after connecting."));
      const composer = useComposerDraftStore.getState();
      const modelSelection = resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: composer.stickyModelSelectionByProvider,
          activeProvider: composer.stickyActiveProvider,
        },
        threadModelSelection: null,
        projectModelSelection: useStore.getState().projects.find((p) => p.id === projectId)
          ?.defaultModelSelection,
        defaultProvider: settings.defaultProvider,
        resolveProviderForInstanceId: (instanceId) =>
          getProviderInstanceOptions(settings).find((p) => p.instanceId === instanceId)?.provider,
      });
      const latest = await batchApi().get({ id: batch.id });
      const draft = latest.threadId
        ? ThreadId.makeUnsafe(latest.threadId)
        : (preparedThread.current ??
          createDraftThread({
            projectId,
            prompt: batch.brief,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            envMode: "local",
          }));
      preparedThread.current = draft;
      // Bind the draft before the first send; the server will inject workbench guidance on that first turn.
      await command({
        operation: "bind-thread",
        batchId: batch.id,
        version: latest.version,
        threadId: draft,
      });
    })()
      .catch(onError)
      .finally(() => {
        setBusy(false);
        creating.current = null;
      });
    return creating.current;
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={tr("Batch conversation")}>
      {id ? (
        <ChatView
          key={id}
          threadId={id}
          attachmentBridge={bridge}
          hideHeader
          surfaceMode="split"
          paneScopeId={"batch-" + batch.id}
          isFocusedPane
          beforeTurnDispatch={async () => {
            const latest = await batchApi().get({ id: batch.id });
            if (latest.threadId !== id)
              throw new Error(tr("Conversation changed. Reload before sending."));
          }}
          panelState={{
            panel: null,
            diffTurnId: null,
            diffFilePath: null,
            hasOpenedPanel: false,
            lastOpenPanel: "browser",
          }}
        />
      ) : (
        <div className="flex flex-col items-start gap-3 p-5 text-ui">
          <p>
            {tr(
              "Discuss requirements and attach documents or reference images. AI prepares changes for review before generation.",
            )}
          </p>
          <Button disabled={busy} onClick={() => void create()}>
            {tr(busy ? "Creating..." : "Start batch conversation")}
          </Button>
          <p className="text-ui-sm text-muted-foreground">
            {tr(
              "Attachments use the current conversation model and file tools. Unread files must be reported.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
