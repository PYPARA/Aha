import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpriteImageDialog } from "./SpriteImageDialog";
import { actionFromSelectedFrames, spriteCharacterSourceIds } from "./spriteModel";
import { drawingApi } from "../drawing/useDrawing";
import { useSpriteWorkbenchController } from "./useSpriteWorkbenchController";
export function SpriteWorkbenchDialogs({
  controller: c,
}: {
  controller: ReturnType<typeof useSpriteWorkbenchController>;
}) {
  const {
    tr,
    update,
    originalImage,
    setOriginalImage,
    draftConflict,
    setDraftConflict,
    safe,
    openPlanConversation,
    setState,
    renameAction,
    setRenameAction,
    sourceEdit,
    setSourceEdit,
    project,
    sourceDelete,
    setSourceDelete,
    removeSource,
    newActionName,
    setNewActionName,
    selected,
    report,
    updatePrompt,
    finishUpdatePrompt,
    importRef,
    importImages,
  } = c;
  const protectedSource =
    sourceDelete !== null && spriteCharacterSourceIds(project).has(sourceDelete);
  return (
    <>
      <Dialog
        open={!!c.pendingImageImport}
        onOpenChange={(open) => {
          if (!open) c.setPendingImageImport(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Import image usage")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="mb-3 text-ui-sm text-muted-foreground">
              {tr("Choose how to use these images. Existing frames are kept.")}
            </p>
            <ol className="max-h-40 overflow-auto text-ui-sm">
              {c.pendingImageImport?.files.map((file, i) => (
                <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                  {i + 1}. {file.name}
                </li>
              ))}
            </ol>
          </DialogPanel>
          <DialogFooter className="flex-wrap">
            <Button variant="ghost" onClick={() => c.setPendingImageImport(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const pending = c.pendingImageImport;
                if (!pending) return;
                c.setPendingImageImport(null);
                safe(() => importImages(pending.files, "materials"), "materials");
                c.setMaterialsVisible(true);
              }}
            >
              {tr("Add to image sources")}
            </Button>
            <Button
              variant="outline"
              disabled={c.pendingImageImport?.files.length !== 1}
              onClick={() => {
                const pending = c.pendingImageImport;
                if (!pending) return;
                c.setPendingImageImport(null);
                safe(async () => {
                  c.setStage("actions");
                  await importImages(pending.files, "source");
                });
              }}
            >
              {tr("Open as sprite sheet")}
            </Button>
            <Button
              onClick={() => {
                const pending = c.pendingImageImport;
                if (!pending) return;
                c.setPendingImageImport(null);
                safe(() => importImages(pending.files, "frames", pending.insertAt));
              }}
            >
              {tr("Insert as animation frames")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SpriteImageDialog asset={originalImage} onClose={() => setOriginalImage(null)} />
      <Dialog
        open={!!draftConflict}
        onOpenChange={(open) => {
          if (!open) setDraftConflict(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("A draft already exists")}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                const plan = draftConflict?.error.currentPlan;
                if (!plan) return;
                setDraftConflict(null);
                safe(() => openPlanConversation(plan.threadId, plan.id));
              }}
            >
              {tr("Continue editing current plan")}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                safe(async () => {
                  if (!draftConflict?.error.currentPlan) return;
                  const { error, input } = draftConflict;
                  const current = error.currentPlan!;
                  const next = await drawingApi().spriteCommand({
                    ...input,
                    replacePlanId: current.id,
                    version: current.version,
                    displayAfter: new Date().toISOString(),
                  });
                  setState(next);
                  setDraftConflict(null);
                  if (next.resultPlanId)
                    await openPlanConversation(current.threadId, next.resultPlanId);
                })
              }
            >
              {tr("Discard current draft and create this plan")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!renameAction}
        onOpenChange={(open) => {
          if (!open) setRenameAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Rename action")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            className="mx-4 my-3 w-auto"
            aria-label={tr("Action name")}
            maxLength={200}
            value={renameAction?.name ?? ""}
            onChange={(e) => setRenameAction((a) => (a ? { ...a, name: e.target.value } : null))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameAction(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!renameAction?.name.trim()}
              onClick={() => {
                if (!renameAction) return;
                update((p) => ({
                  ...p,
                  actions: p.actions.map((a) =>
                    a.id === renameAction.id ? { ...a, name: renameAction.name.trim() } : a,
                  ),
                }));
                setRenameAction(null);
              }}
            >
              {tr("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sourceEdit !== null}
        onOpenChange={(open) => {
          if (!open) setSourceEdit(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Rename image")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={tr("Image name")}
            maxLength={200}
            className="mx-4 my-3 w-auto"
            value={sourceEdit?.name ?? ""}
            onChange={(e) => setSourceEdit((s) => (s ? { ...s, name: e.target.value } : null))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSourceEdit(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!sourceEdit?.name.trim()}
              onClick={() => {
                if (!sourceEdit) return;
                update((p) => ({
                  ...p,
                  sources: p.sources.map((s) =>
                    s.id === sourceEdit.id ? { ...s, name: sourceEdit.name.trim() } : s,
                  ),
                }));
                setSourceEdit(null);
              }}
            >
              {tr("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sourceDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSourceDelete(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Delete image")}</DialogTitle>
          </DialogHeader>
          <div className="px-4 py-3 text-sm">
            <p className="font-medium">
              {project.sources.find((s) => s.id === sourceDelete)?.name}
            </p>
            <p className="mt-2">
              {tr(
                protectedSource
                  ? "This image is retained by a character reference or saved action version."
                  : "This removes the image and its frames. You can undo this change.",
              )}
            </p>
            {project.actionVersions?.some((v) =>
              v.action.frames.some((f) => f.sourceId === sourceDelete),
            ) && (
              <p className="mt-2 text-destructive">
                {tr("Saved action versions using this image will also be removed.")}
              </p>
            )}
            {project.actions
              .filter((a) => a.frames.some((f) => f.sourceId === sourceDelete))
              .map((a) => (
                <p key={a.id} className="mt-1">
                  {a.name}: {a.frames.filter((f) => f.sourceId === sourceDelete).length}{" "}
                  {tr("frames")}
                </p>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSourceDelete(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={protectedSource}
              onClick={() => sourceDelete && removeSource(sourceDelete)}
            >
              {tr("Delete")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={newActionName !== null}
        onOpenChange={(open) => {
          if (!open) setNewActionName(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("New action from selection")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={tr("Action name")}
            maxLength={200}
            className="mx-4 my-3 w-auto"
            value={newActionName ?? ""}
            onChange={(e) => setNewActionName(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewActionName(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!newActionName?.trim() || !selected.size}
              onClick={() => {
                if (!newActionName) return;
                try {
                  update((p) => actionFromSelectedFrames(p, selected, newActionName));
                  c.resetActionPreview();
                  setNewActionName(null);
                } catch (error) {
                  report(error);
                }
              }}
            >
              {tr("Create action")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={updatePrompt !== null}
        onOpenChange={(open) => {
          if (!open) finishUpdatePrompt(false);
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("Confirm action updates")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-4 py-3 text-sm">
            <p>
              {tr(
                "Replace the selected actions with this correction? Their current frame edits, frame durations, FPS and loop settings will be replaced. You can undo this operation.",
              )}
            </p>
            <p className="rounded-lg border bg-muted/30 p-3">{updatePrompt?.join(" · ")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => finishUpdatePrompt(false)}>
              {tr("Cancel")}
            </Button>
            <Button onClick={() => finishUpdatePrompt(true)}>
              {tr("Confirm action updates")} ({updatePrompt?.length ?? 0})
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!c.specChange}
        onOpenChange={(open) => {
          if (!open) c.cancelSpecChange();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Change action output specification?")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p>
              {tr(
                "This affects every action canvas and may invalidate the character alignment. Current action edits are saved as recoverable versions; existing tasks and processing versions keep their frozen geometry.",
              )}
            </p>
            <p className="mt-3 text-ui-sm">
              {project.width}×{project.height} →{" "}
              {c.specChange?.renderSpec
                ? `${c.specChange.renderSpec.logicalWidth * c.specChange.renderSpec.outputScale}×${c.specChange.renderSpec.logicalHeight * c.specChange.renderSpec.outputScale}`
                : `${c.specChange?.width}×${c.specChange?.height}`}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={c.cancelSpecChange}>
              {tr("Cancel")}
            </Button>
            <Button onClick={c.confirmSpecChange}>
              {tr("Save versions and change specification")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <input
        ref={importRef}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (c.materialsVisible || c.stage === "character")
            safe(() => importImages(files, "materials"), "materials");
          else c.setPendingImageImport({ files });
        }}
      />
    </>
  );
}
