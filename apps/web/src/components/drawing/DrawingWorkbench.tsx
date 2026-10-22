import { useResourceAttachments, type ResourceReceiveResult } from "../resources/resourceLibrary";
import { drawingResourceError, DRAWING_RESOURCE_LIMITS } from "@synara/contracts/resourceLibrary";
import { normalizeDrawingParameters, updateDrawingParameters } from "./drawingParameters";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { ChatSurfaceHeader } from "../chat/ChatSurfaceHeader";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../chat/chatHeaderControls";
import {
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "../chat/composerPickerStyles";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { ArrowUpIcon, ChevronDownIcon, MoreHorizontalIcon } from "~/lib/icons";
import { Menu, MenuTrigger, MenuItem, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { DrawingGallery } from "./DrawingGallery";
import { DrawingJobDialog } from "./DrawingJobDialog";
import { DrawingAddMenu, DrawingModelPicker, DrawingParameters } from "./DrawingPickers";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageAsset,
  ImageDraft,
  ImageInputReference,
  ImageGenerationParameters,
  ImageJob,
  ImageJobCreateInput,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ExpandedImageOverlay } from "../chat/ExpandedImageOverlay";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { ensureNativeApi } from "~/nativeApi";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ImageCanvasEditor } from "./ImageCanvasEditor";
import {
  saveImageEditDocument,
  drawingApi,
  drawingJobsKey,
  imageUrl,
  uploadDrawingImage,
  useDrawingEvents,
  useImageProviders,
} from "./useDrawing";

