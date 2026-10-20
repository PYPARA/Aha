import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Alert } from "../ui/alert";
import { imageUrl, uploadDrawingImage } from "../drawing/useDrawing";
import { XIcon } from "~/lib/icons";
import { SpritePlanCard } from "./SpritePlanCard";
import { readSpriteCreationDraft, spriteCreationDraftKey } from "./spriteCreation";
import { decodeSpriteImages, spriteImageInput } from "./spriteImageInput";
import type { SpriteWorkbenchController } from "./SpriteWorkbench";

/** A lightweight entry in the assistant; opening it never creates a conversation or plan. */
export function SpriteCreationPanel({ controller: c }: { controller: SpriteWorkbenchController }) {
  const target = c.creationTarget;
  const [buffer, setBuffer] = useState(() =>
    target
      ? readSpriteCreationDraft(
          c.project.id,
          target,
          target.kind === "animation"
            ? c.project.actions
                .filter((a) => target.actionIds.includes(a.id))
                .map((a) => a.description ?? "")
                .filter(Boolean)
                .join("\n")
            : "",
        )
      : { prompt: "", references: [], requestId: "" },
  );
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tr = c.tr;
  const update = (next: typeof buffer) => {
    setBuffer(next);
    if (target)
      localStorage.setItem(spriteCreationDraftKey(c.project.id, target), JSON.stringify(next));
  };
  const addFiles = async (files: File[]) => {
    if (uploading) return;
    setUploading(true);
    setError("");
    try {
      if (buffer.references.length + files.length > 15)
        throw new Error("Choose at most 15 reference images.");
      const { sources, errors } = await decodeSpriteImages(files);
      const references = [...buffer.references];
      for (const source of sources) {
        const asset = await uploadDrawingImage(source.blob, source.name);
        references.push({
          referenceId: `upload:${asset.id}`,
          asset,
          role: "reference",
          actionId: null,
          source: "upload",
        });
      }
      update({
        ...buffer,
        references: [...new Map(references.map((r) => [r.asset.id, r])).values()],
      });
      setError(errors.join("\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sb-toolbar border-b">
        <Button size="sm" variant="ghost" onClick={() => c.setCreationMode("chat")}>
          {tr("Back to conversation")}
        </Button>
        {c.planId && target && (
          <Button size="sm" variant="ghost" onClick={() => c.safe(c.startNewGeneration)}>
            {tr("New proposal")}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {c.creationMode === "plan" && c.planId ? (
          <SpritePlanCard
            projectId={c.project.id}
            planId={c.planId}
            threadId={
              c.state.plans?.find((p) => p.id === c.planId)?.threadId ??
              c.project.activeThreadId ??
              ""
            }
          />
        ) : target ? (
          <div
            className="flex flex-col gap-4"
            {...spriteImageInput((files) => void addFiles(files))}
          >
            <div>
              <h3 className="text-ui font-medium">
                {tr(target.kind === "character" ? "Create character" : "Create action")}
              </h3>
              <p className="mt-1 text-ui-sm text-muted-foreground">
                {tr(
                  "Describe your goal or continue in conversation. Preparing a plan does not generate images.",
                )}
              </p>
            </div>
            <label className="flex flex-col gap-2 text-ui-sm">
              {tr("Creation description")}
              <Textarea
                autoFocus
                rows={5}
                value={buffer.prompt}
                maxLength={16000}
                placeholder={tr(
                  target.kind === "character"
                    ? "Describe the character, appearance and style…"
                    : "Describe the movement and expression…",
                )}
                onChange={(e) => update({ ...buffer, prompt: e.target.value })}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    e.stopPropagation();
                    void addFiles(Array.from(e.clipboardData.files));
                  }
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {buffer.references.map((r) => (
                <div key={r.asset.id} className="relative rounded-md border p-1">
                  <img
                    src={imageUrl(r.asset, "thumbnail")}
                    alt={r.asset.name}
                    className="size-16 object-contain"
                  />
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    className="absolute top-0 right-0"
                    aria-label={`${tr("Remove reference")}: ${r.asset.name}`}
                    onClick={() =>
                      update({
                        ...buffer,
                        references: buffer.references.filter((v) => v.asset.id !== r.asset.id),
                      })
                    }
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
            <div className="rounded-md border border-dashed p-3 text-ui-sm text-muted-foreground">
              <Button
                size="sm"
                variant="outline"
                disabled={uploading}
                onClick={() => input.current?.click()}
              >
                {tr("Add reference images")}
              </Button>
              <p className="mt-2">{tr("Drop or paste images here")}</p>
            </div>
            <p className="text-ui-sm text-muted-foreground">
              {target.kind === "character"
                ? tr("Character image: 1024×1024. Action frame size stays unchanged.")
                : `${tr("Sprite sheet")}: 1024×1024 · ${tr("Output frame")}: ${c.project.width}×${c.project.height}`}
            </p>
            {error && (
              <Alert variant="error" size="sm">
                {tr(error)}
              </Alert>
            )}
            <Button
              disabled={
                !buffer.prompt.trim() ||
                c.generationBusy ||
                uploading ||
                c.taskReadStatus !== "ready"
              }
              onClick={async () => {
                setError("");
                try {
                  await c.submitGeneration(buffer);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {tr(c.generationBusy ? "Preparing plan…" : "Prepare generation plan")}
            </Button>
            <Button variant="ghost" onClick={() => c.setCreationMode("chat")}>
              {tr("Create through conversation")}
            </Button>
            <input
              ref={input}
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
