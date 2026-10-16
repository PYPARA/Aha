import {
  ResourceCollectButton,
  drawingResourceSource,
  resourceContextMenu,
} from "../resources/ResourceCollectionDialog";
import { drawingParameterLabel } from "./drawingParameters";
import { CentralIcon } from "~/lib/central-icons";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ImageAsset, ImageJob } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import { drawingApi, drawingJobsKey, imageUrl } from "./useDrawing";
import { activeImageJob, DrawingElapsed } from "./DrawingGallery";

export function DrawingJobDialog({
  initialJob,
  onClose,
  onDownload,
  onReference,
  onAnnotate,
  onMask,
  onReuse,
  onRegenerate,
  onCancel,
  onDelete,
  onPreview,
}: {
  initialJob: ImageJob;
  onClose: () => void;
  onDownload: (asset: ImageAsset) => void;
  onReference: (asset: ImageAsset) => void;
  onAnnotate: (asset: ImageAsset) => void;
  onMask: (asset: ImageAsset) => void;
  onReuse: (job: ImageJob) => void;
  onRegenerate: (job: ImageJob) => void;
  onCancel: (job: ImageJob) => void;
  onDelete: (job: ImageJob) => void;
  onPreview: (asset: ImageAsset) => void;
}) {
  const tr = useAhaTranslation();
  const snapshot = useQuery({
    queryKey: [...drawingJobsKey, "detail", initialJob.id],
    queryFn: () => drawingApi().getJob({ id: initialJob.id }),
    initialData: initialJob,
  });
  const job = snapshot.data;
  const [index, setIndex] = useState(0);
  const asset = job.outputs[Math.min(index, Math.max(0, job.outputs.length - 1))];
  const navigate = (direction: number) => {
    if (job.outputs.length)
      setIndex((i) => (i + direction + job.outputs.length) % job.outputs.length);
  };
  useEffect(() => {
    notifyNativeSurfaceOcclusionChange();
    return notifyNativeSurfaceOcclusionChange;
  }, []);
  const omittedParameters = [
    job.parameters.size,
    job.parameters.quality,
    job.parameters.outputFormat,
    job.parameters.background,
  ].some((v) => v === undefined);
  const requested = [
    [tr("Size"), drawingParameterLabel(job.parameters.size, tr)],
    [tr("Quality"), drawingParameterLabel(job.parameters.quality, tr)],
    [tr("Image count"), String(job.parameters.n)],
    [
      tr("Format"),
      job.parameters.outputFormat === "webp"
        ? "WebP"
        : (job.parameters.outputFormat?.toUpperCase() ?? tr("Not specified")),
    ],
    [tr("Background"), drawingParameterLabel(job.parameters.background, tr)],
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        className="h-[min(800px,85dvh)] max-w-6xl overflow-hidden rounded-2xl"
        bottomStickOnMobile={false}
        onKeyDown={(e) => {
          if (
            e.target instanceof HTMLElement &&
            e.target.closest("input,textarea,select,[contenteditable=true]")
          )
            return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            navigate(e.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{tr("Image task details")}</DialogTitle>
          <DialogDescription>
            {job.providerName} · {job.model}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
          <div className="relative flex min-h-56 flex-col bg-muted/20 p-4 md:min-h-0 md:min-w-0 md:flex-1">
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              {asset ? (
                <img
                  src={imageUrl(asset)}
                  onContextMenuCapture={(e) =>
                    void resourceContextMenu(
                      e,
                      [drawingResourceSource(asset, imageUrl(asset), job)],
                      tr,
                    )
                  }
                  alt={job.prompt}
                  className="max-h-[45dvh] w-full object-contain md:max-h-full md:h-full"
                />
              ) : (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <CentralIcon name="images-sparkle" className="size-10" />
                  <span>{tr(job.status)}</span>
                </div>
              )}
              {job.outputs.length > job.parameters.n && (
                <p className="text-xs text-muted-foreground">
                  {tr("The provider returned extra images; all saved images are available.")} (
                  {job.outputs.length}/{job.parameters.n})
                </p>
              )}
              {job.outputs.length > 1 ? (
                <>
                  <Button
                    variant="chrome"
                    size="icon-sm"
                    className="absolute left-0 bg-background/80"
                    aria-label={tr("Previous image")}
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    variant="chrome"
                    size="icon-sm"
                    className="absolute right-0 bg-background/80"
                    aria-label={tr("Next image")}
                    onClick={() => navigate(1)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              ) : null}
            </div>
            {asset ? (
              <ResourceCollectButton
                sources={[drawingResourceSource(asset, imageUrl(asset), job)]}
              />
            ) : null}
            {asset ? (
              <p className="pt-2 text-center text-ui-xs text-muted-foreground">
                {asset.width} × {asset.height} · {index + 1}/{job.outputs.length}
              </p>
            ) : null}
            {job.outputs.length > 1 ? (
              <div className="mt-3 flex shrink-0 justify-center gap-2 overflow-x-auto">
                {job.outputs.map((image, i) => (
                  <button
                    /* eslint-disable-next-line react/no-array-index-key -- identical hashes can represent separate ordered result slots */
                    key={`${image.id}:${i}`}
                    type="button"
                    aria-label={`${tr("Image")} ${i + 1}`}
                    aria-pressed={i === index}
                    className={`size-12 shrink-0 overflow-hidden rounded-lg border ${i === index ? "border-foreground ring-1 ring-foreground" : "border-border"}`}
                    onClick={() => setIndex(i)}
                  >
                    <img
                      className="h-full w-full object-contain"
                      src={imageUrl(image, "thumbnail")}
                      alt=""
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col border-t md:w-[360px] md:min-h-0 md:border-t-0 md:border-l">
            <div className="min-h-0 flex-1 space-y-5 p-5 pt-7 md:overflow-y-auto">
              <div>
                <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
                  {tr("Image prompt")}
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {job.prompt}
                </p>
              </div>
              <div className="space-y-1 text-ui-sm">
                <p className="font-medium break-words">{job.providerName}</p>
                <p className="break-all text-muted-foreground">{job.model}</p>
                <p className="flex gap-2 text-muted-foreground">
                  <span>{tr(job.status)}</span>
                  <DrawingElapsed job={job} />
                  {job.isTest ? <span>{tr("Connection test")}</span> : null}
                </p>
                <time className="text-ui-xs text-muted-foreground" dateTime={job.createdAt}>
                  {new Date(job.createdAt).toLocaleString()}
                </time>
              </div>
              <div>
                <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
                  {tr("Requested parameters")}
                </h3>
                <dl className="grid grid-cols-2 gap-2">
                  {requested.map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-muted/40 p-2">
                      <dt className="text-ui-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 text-ui-sm break-words">{value}</dd>
                    </div>
                  ))}
                </dl>
                {omittedParameters ? (
                  <p className="mt-2 text-ui-xs text-muted-foreground">
                    {tr("Unspecified parameters were not sent in this request.")}
                  </p>
                ) : null}
              </div>
              {job.requestPrompt && job.requestPrompt !== job.prompt ? (
                <details className="text-ui-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    {tr("Actual request prompt")}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 font-sans">
                    {job.requestPrompt}
                  </pre>
                </details>
              ) : null}
              {job.inputs.length || job.mask ? (
                <div>
                  <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
                    {tr("Reference images")}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {[...job.inputs, ...(job.mask ? [job.mask] : [])].map((image, i) => (
                      <button
                        /* eslint-disable-next-line react/no-array-index-key -- identical hashes can represent separate ordered result slots */
                        key={`${image.id}:${i}`}
                        type="button"
                        onClick={() => onPreview(image)}
                        title={job.mask?.id === image.id ? tr("Mask") : image.name}
                      >
                        <img
                          className="size-12 rounded-lg border object-contain"
                          src={imageUrl(image, "thumbnail")}
                          alt={image.name}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {Object.keys(job.actualParameters).length ? (
                <div>
                  <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
                    {tr("Returned parameters")}
                  </h3>
                  <dl className="space-y-1 text-ui-xs">
                    {Object.entries(job.actualParameters).map(([name, value]) => (
                      <div key={name} className="flex flex-wrap justify-between gap-2">
                        <dt className="text-muted-foreground">{name}</dt>
                        <dd className="break-all">
                          {typeof value === "string" ? value : JSON.stringify(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              {job.usage && Object.keys(job.usage).length ? (
                <div>
                  <h3 className="mb-2 text-ui-xs font-medium text-muted-foreground">
                    {tr("Usage")}
                  </h3>
                  <dl className="space-y-1 text-ui-xs">
                    {Object.entries(job.usage).map(([name, value]) => (
                      <div key={name} className="flex flex-wrap justify-between gap-2">
                        <dt className="text-muted-foreground">{name}</dt>
                        <dd className="break-all">
                          {typeof value === "string" ? value : JSON.stringify(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              <details className="text-ui-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {tr("Raw response details")}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted/40 p-2">
                  {JSON.stringify(
                    {
                      parameters: job.actualParameters,
                      usage: job.usage,
                      requestId: job.upstreamRequestId,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {job.error ? (
                <p role="alert" className="text-sm break-words text-destructive">
                  {job.error.message} ({job.error.code})
                </p>
              ) : null}
              {job.status === "cancelled" && job.startedAt ? (
                <p className="text-ui-xs text-muted-foreground">
                  {tr("The provider may still process or charge a cancelled request.")}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 border-t p-3">
              {asset ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => onDownload(asset)}>
                    {tr("Download")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onReference(asset)}>
                    {tr("Use as reference")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAnnotate(asset)}>
                    {tr("Annotate")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onMask(asset)}>
                    {tr("Inpaint")}
                  </Button>
                </>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => onReuse(job)}>
                {tr("Reuse parameters")}
              </Button>
              {activeImageJob(job) ? (
                <Button size="sm" variant="outline" onClick={() => onCancel(job)}>
                  {tr("Cancel task")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onRegenerate(job)}>
                  {tr("Regenerate")} · {job.parameters.n}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => onDelete(job)}
              >
                {tr("Delete")}
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