const activeJob = (job: ImageJob) => ["queued", "running", "saving"].includes(job.status);
const preferenceKey = "drawing:preferences:v1";
type Preferences = {
  provider?: string;
  models: Record<string, string>;
  parameters: Record<string, ImageGenerationParameters>;
};
function readPreferences(): Preferences {
  try {
    return {
      models: {},
      parameters: {},
      ...JSON.parse(localStorage.getItem(preferenceKey) ?? "{}"),
    };
  } catch {
    return { models: {}, parameters: {} };
  }
}
function draftId() {
  let id = sessionStorage.getItem("drawing:window:v1");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("drawing:window:v1", id);
  }
  return id;
}
async function getAsset(id: string): Promise<ImageAsset> {
  const response = await fetch(resolveWsHttpUrl(`/api/drawing/assets/${id}?metadata=1`), {
    credentials: "include",
  });
  if (!response.ok) throw new Error("Could not restore reference image.");
  return response.json();
}
export default function DrawingWorkbench() {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    client = useQueryClient();
  const providers = useImageProviders();
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const [statusGroup, setStatusGroup] = useState<"all" | "active" | "completed" | "issues">("all");
  const [origin, setOrigin] = useState<"drawing" | "all">("drawing");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const promptInput = useRef<HTMLTextAreaElement>(null);
  useDrawingEvents();
  const [windowId] = useState(draftId),
    [preferences] = useState(readPreferences);
  const preferencesRef = useRef(preferences);
  const [prompt, setPrompt] = useState(""),
    [providerId, setProviderId] = useState(preferences.provider ?? ""),
    [model, setModel] = useState(""),
    [parameters, setParameters] = useState<ImageGenerationParameters>(
      () => normalizeDrawingParameters().parameters,
    );
  const [inputReferences, setInputReferences] = useState<ImageInputReference[]>([]);
  const referenceMetadata = useRef(inputReferences);
  referenceMetadata.current = inputReferences;
  const hasInstructions = Boolean(
    prompt.trim() || inputReferences.some((r) => r.comments?.some((c) => c.text.trim())),
  );
  const [parameterNotice, setParameterNotice] = useState<string | null>(null);
  const [inputs, setInputs] = useState<ImageAsset[]>([]),
    [mask, setMask] = useState<ImageAsset | null>(null),
    [sourceJobId, setSourceJobId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false),
    [error, setError] = useState<string | null>(null),
    [submitting, setSubmitting] = useState(false),
    [uploading, setUploading] = useState(false),
    [details, setDetails] = useState<ImageJob | null>(null);
  const [preview, setPreview] = useState<{
      assets: readonly ImageAsset[];
      job?: ImageJob;
      index: number;
      references?: readonly ImageInputReference[] | undefined;
    } | null>(null),
    [editor, setEditor] = useState<{
      mode: "annotation" | "mask";
      base: ImageAsset | null;
      mask: ImageAsset | null;
      documentId?: string | null;
      referenceId?: string;
      focusComments?: boolean;
      focusCommentId?: string;
    } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    mounted = useRef(true),
    refs = useRef(inputs),
    pendingRequest = useRef<{ signature: string; id: string } | null>(null),
    draftWrites = useRef(Promise.resolve()),
    uploadWrites = useRef(Promise.resolve());
  refs.current = inputs;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const provider = providers.data?.find((p) => p.id === providerId && p.enabled);
  const changeSelection = useCallback(
    (id: string, selectedModel?: string) => {
      const selected = providers.data?.find((p) => p.id === id);
      const next =
        selectedModel ?? preferencesRef.current.models[id] ?? selected?.defaultModel ?? "";
      const valid = selected?.models.some((m) => m.id === next)
        ? next
        : (selected?.defaultModel ?? "");
      setProviderId(id);
      setModel(valid);
      setParameters(
        normalizeDrawingParameters(preferencesRef.current.parameters[`${id}:${valid}`]).parameters,
      );
      setParameterNotice(null);
    },
    [providers.data],
  );
  useEffect(() => {
    let disposed = false;
    void drawingApi()
      .getDraft({ id: windowId })
      .then(async (draft) => {
        if (!draft || disposed) return;
        const assets = await Promise.all(draft.inputAssetIds.map(getAsset));
        const restoredMask = draft.maskAssetId ? await getAsset(draft.maskAssetId) : null;
        if (disposed) return;
        setPrompt(draft.prompt);
        setProviderId(draft.providerId ?? "");
        setModel(draft.model);
        setParameters(normalizeDrawingParameters(draft.parameters).parameters);
        setInputs(assets);
        setInputReferences([
          ...(draft.inputReferences ??
            assets.map((a) => ({ id: crypto.randomUUID(), assetId: a.id, documentId: null }))),
        ]);
        setMask(restoredMask);
      })
      .catch((e) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!disposed) setHydrated(true);
      });
    return () => {
      disposed = true;
    };
  }, [windowId]);
  useEffect(() => {
    if (!hydrated || !providers.data) return;
    if (!provider) {
      const first = providers.data.find((p) => p.enabled);
      if (first) changeSelection(first.id);
      else {
        setProviderId("");
        setModel("");
      }
    } else if (!provider.models.some((m) => m.id === model)) {
      changeSelection(provider.id);
    }
  }, [hydrated, providers.data, provider, model, changeSelection]);
  useEffect(() => {
    if (!hydrated) return;
    const draft: ImageDraft = {
      id: windowId,
      prompt,
      providerId: providerId || null,
      model,
      parameters,
      inputAssetIds: inputs.map((a) => a.id),
      inputReferences,
      maskAssetId: mask?.id ?? null,
      updatedAt: new Date().toISOString(),
    };
    const persist = () => {
      draftWrites.current = draftWrites.current
        .catch(() => {})
        .then(async () => {
          await drawingApi().upsertDraft(draft);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };
    const timer = setTimeout(persist, 350);
    return () => {
      clearTimeout(timer);
    };
  }, [hydrated, windowId, prompt, providerId, model, parameters, inputs, mask, inputReferences]);
  useEffect(() => {
    if (!hydrated || !providerId || !model) return;
    const p = preferencesRef.current;
    p.provider = providerId;
    p.models[providerId] = model;
    p.parameters[`${providerId}:${model}`] = parameters;
    localStorage.setItem(preferenceKey, JSON.stringify(p));
  }, [hydrated, providerId, model, parameters]);
  const setReferences = (assets: ImageAsset[], supplied?: readonly ImageInputReference[]) => {
    if (assets[0]?.id !== refs.current[0]?.id) setMask(null);
    refs.current = assets;
    setInputs(assets);
    const metadata = supplied
      ? [...supplied]
      : assets.map(
          (a) =>
            referenceMetadata.current.find((r) => r.assetId === a.id) ?? {
              id: crypto.randomUUID(),
              assetId: a.id,
              documentId: null,
            },
        );
    referenceMetadata.current = metadata;
    setInputReferences(metadata);
  };
  const append = (asset: ImageAsset) => {
    const current = refs.current;
    if (current.some((a) => a.id === asset.id)) return;
    if (asset.bytes > DRAWING_RESOURCE_LIMITS.fileBytes)
      throw new Error(tr("Choose PNG, JPEG or WebP images up to 20 MiB each."));
    if (
      current.length >= DRAWING_RESOURCE_LIMITS.count ||
      current.reduce((n, a) => n + a.bytes, 0) + asset.bytes > DRAWING_RESOURCE_LIMITS.totalBytes
    )
      throw new Error(tr("Reference image limit exceeded (16 images / 80 MiB)."));
    setReferences([...current, asset]);
  };
  const addFiles = (files: File[]): Promise<ResourceReceiveResult> => {
    if (!files.length) return Promise.resolve({ accepted: [], rejected: [] });
    setUploading(true);
    const task = uploadWrites.current
      .catch(() => {})
      .then(async () => {
        const result: ResourceReceiveResult = { accepted: [], rejected: [] };
        for (const [index, file] of files.entries()) {
          try {
            const error = drawingResourceError(file, {
              count: refs.current.length,
              bytes: refs.current.reduce((n, a) => n + a.bytes, 0),
            });
            if (error) throw new Error(tr(error));
            const uploaded = await uploadDrawingImage(file, file.name);
            if (!mounted.current)
              throw new Error("The destination is not ready to accept attachments.");
            append(uploaded);
            result.accepted.push(index);
          } catch (cause) {
            result.rejected.push({
              index,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        setError(result.rejected.map((item) => item.error).join("\n") || null);
        return result;
      });
    uploadWrites.current = task
      .then(
        () => {},
        () => {},
      )
      .finally(() => setUploading(false));
    return task;
  };
  useResourceAttachments("drawing", addFiles, hydrated);
  const reuse = (job: ImageJob) => {
    setPrompt(job.prompt);
    setProviderId(job.providerId);
    setModel(job.model);
    const normalized = normalizeDrawingParameters(job.parameters);
    setParameters(normalized.parameters);
    setParameterNotice(
      normalized.adjusted
        ? "Unspecified or incompatible parameters were adjusted to current defaults."
        : null,
    );
    setReferences([...job.inputs], job.inputReferences);
    setMask(job.mask);
    setSourceJobId(job.id);
    setDetails(null);
    setError(null);
    requestAnimationFrame(() => promptInput.current?.focus());
  };
  const submit = async () => {
    if (submitting || uploading || !hydrated || !provider || !model || !hasInstructions) return;
    setSubmitting(true);
    setError(null);
    try {
      if (
        parameters.background === "transparent" &&
        parameters.outputFormat !== "png" &&
        parameters.outputFormat !== "webp"
      )
        throw new Error(tr("Transparent background requires PNG or WebP."));
      const body: Omit<ImageJobCreateInput, "clientRequestId"> = {
        providerId: provider.id,
        model,
        prompt,
        parameters,
        inputAssetIds: inputs.map((a) => a.id),
        inputReferences,
        maskAssetId: mask?.id ?? null,
        sourceJobId,
      };
      const signature = JSON.stringify(body);
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = { signature, id: crypto.randomUUID() };
      const job = await drawingApi().createJob({
        ...body,
        clientRequestId: pendingRequest.current.id,
      });
      pendingRequest.current = null;
      await client.invalidateQueries({ queryKey: drawingJobsKey });
      setSourceJobId(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  const action = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: drawingJobsKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const repeatRequests = useRef(new Map<string, string>());
  const regenerate = (job: ImageJob) =>
    action(async () => {
      let id = repeatRequests.current.get(job.id);
      if (!id) {
        id = crypto.randomUUID();
        repeatRequests.current.set(job.id, id);
      }
      await drawingApi().createJob({
        clientRequestId: id,
        providerId: job.providerId,
        model: job.model,
        prompt: job.prompt,
        parameters: job.parameters,
        inputAssetIds: job.inputs.map((a) => a.id),
        inputReferences: job.inputReferences,
        maskAssetId: job.mask?.id ?? null,
        sourceJobId: job.id,
      });
      repeatRequests.current.delete(job.id);
    });
  const remove = async (job: ImageJob) => {
    if (
      !(await ensureNativeApi().dialogs.confirm(
        tr("Delete this image task? Unshared images will also be removed."),
      ))
    )
      return;
    await action(async () => {
      // Save current references before reclaiming the source task's assets.
      await drawingApi().upsertDraft({
        id: windowId,
        prompt,
        providerId: providerId || null,
        model,
        parameters,
        inputAssetIds: refs.current.map((a) => a.id),
        inputReferences: referenceMetadata.current,
        maskAssetId: mask?.id ?? null,
        updatedAt: new Date().toISOString(),
      });
      if (activeJob(job)) await drawingApi().cancelJob({ id: job.id });
      await drawingApi().deleteJob({ id: job.id });
      if (details?.id === job.id) setDetails(null);
    });
  };
  const download = (asset: ImageAsset) =>
    void action(() =>
      downloadUrlAsBlob({
        url: resolveWsHttpUrl(`${asset.url}?download=1`),
        filename: asset.name,
        credentials: "include",
      }),
    );
  const openMask = (asset: ImageAsset) => {
    setReferences([asset]);
    setSourceJobId(null);
    setEditor({ mode: "mask", base: asset, mask: null });
    setPreview(null);
    setDetails(null);
  };
  const openAnnotation = (
    base: ImageAsset | null,
    referenceId?: string,
    focusComments?: boolean,
    documentId?: string | null,
    focusCommentId?: string,
  ) => {
    const reference = referenceId
      ? referenceMetadata.current.find((r) => r.id === referenceId)
      : null;
    setEditor({
      mode: "annotation",
      base,
      mask: null,
      ...(referenceId ? { referenceId } : {}),
      ...((documentId ?? reference?.documentId)
        ? { documentId: documentId ?? reference!.documentId! }
        : {}),
      ...(focusComments ? { focusComments: true } : {}),
      ...(focusCommentId ? { focusCommentId } : {}),
    });
    setPreview(null);
    setDetails(null);
  };
  const settings = () => void navigate({ to: "/settings", search: { section: "imageProviders" } });
  const updateParameters = (patch: Partial<ImageGenerationParameters>) => {
    const updated = updateDrawingParameters(parameters, patch);
    setParameters(updated.parameters);
    setParameterNotice(updated.notice);
  };
  const previewReference = preview?.references?.find(
    (r) => r.assetId === preview.assets[preview.index]?.id,
  );
  const imageActions = (asset: ImageAsset) => (
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" variant="outline" onClick={() => download(asset)}>
        {tr("Download")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          try {
            if (previewReference?.documentId && !refs.current.some((a) => a.id === asset.id))
              setReferences(
                [...refs.current, asset],
                [...referenceMetadata.current, { ...previewReference, id: crypto.randomUUID() }],
              );
            else append(asset);
            setPreview(null);
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        {tr("Use as reference")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          openAnnotation(
            asset,
            inputReferences.find((r) => r.assetId === asset.id)?.id,
            false,
            previewReference?.documentId,
          )
        }
      >
        {tr("Annotate")}
      </Button>
      <Button size="sm" variant="outline" onClick={() => openMask(asset)}>
        {tr("Inpaint")}
      </Button>
    </div>
  );
  useEffect(() => {
    const field = promptInput.current;
    if (field) {
      field.style.height = "0px";
      field.style.height = `${Math.min(104, Math.max(56, field.scrollHeight))}px`;
    }
  }, [prompt]);
  return (
    <RouteInsetSurface>
      <div
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            addFiles([...e.dataTransfer.files]);
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
      >
        <ChatSurfaceHeader
          className={cn(
            "drag-region flex shrink-0 items-center",
            CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <SidebarHeaderNavigationControls />
        </ChatSurfaceHeader>
        <div className="shrink-0 px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="mr-auto text-sm font-medium sm:mr-0">{tr("Drawing")}</h1>
            <Button
              type="button"
              variant="chrome"
              size="sm"
              className="order-2 sm:order-last"
              onClick={settings}
            >
              {tr("Image provider settings")}
            </Button>
            <div className="order-last flex w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
              <Input
                className="min-w-0 flex-1 sm:ml-3 sm:max-w-md"
                aria-label={tr("Search image history")}
                placeholder={tr("Search prompts...")}
                value={search}
                maxLength={1000}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="chrome"
                      size="sm"
                      aria-label={tr("Image history sources")}
                    >
                      {tr(origin === "drawing" ? "Drawing records" : "All source records")}
                      <ChevronDownIcon className="size-3" />
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end">
                  <MenuRadioGroup
                    value={origin}
                    onValueChange={(value) => setOrigin(value as typeof origin)}
                  >
                    <MenuRadioItem value="drawing" closeOnClick>
                      {tr("Drawing records")}
                    </MenuRadioItem>
                    <MenuRadioItem value="all" closeOnClick>
                      {tr("All source records")}
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </ComposerPickerMenuPopup>
              </Menu>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="chrome"
                      size="sm"
                      aria-label={tr("History status")}
                    >
                      {tr(
                        {
                          all: "All",
                          active: "In progress",
                          completed: "Completed",
                          issues: "Issues",
                        }[statusGroup],
                      )}
                      <ChevronDownIcon className="size-3" />
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end">
                  <MenuRadioGroup
                    value={statusGroup}
                    onValueChange={(v) => setStatusGroup(v as typeof statusGroup)}
                  >
                    {[
                      ["all", "All"],
                      ["active", "In progress"],
                      ["completed", "Completed"],
                      ["issues", "Issues"],
                    ].map(([value, label]) => (
                      <MenuRadioItem key={value} value={value!} closeOnClick>
                        {tr(label!)}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
          </div>
        </div>
        <DrawingGallery
          filters={{ query, statusGroup, origin }}
          hasProvider={Boolean(provider)}
          onSettings={settings}
          onOpen={(job) => {
            if (job.origin?.kind === "batch" && job.origin.ownerId)
              void navigate({ to: "/image-batches", search: { batchId: job.origin.ownerId } });
            else if (job.origin?.kind === "sprite" && job.origin.ownerId)
              void navigate({ to: "/sprite-animation", search: { projectId: job.origin.ownerId } });
            else setDetails(job);
          }}
          onReuse={reuse}
          onRegenerate={(job) => void regenerate(job)}
          onCancel={(job) => void action(() => drawingApi().cancelJob({ id: job.id }))}
          onDelete={(job) => void remove(job)}
        />
        <div className="max-h-[55%] shrink-0 overflow-y-auto px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
          <form
            data-testid="drawing-composer"
            className={cn(
              COMPOSER_INPUT_SHELL_CLASS_NAME,
              COMPOSER_SURFACE_SHADOW_CLASS_NAME,
              "mx-auto w-full max-w-[960px] rounded-3xl p-3",
            )}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {inputs.length ? (
              <div
                className="mb-2 flex gap-2 overflow-x-auto pb-1"
                data-testid="drawing-references"
              >
                {inputs.map((asset, index) => (
                  <div
                    /* eslint-disable-next-line react/no-array-index-key -- key is a persistent reference UUID; index only resolves the ordered metadata */
                    key={inputReferences[index]?.id ?? asset.id}
                    className="relative flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/20 p-1"
                  >
                    <button
                      type="button"
                      aria-label={`${tr("Reference images")} ${index + 1}`}
                      onClick={() =>
                        setPreview({ assets: inputs, index, references: inputReferences })
                      }
                    >
                      <img
                        src={imageUrl(asset, "thumbnail")}
                        alt={asset.name}
                        className="size-12 object-contain"
                      />
                    </button>
                    {index === 0 && mask ? (
                      <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1 text-[10px]">
                        {tr("Mask")}
                      </span>
                    ) : null}
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="chrome"
                            aria-label={`${tr("Reference actions")} ${index + 1}`}
                          >
                            <MoreHorizontalIcon className="size-3" />
                          </Button>
                        }
                      />
                      <ComposerPickerMenuPopup side="top" align="start">
                        <MenuItem onClick={() => openAnnotation(asset, inputReferences[index]?.id)}>
                          {tr("Annotate")}
                        </MenuItem>
                        {index === 0 ? (
                          <MenuItem onClick={() => setEditor({ mode: "mask", base: asset, mask })}>
                            {tr(mask ? "Edit mask" : "Inpaint")}
                          </MenuItem>
                        ) : null}
                        {index === 0 && mask ? (
                          <MenuItem onClick={() => setMask(null)}>{tr("Remove mask")}</MenuItem>
                        ) : null}
                        <MenuItem
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...inputs];
                            [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                            setReferences(next);
                          }}
                        >
                          {tr("Move reference earlier")}
                        </MenuItem>
                        <MenuItem
                          onClick={() => setReferences(inputs.filter((_, i) => i !== index))}
                        >
                          {tr("Remove reference")}
                        </MenuItem>
                      </ComposerPickerMenuPopup>
                    </Menu>
                  </div>
                ))}
              </div>
            ) : null}
            {inputReferences.some((r) => r.comments?.length) ? (
              <div className="mb-1 flex flex-wrap gap-1 px-2" aria-label={tr("Image comments")}>
                {inputReferences.map((r, index) =>
                  r.comments?.length ? (
                    <Button
                      key={r.id}
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="rounded-full text-ui-xs"
                      onClick={() => openAnnotation(inputs[index]!, r.id, true)}
                    >
                      {tr("Image")} {index + 1} · {r.comments.length} {tr("comments")}
                    </Button>
                  ) : null,
                )}
              </div>
            ) : null}
            <textarea
              ref={promptInput}
              disabled={!hydrated}
              aria-label={tr("Image prompt")}
              placeholder={tr("Describe the image you want to create...")}
              className="block min-h-14 max-h-26 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none"
              value={prompt}
              maxLength={32000}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
              <DrawingModelPicker
                providers={providers.data ?? []}
                providerId={providerId}
                model={model}
                onChange={changeSelection}
                onSettings={settings}
              />
              <div className="hidden h-4 w-px bg-border sm:block" />
              <DrawingParameters parameters={parameters} onChange={updateParameters} />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <DrawingAddMenu
                  uploading={uploading}
                  onUpload={() => fileInput.current?.click()}
                  onCanvas={() => openAnnotation(null)}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="rounded-full px-3"
                  disabled={
                    !hydrated || submitting || uploading || !provider || !model || !hasInstructions
                  }
                  title="Cmd/Ctrl + Enter"
                >
                  {tr(submitting ? "Submitting..." : "Generate")} · {parameters.n}
                  <ArrowUpIcon className="size-3.5" />
                </Button>
              </div>
            </div>
            {parameterNotice ? (
              <p role="status" className="mt-1.5 px-2 text-ui-xs text-muted-foreground">
                {tr(parameterNotice)}
              </p>
            ) : null}
            {mask ? (
              <p className="mt-1.5 px-2 text-ui-xs text-muted-foreground">
                {tr("Painted areas of the first reference will be regenerated.")}
              </p>
            ) : null}
            {!provider ? (
              <p className="mt-1.5 px-2 text-ui-xs text-muted-foreground">
                {tr("Add an image provider to start drawing.")}{" "}
                <button type="button" className="underline" onClick={settings}>
                  {tr("Image provider settings")}
                </button>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-2 px-2 text-sm break-words text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </div>
        {details ? (
          <DrawingJobDialog
            key={details.id}
            initialJob={details}
            onClose={() => setDetails(null)}
            onDownload={download}
            onReference={(asset) => {
              try {
                append(asset);
                setDetails(null);
              } catch (e) {
                setError(String(e));
              }
            }}
            onAnnotate={openAnnotation}
            onMask={openMask}
            onReuse={reuse}
            onRegenerate={(job) => void regenerate(job)}
            onCancel={(job) => void action(() => drawingApi().cancelJob({ id: job.id }))}
            onDelete={(job) => void remove(job)}
            onPreview={(asset) => {
              setDetails(null);
              setPreview({
                assets: [asset],
                index: 0,
                references: details.inputReferences,
                job: details,
              });
            }}
          />
        ) : null}
        {preview ? (
          <ExpandedImageOverlay
            expandedImage={{
              images: preview.assets.map((a) => ({
                src: imageUrl(a),
                name: a.name,
                resourceOrigin: {
                  kind: "drawing" as const,
                  ...(preview.job
                    ? {
                        jobId: preview.job.id,
                        batchId: preview.job.id,
                        prompt: preview.job.prompt,
                        model: preview.job.model,
                        parameters: { ...preview.job.parameters },
                      }
                    : {}),
                },
              })),
              index: preview.index,
            }}
            onClose={() => setPreview(null)}
            onNavigate={(direction) =>
              setPreview((p) =>
                p
                  ? { ...p, index: (p.index + direction + p.assets.length) % p.assets.length }
                  : null,
              )
            }
            actions={imageActions(preview.assets[preview.index]!)}
            imageOverlay={previewReference?.comments?.map((comment, i) => (
              <button
                type="button"
                key={comment.id}
                title={comment.text}
                aria-label={`${tr("Image comment")} ${i + 1}: ${comment.text}`}
                className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-primary/50 bg-background text-ui-xs text-primary shadow-md"
                style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }}
                onClick={() =>
                  openAnnotation(
                    preview.assets[preview.index]!,
                    inputReferences.find((r) => r.id === previewReference.id)?.id,
                    true,
                    previewReference.documentId,
                    comment.id,
                  )
                }
              >
                {i + 1}
              </button>
            ))}
          />
        ) : null}
        {editor ? (
          <ImageCanvasEditor
            key={`${editor.mode}:${editor.base?.id ?? "blank"}`}
            {...editor}
            blankSize={
              parameters.size?.match(/^(\d+)x(\d+)$/)
                ? {
                    width: Number(parameters.size.split("x")[0]),
                    height: Number(parameters.size.split("x")[1]),
                  }
                : undefined
            }
            onClose={() => setEditor(null)}
            onSave={async (blob, document) => {
              const asset = await uploadDrawingImage(
                blob,
                editor.mode === "mask" ? "mask.png" : "annotations.png",
              );
              if (editor.mode === "mask") {
                if (refs.current[0]?.id !== editor.base?.id)
                  throw new Error(tr("The base image changed. Create a new mask."));
                const storedDraft: ImageDraft = {
                  id: windowId,
                  prompt,
                  providerId: providerId || null,
                  model,
                  parameters,
                  inputAssetIds: refs.current.map((a) => a.id),
                  inputReferences: referenceMetadata.current,
                  maskAssetId: asset.id,
                  updatedAt: new Date().toISOString(),
                };
                draftWrites.current = draftWrites.current
                  .catch(() => {})
                  .then(async () => {
                    await drawingApi().upsertDraft(storedDraft);
                  });
                await draftWrites.current;
                setMask(asset);
              } else {
                if (!document) throw new Error(tr("Could not save editable image document."));
                const saved = await saveImageEditDocument({
                  ...document,
                  compositeAssetId: asset.id,
                });
                const metadata: ImageInputReference = {
                  id: editor.referenceId ?? crypto.randomUUID(),
                  assetId: asset.id,
                  documentId: saved.id,
                  comments: saved.comments,
                };
                const next = [...refs.current];
                const nextMetadata = [...referenceMetadata.current];
                if (editor.referenceId) {
                  const index = referenceMetadata.current.findIndex(
                    (r) => r.id === editor.referenceId,
                  );
                  if (index < 0)
                    throw new Error(tr("The reference image changed. Reopen the editor."));
                  next[index] = asset;
                  nextMetadata[index] = metadata;
                } else {
                  if (refs.current.length >= 16)
                    throw new Error(tr("Reference image limit exceeded (16 images / 80 MiB)."));
                  next.push(asset);
                  nextMetadata.push(metadata);
                }
                // Confirmed editor saves must be durable before the dialog closes.
                const storedDraft: ImageDraft = {
                  id: windowId,
                  prompt,
                  providerId: providerId || null,
                  model,
                  parameters,
                  inputAssetIds: next.map((a) => a.id),
                  inputReferences: nextMetadata,
                  maskAssetId: next[0]?.id === refs.current[0]?.id ? (mask?.id ?? null) : null,
                  updatedAt: new Date().toISOString(),
                };
                draftWrites.current = draftWrites.current
                  .catch(() => {})
                  .then(async () => {
                    await drawingApi().upsertDraft(storedDraft);
                  });
                await draftWrites.current;
                setReferences(next, nextMetadata);
              }
            }}
          />
        ) : null}
      </div>
    </RouteInsetSurface>
  );
}
