import { useEffect, useRef, useState } from "react";
import { ThreadId, type Model3DProject } from "@synara/contracts";
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
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import ChatView from "../ChatView";
import { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { Button } from "../ui/button";
import { model3dApi, useModel3DCommand } from "./useModel3D";

export function ModelChat({
  project,
  onError,
}: {
  project: Model3DProject;
  onError: (error: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    { settings } = useAppSettings(),
    command = useModel3DCommand();
  const [busy, setBusy] = useState(false),
    [bridge] = useState(() => new EmbeddedChatAttachments());
  const prepared = useRef<ThreadId | null>(null),
    creating = useRef(false);
  const threadId = project.threadId ? ThreadId.makeUnsafe(project.threadId) : null;
  useEffect(() => (threadId ? retainThreadDetailSubscription(threadId) : undefined), [threadId]);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    try {
      const chatProject = await ensureHomeChatProject(useWorkspacePathsStore.getState());
      if (!chatProject)
        throw new Error(tr("Chat workspace is not ready. Try again after connecting."));
      const composer = useComposerDraftStore.getState();
      const modelSelection = resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: composer.stickyModelSelectionByProvider,
          activeProvider: composer.stickyActiveProvider,
        },
        threadModelSelection: null,
        projectModelSelection: useStore.getState().projects.find((p) => p.id === chatProject)
          ?.defaultModelSelection,
        defaultProvider: settings.defaultProvider,
        resolveProviderForInstanceId: (id) =>
          getProviderInstanceOptions(settings).find((p) => p.instanceId === id)?.provider,
      });
      const latest = await model3dApi().get({ id: project.id });
      prepared.current = latest.threadId
        ? ThreadId.makeUnsafe(latest.threadId)
        : (prepared.current ??
          createDraftThread({
            projectId: chatProject,
            prompt: "",
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            envMode: "local",
          }));
      await command({
        operation: "bind-thread",
        projectId: project.id,
        revision: latest.revision,
        threadId: prepared.current,
      });
    } catch (error) {
      onError(error);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={tr("3D modeling assistant")}>
      {threadId ? (
        <ChatView
          key={threadId}
          threadId={threadId}
          hideHeader
          attachmentBridge={bridge}
          surfaceMode="split"
          paneScopeId={"model3d-" + project.id}
          isFocusedPane
          beforeTurnDispatch={async () => {
            const latest = await model3dApi().get({ id: project.id });
            if (latest.threadId !== threadId)
              throw new Error(tr("Conversation changed. Reload before sending."));
            if (latest.archived) throw new Error(tr("Restore this project before modeling."));
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
        <div className="space-y-3 p-4 text-ui-sm">
          <p>
            {tr(
              "Describe a prop and continue refining it in conversation. AI builds a candidate using your current conversation model.",
            )}
          </p>
          <p className="text-muted-foreground">
            {tr(
              "Example: a low-poly wooden treasure chest, 1 meter wide, separate lid and metal bands, under 5000 triangles.",
            )}
          </p>
          <Button disabled={busy || project.archived} onClick={() => void create()}>
            {tr(busy ? "Creating..." : "Start modeling conversation")}
          </Button>
        </div>
      )}
    </section>
  );
}
