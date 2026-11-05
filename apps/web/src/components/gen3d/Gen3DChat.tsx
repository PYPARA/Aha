import { useEffect, useRef, useState } from "react";
import { ThreadId, type Gen3DProject } from "@synara/contracts";
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
import { gen3dApi, useGen3DCommand } from "./useGen3D";
import { strongestEffortSelection } from "./gen3dModelEffort";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/** Creates (or reuses) the project's conversation and returns its thread. */
export async function ensureGen3DThread(
  projectId: string,
  command: ReturnType<typeof useGen3DCommand>,
  settings: ReturnType<typeof useAppSettings>["settings"],
  notReady: string,
  queryClient: QueryClient,
): Promise<ThreadId> {
  const latest = await gen3dApi().get({ id: projectId });
  if (latest.threadId) return ThreadId.makeUnsafe(latest.threadId);
  const chatProject = await ensureHomeChatProject(useWorkspacePathsStore.getState());
  if (!chatProject) throw new Error(notReady);
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
  const threadId = createDraftThread({
    projectId: chatProject,
    prompt: "",
    // The composer's model, at its strongest reasoning effort (still changeable in the chat).
    modelSelection: await strongestEffortSelection(modelSelection, queryClient, settings),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    envMode: "local",
  });
  await command({ operation: "bind-thread", projectId, revision: latest.revision, threadId });
  return threadId;
}

export function Gen3DChat({
  project,
  onError,
}: {
  project: Gen3DProject;
  onError: (error: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    { settings } = useAppSettings(),
    command = useGen3DCommand(),
    queryClient = useQueryClient();
  const [busy, setBusy] = useState(false),
    [bridge] = useState(() => new EmbeddedChatAttachments());
  const creating = useRef(false);
  const threadId = project.threadId ? ThreadId.makeUnsafe(project.threadId) : null;
  useEffect(() => (threadId ? retainThreadDetailSubscription(threadId) : undefined), [threadId]);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    try {
      await ensureGen3DThread(
        project.id,
        command,
        settings,
        tr("Chat workspace is not ready. Try again after connecting."),
        queryClient,
      );
    } catch (error) {
      onError(error);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={tr("3D generation assistant")}>
      {threadId ? (
        <ChatView
          key={threadId}
          threadId={threadId}
          hideHeader
          attachmentBridge={bridge}
          surfaceMode="split"
          paneScopeId={"gen3d-" + project.id}
          isFocusedPane
          beforeTurnDispatch={async () => {
            const latest = await gen3dApi().get({ id: project.id });
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
              "The assistant models the asset against your blueprint, checks each build's renders and score, and keeps every round as a candidate.",
            )}
          </p>
          <p className="text-muted-foreground">
            {tr(
              "Example: a chubby little robot, cream body, orange antenna and chest panel, for a mobile game.",
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
