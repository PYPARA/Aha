import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageAsset,
  ImageDraft,
  ImageGenerationParameters,
  ImageJob,
  ImageJobCreateInput,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { ExpandedImageOverlay } from "../chat/ExpandedImageOverlay";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { ensureNativeApi } from "~/nativeApi";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ImageCanvasEditor } from "./ImageCanvasEditor";
import {
  drawingApi,
  drawingJobsKey,
  imageUrl,
  uploadDrawingImage,
  useDrawingEvents,
  useImageJobs,
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
const selectClass = "h-9 min-w-0 rounded-lg border bg-background px-2 text-sm";
function Elapsed({ job }: { job: ImageJob }) {
  const [time, setTime] = useState(Date.now());
  useEffect(() => {
    if (!["queued", "running", "saving"].includes(job.status)) return;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.status]);
  const elapsed = Math.max(
    0,
    Math.round(
      ((job.finishedAt ? Date.parse(job.finishedAt) : time) -
        Date.parse(job.startedAt ?? job.createdAt)) /
        1000,
    ),
  );
  return <span>{elapsed}s</span>;
}
export default function DrawingWorkbench() {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    client = useQueryClient();
  const providers = useImageProviders(),
    history = useImageJobs();
  useDrawingEvents();
  const [windowId] = useState(draftId),
    [preferences] = useState(readPreferences);
  const preferencesRef = useRef(preferences);
  const [prompt, setPrompt] = useState(""),
    [providerId, setProviderId] = useState(preferences.provider ?? ""),
    [model, setModel] = useState(""),
    [parameters, setParameters] = useState<ImageGenerationParameters>({ n: 1 });
  const [inputs, setInputs] = useState<ImageAsset[]>([]),
    [mask, setMask] = useState<ImageAsset | null>(null),
    [sourceJobId, setSourceJobId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false),
    [error, setError] = useState<string | null>(null),
    [submitting, setSubmitting] = useState(false),
    [uploading, setUploading] = useState(false),
    [details, setDetails] = useState<ImageJob | null>(null);
  const [preview, setPreview] = useState<{ assets: readonly ImageAsset[]; index: number } | null>(
      null,
    ),
    [editor, setEditor] = useState<{
      mode: "annotation" | "mask";
      base: ImageAsset | null;
      mask: ImageAsset | null;
    } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    refs = useRef(inputs),
    pendingRequest = useRef<{ signature: string; id: string } | null>(null),
    draftWrites = useRef(Promise.resolve()),
    uploadWrites = useRef(Promise.resolve());
  refs.current = inputs;
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
      setParameters(preferencesRef.current.parameters[`${id}:${valid}`] ?? { n: 1 });
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
        setParameters(draft.parameters);
        setInputs(assets);
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
      persist();
    };
  }, [hydrated, windowId, prompt, providerId, model, parameters, inputs, mask]);
  useEffect(() => {
    if (!hydrated || !providerId || !model) return;
    const p = preferencesRef.current;
    p.provider = providerId;
    p.models[providerId] = model;
    p.parameters[`${providerId}:${model}`] = parameters;
    localStorage.setItem(preferenceKey, JSON.stringify(p));
  }, [hydrated, providerId, model, parameters]);
  const setReferences = (assets: ImageAsset[]) => {
    if (assets[0]?.id !== refs.current[0]?.id) setMask(null);
    refs.current = assets;
    setInputs(assets);
  };
  const append = (asset: ImageAsset) => {
    const current = refs.current;
    if (current.some((a) => a.id === asset.id)) return;
    if (asset.bytes > 20 * 1024 * 1024)
      throw new Error(tr("Choose PNG, JPEG or WebP images up to 20 MiB each."));
    if (
      current.length >= 16 ||
      current.reduce((n, a) => n + a.bytes, 0) + asset.bytes > 80 * 1024 * 1024
    )
      throw new Error(tr("Reference image limit exceeded (16 images / 80 MiB)."));
    setReferences([...current, asset]);
  };
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    uploadWrites.current = uploadWrites.current
      .catch(() => {})
      .then(async () => {
        for (const file of files) {
          if (
            !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
            file.size > 20 * 1024 * 1024
          )
            throw new Error(tr("Choose PNG, JPEG or WebP images up to 20 MiB each."));
          if (
            refs.current.length >= 16 ||
            refs.current.reduce((n, a) => n + a.bytes, 0) + file.size > 80 * 1024 * 1024
          )
            throw new Error(tr("Reference image limit exceeded (16 images / 80 MiB)."));
          append(await uploadDrawingImage(file, file.name));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setUploading(false));
  };
  const reuse = (job: ImageJob) => {
    setPrompt(job.prompt);
    setProviderId(job.providerId);
    setModel(job.model);
    setParameters(job.parameters);
    refs.current = [...job.inputs];
    setInputs([...job.inputs]);
    setMask(job.mask);
    setSourceJobId(job.id);
    setDetails(null);
    setError(null);
  };
  const submit = async () => {
    if (submitting || uploading || !hydrated || !provider || !model || !prompt.trim()) return;
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
        maskAssetId: mask?.id ?? null,
        updatedAt: new Date().toISOString(),
      });
      if (activeJob(job)) await drawingApi().cancelJob({ id: job.id });
      await drawingApi().deleteJob({ id: job.id });
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
  };
  const openAnnotation = (base: ImageAsset | null) => {
    setEditor({ mode: "annotation", base, mask: null });
    setPreview(null);
  };
  const settings = () => void navigate({ to: "/settings", search: { section: "imageProviders" } });
  const jobs = history.data?.pages.flatMap((page) => page.jobs) ?? [];
  const size = parameters.size ?? "",
    custom = size && !["1024x1024", "1536x1024", "1024x1536", "auto"].includes(size);
  const [customMode, setCustomMode] = useState(false);
  const [customWidth, customHeight] = (custom ? size : "1024x1024").split("x");
  const updateParameters = (patch: Partial<ImageGenerationParameters>) =>
    setParameters((prev) => ({ ...prev, ...patch }));
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
            append(asset);
            setPreview(null);
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        {tr("Use as reference")}
      </Button>
      <Button size="sm" variant="outline" onClick={() => openAnnotation(asset)}>
        {tr("Annotate")}
      </Button>
      <Button size="sm" variant="outline" onClick={() => openMask(asset)}>
        {tr("Inpaint")}
      </Button>
    </div>
  );
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarHeaderNavigationControls />
          <div>
            <h1 className="text-xl font-medium">{tr("Drawing")}</h1>
            <p className="text-xs text-muted-foreground">
              {tr("Your independent image workspace")}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={settings}>
          {tr("Image provider settings")}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-5xl space-y-5">
          {history.isError ? (
            <p role="alert" className="text-destructive">
              {history.error.message}
            </p>
          ) : history.isPending ? (
            <p className="text-muted-foreground">{tr("Loading...")}</p>
          ) : jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed p-10 text-center">
              <h2 className="font-medium">{tr("Start with an idea")}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {tr("Describe an image, add references, or draw on a blank canvas.")}
              </p>
              {!provider ? (
                <Button className="mt-4" onClick={settings}>
                  {tr("Add image provider")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {jobs.map((job) => (
            <article key={job.id} className="rounded-2xl border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium">{job.providerName}</span>
                  <span className="text-muted-foreground break-all">{job.model}</span>
                  {job.isTest ? (
                    <span className="rounded bg-muted px-2 py-1">{tr("Connection test")}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={
                      job.status === "failed" || job.status === "interrupted"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {tr(job.status)}
                  </span>
                  <Elapsed job={job} />
                  <time dateTime={job.createdAt} className="text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString()}
                  </time>
                </div>
              </div>
              <p className="my-3 whitespace-pre-wrap break-words text-sm line-clamp-3">
                {job.prompt}
              </p>
              {job.outputs.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {job.outputs.map((asset, index) => (
                    <button
                      /* eslint-disable-next-line react/no-array-index-key -- identical output hashes can occupy different result slots */
                      key={`${asset.id}:${index}`}
                      className="overflow-hidden rounded-xl border bg-muted/30 text-left"
                      onClick={() => setPreview({ assets: job.outputs, index })}
                    >
                      <img
                        loading="lazy"
                        src={imageUrl(asset, "thumbnail")}
                        alt={job.prompt}
                        className="aspect-square w-full object-contain"
                      />
                      <span className="block px-2 py-1 text-xs text-muted-foreground">
                        {asset.width} × {asset.height}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {job.status === "cancelled" && job.startedAt ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {tr("The provider may still process or charge a cancelled request.")}
                </p>
              ) : null}
              {job.error ? (
                <p role="alert" className="my-2 text-sm text-destructive">
                  {job.error.message} <span className="text-xs">({job.error.code})</span>
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDetails(job)}>
                  {tr("Details")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => reuse(job)}>
                  {tr("Reuse parameters")}
                </Button>
                {!activeJob(job) ? (
                  <Button size="sm" variant="outline" onClick={() => void regenerate(job)}>
                    {tr("Regenerate")} · {job.parameters.n}
                  </Button>
                ) : null}
                {activeJob(job) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void action(() => drawingApi().cancelJob({ id: job.id }))}
                  >
                    {tr("Cancel task")}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void remove(job)}>
                  {tr("Delete")}
                </Button>
              </div>
            </article>
          ))}
          {history.hasNextPage ? (
            <Button
              variant="outline"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {tr("Load more")}
            </Button>
          ) : null}
        </div>
      </div>
      <form
        className="shrink-0 border-t bg-background p-3 sm:p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="mx-auto max-w-5xl space-y-3">
          {inputs.length ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {inputs.map((asset, index) => (
                <div key={asset.id} className="w-24 shrink-0 rounded-lg border p-1">
                  <button type="button" onClick={() => setPreview({ assets: inputs, index })}>
                    <img
                      src={imageUrl(asset, "thumbnail")}
                      alt={asset.name}
                      className="h-16 w-22 object-contain"
                    />
                  </button>
                  <div className="flex items-center justify-between text-xs">
                    <span>{index + 1}</span>
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={tr("Move reference earlier")}
                      onClick={() => {
                        const next = [...inputs];
                        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                        setReferences(next);
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={tr("Remove reference")}
                      onClick={() => setReferences(inputs.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            disabled={!hydrated}
            aria-label={tr("Image prompt")}
            placeholder={tr("Describe the image you want to create...")}
            className="block max-h-36 min-h-20 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
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
          <div className="flex flex-wrap items-center gap-2">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {tr(uploading ? "Uploading..." : "Reference images")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => openAnnotation(null)}>
              {tr("Blank canvas")}
            </Button>
            {inputs[0] ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openAnnotation(inputs[0]!)}
                >
                  {tr("Annotate")}
                </Button>
                <Button
                  type="button"
                  variant={mask ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditor({ mode: "mask", base: inputs[0]!, mask })}
                >
                  {tr(mask ? "Edit mask" : "Inpaint")}
                </Button>
              </>
            ) : null}
            {mask ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setMask(null)}>
                {tr("Remove mask")}
              </Button>
            ) : null}
            <label className="flex min-w-0 items-center gap-2 text-xs">
              {tr("Provider")}
              <select
                className={selectClass + " max-w-48"}
                value={providerId}
                onChange={(e) => changeSelection(e.target.value)}
              >
                <option value="">{tr("Select provider")}</option>
                {providers.data
                  ?.filter((p) => p.enabled)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex min-w-0 items-center gap-2 text-xs">
              {tr("Model")}
              <select
                className={selectClass + " max-w-52"}
                value={model}
                onChange={(e) => changeSelection(providerId, e.target.value)}
              >
                <option value="">{tr("Select model")}</option>
                {provider?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              className="ml-auto"
              disabled={
                !hydrated || submitting || uploading || !provider || !model || !prompt.trim()
              }
              title="Cmd/Ctrl + Enter"
            >
              {tr(submitting ? "Submitting..." : "Generate")} · {parameters.n}
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {tr("Image parameters")}
            </summary>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              <label className="grid gap-1">
                {tr("Size")}
                <select
                  className={selectClass}
                  value={custom || customMode ? "custom" : size}
                  onChange={(e) => {
                    setCustomMode(e.target.value === "custom");
                    updateParameters({
                      size: e.target.value === "custom" ? "1024x1024" : e.target.value || undefined,
                    });
                  }}
                >
                  <option value="">{tr("Provider default")}</option>
                  {["1024x1024", "1536x1024", "1024x1536"].map((s) => (
                    <option key={s} value={s}>
                      {s.replace("x", " × ")}
                    </option>
                  ))}
                  <option value="custom">{tr("Custom size")}</option>
                </select>
              </label>
              {custom || customMode ? (
                <>
                  <label className="grid gap-1">
                    {tr("Width")}
                    <Input
                      className="w-24"
                      type="number"
                      min={1}
                      max={99999}
                      value={customWidth}
                      onChange={(e) =>
                        updateParameters({ size: `${e.target.value}x${customHeight}` })
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    {tr("Height")}
                    <Input
                      className="w-24"
                      type="number"
                      min={1}
                      max={99999}
                      value={customHeight}
                      onChange={(e) =>
                        updateParameters({ size: `${customWidth}x${e.target.value}` })
                      }
                    />
                  </label>
                </>
              ) : null}
              <label className="grid gap-1">
                {tr("Quality")}
                <select
                  className={selectClass}
                  value={parameters.quality ?? ""}
                  onChange={(e) =>
                    updateParameters({
                      quality: (e.target.value ||
                        undefined) as ImageGenerationParameters["quality"],
                    })
                  }
                >
                  <option value="">{tr("Provider default")}</option>
                  {["auto", "low", "medium", "high", "xhigh", "max"].map((q) => (
                    <option key={q} value={q}>
                      {tr(q)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                {tr("Image count")}
                <Input
                  className="w-20"
                  type="number"
                  min={1}
                  max={10}
                  value={parameters.n}
                  onChange={(e) => updateParameters({ n: Number(e.target.value) })}
                />
              </label>
              <label className="grid gap-1">
                {tr("Output format")}
                <select
                  className={selectClass}
                  value={parameters.outputFormat ?? ""}
                  onChange={(e) =>
                    updateParameters({
                      outputFormat: (e.target.value ||
                        undefined) as ImageGenerationParameters["outputFormat"],
                    })
                  }
                >
                  <option value="">{tr("Provider default")}</option>
                  {["png", "jpeg", "webp"].map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                {tr("Background")}
                <select
                  className={selectClass}
                  value={parameters.background ?? ""}
                  onChange={(e) =>
                    updateParameters({
                      background: (e.target.value ||
                        undefined) as ImageGenerationParameters["background"],
                    })
                  }
                >
                  <option value="">{tr("Provider default")}</option>
                  {["auto", "opaque", "transparent"].map((b) => (
                    <option key={b} value={b}>
                      {tr(b)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
          {mask ? (
            <p className="text-xs text-muted-foreground">
              {tr("Painted areas of the first reference will be regenerated.")}
            </p>
          ) : null}
          {!provider ? (
            <p className="text-xs text-muted-foreground">
              {tr("Add an image provider to start drawing.")}{" "}
              <button type="button" className="underline" onClick={settings}>
                {tr("Image provider settings")}
              </button>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
      {preview ? (
        <ExpandedImageOverlay
          expandedImage={{
            images: preview.assets.map((a) => ({ src: imageUrl(a), name: a.name })),
            index: preview.index,
          }}
          onClose={() => setPreview(null)}
          onNavigate={(direction) =>
            setPreview((p) =>
              p ? { ...p, index: (p.index + direction + p.assets.length) % p.assets.length } : null,
            )
          }
          actions={imageActions(preview.assets[preview.index]!)}
        />
      ) : null}
      {editor ? (
        <ImageCanvasEditor
          key={`${editor.mode}:${editor.base?.id ?? "blank"}`}
          {...editor}
          onClose={() => setEditor(null)}
          onSave={async (blob) => {
            const asset = await uploadDrawingImage(
              blob,
              editor.mode === "mask" ? "mask.png" : "annotations.png",
            );
            if (editor.mode === "mask") {
              if (refs.current[0]?.id !== editor.base?.id)
                throw new Error(tr("The base image changed. Create a new mask."));
              setMask(asset);
            } else append(asset);
          }}
        />
      ) : null}
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tr("Image task details")}</DialogTitle>
            <DialogDescription>
              {details ? `${details.providerName} · ${details.model}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {details ? (
              <div className="space-y-4 text-sm">
                <p className="whitespace-pre-wrap break-words">{details.prompt}</p>
                <p>
                  {tr("Status")}: {tr(details.status)}
                </p>
                <h3 className="font-medium">{tr("Requested parameters")}</h3>
                <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(details.parameters, null, 2)}
                </pre>
                <h3 className="font-medium">{tr("Reference images")}</h3>
                <div className="flex flex-wrap gap-2">
                  {[...details.inputs, ...(details.mask ? [details.mask] : [])].map((asset, i) => (
                    <button
                      /* eslint-disable-next-line react/no-array-index-key -- input and mask may share a content hash */
                      key={`${asset.id}:${i}`}
                      onClick={() => {
                        setDetails(null);
                        setPreview({ assets: [asset], index: 0 });
                      }}
                    >
                      <img
                        className="h-24 w-24 rounded border object-contain"
                        src={imageUrl(asset, "thumbnail")}
                        alt={asset.name}
                      />
                    </button>
                  ))}
                </div>
                <h3 className="font-medium">{tr("Returned parameters and usage")}</h3>
                <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(
                    {
                      parameters: details.actualParameters,
                      usage: details.usage,
                      requestId: details.upstreamRequestId,
                    },
                    null,
                    2,
                  )}
                </pre>
                {details.error ? <p className="text-destructive">{details.error.message}</p> : null}
                <Button onClick={() => reuse(details)}>{tr("Reuse parameters")}</Button>
              </div>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
