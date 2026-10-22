import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  ImageBatchDefaults,
  ImageBatchSource,
  ImageBatchTask,
  ImageProvider,
} from "@synara/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { DrawingModelPicker, DrawingParameters } from "../drawing/DrawingPickers";
import { imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { getImageEditDocument } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { imageBatchTaskConfiguration } from "@synara/contracts";

export function BatchTaskEditor({
  task,
  defaults,
  sources,
  providers,
  onSave,
  onClose,
  onError,
  onReloadBase,
}: {
  task: ImageBatchTask;
  defaults: ImageBatchDefaults;
  sources: ImageBatchSource[];
  providers: readonly ImageProvider[];
  onSave: (task: ImageBatchTask) => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
  onReloadBase?: () => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => structuredClone(task));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const c = imageBatchTaskConfiguration(draft, defaults);
  const report = (cause: unknown) => {
    setError(tr(cause instanceof Error ? cause.message : String(cause)));
    onError(cause);
  };
  const save = async () => {
    setBusy(true);
    try {
      if (!draft.name.trim() || !draft.prompt.trim())
        throw new Error(tr("Enter a task name and prompt."));
      for (const r of draft.references) if (r.documentId) await getImageEditDocument(r.documentId);
      await onSave(draft);
      onClose();
    } catch (e) {
      setFailed(true);
      report(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tr("Edit image task")}</DialogTitle>
          <DialogDescription>
            {tr("Changes update the draft. Confirmed executions keep their original parameters.")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70dvh] space-y-4 overflow-auto p-4">
          <label className="block space-y-1 text-ui">
            <span>{tr("Task name")}</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={200}
            />
          </label>
          <label className="block space-y-1 text-ui">
            <span>{tr("Final image prompt")}</span>
            <Textarea
              rows={5}
              value={draft.prompt}
              maxLength={32000}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-ui">
            <Checkbox
              checked={!draft.providerId && !draft.parameters && !draft.model}
              onCheckedChange={(checked) =>
                setDraft(
                  checked
                    ? { ...draft, providerId: undefined, model: undefined, parameters: undefined }
                    : { ...draft, ...c },
                )
              }
            />
            {tr("Inherit batch defaults")}
          </label>
          {(draft.providerId || draft.parameters || draft.model) && (
            <div className="space-y-2">
              <DrawingModelPicker
                providers={providers}
                providerId={c.providerId}
                model={c.model}
                onChange={(providerId, model) => setDraft({ ...draft, providerId, model })}
                onSettings={() =>
                  void navigate({ to: "/settings", search: { section: "imageProviders" } })
                }
              />
              <DrawingParameters
                parameters={c.parameters}
                onChange={(patch) =>
                  setDraft({ ...draft, parameters: { ...c.parameters, ...patch } })
                }
              />
            </div>
          )}
          <div className="space-y-2 text-ui">
            <h3 className="font-medium">{tr("Reference images")}</h3>
            <div className="flex flex-wrap gap-2">
              {draft.references.map((r, i) => (
                <Button
                  key={r.id}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      references: draft.references.filter((x) => x.id !== r.id),
                    })
                  }
                >
                  {tr("Reference")} {i + 1} ×
                </Button>
              ))}
            </div>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                setBusy(true);
                void (async () => {
                  const references = [...draft.references];
                  for (const f of files) {
                    if (references.length >= 16)
                      throw new Error(tr("At most 16 reference images are allowed."));
                    const a = await uploadDrawingImage(f, f.name);
                    references.push({ id: crypto.randomUUID(), assetId: a.id, documentId: null });
                  }
                  setDraft({ ...draft, references });
                })()
                  .catch(report)
                  .finally(() => setBusy(false));
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              {tr("Add reference image")}
            </Button>
            <div className="flex flex-wrap gap-2">
              {sources
                .filter((s) => s.asset)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-label={tr("Use reference") + ": " + s.name}
                    className="rounded-md p-1 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      if (
                        draft.references.length >= 16 ||
                        draft.references.some((r) => r.assetId === s.asset!.id)
                      )
                        return;
                      setDraft({
                        ...draft,
                        references: [
                          ...draft.references,
                          { id: crypto.randomUUID(), assetId: s.asset!.id, documentId: null },
                        ],
                      });
                    }}
                  >
                    <img
                      src={imageUrl(s.asset!, "thumbnail")}
                      alt={s.name}
                      className="size-16 rounded object-contain"
                    />
                  </button>
                ))}
            </div>
          </div>
          {sources.length > 0 && (
            <div className="space-y-2 text-ui">
              <h3 className="font-medium">{tr("Source documents")}</h3>
              {sources.map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.sourceIds.includes(s.id)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        sourceIds: checked
                          ? [...draft.sourceIds, s.id]
                          : draft.sourceIds.filter((id) => id !== s.id),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="px-4 pb-3 text-ui-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t p-4">
          {failed && onReloadBase && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onReloadBase()
                  .then(() => {
                    setFailed(false);
                    setError(null);
                  })
                  .catch(report)
                  .finally(() => setBusy(false));
              }}
            >
              {tr("Reload base; keep my edits")}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {tr("Save task")}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
