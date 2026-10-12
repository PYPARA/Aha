import { useEffect, useState } from "react";
import type { ImageAsset, ImageEditDocument } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { getImageEditDocument } from "./useDrawing";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ImageAnnotationEditor, type AnnotationSave } from "./ImageAnnotationEditor";
import { MaskCanvasEditor } from "./MaskCanvasEditor";
export function ImageCanvasEditor({
  mode,
  base,
  mask,
  documentId,
  blankSize,
  focusComments,
  focusCommentId,
  onClose,
  onSave,
}: {
  mode: "annotation" | "mask";
  base: ImageAsset | null;
  mask: ImageAsset | null;
  documentId?: string | null | undefined;
  blankSize?: { width: number; height: number } | undefined;
  focusComments?: boolean | undefined;
  focusCommentId?: string | undefined;
  onClose: () => void;
  onSave: (blob: Blob, document?: AnnotationSave) => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const [loaded, setLoaded] = useState<{
    document: ImageEditDocument | null;
    base: ImageAsset | null;
  } | null>(documentId ? null : { document: null, base });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!documentId) return;
    let disposed = false;
    void (async () => {
      try {
        const document = await getImageEditDocument(documentId);
        let original: ImageAsset | null = null;
        if (document.baseAssetId) {
          const response = await fetch(
            resolveWsHttpUrl(`/api/drawing/assets/${document.baseAssetId}?metadata=1`),
            { credentials: "include" },
          );
          if (!response.ok) throw new Error(tr("Could not load image."));
          original = await response.json();
        }
        if (!disposed) setLoaded({ document, base: original });
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [documentId, tr]);
  if (mode === "mask")
    return (
      <MaskCanvasEditor mode="mask" base={base} mask={mask} onClose={onClose} onSave={onSave} />
    );
  if (!loaded)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Annotation canvas")}</DialogTitle>
            <DialogDescription>{tr("Loading...")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>{error ? <p role="alert">{error}</p> : tr("Loading...")}</DialogPanel>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {tr("Cancel")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  return (
    <ImageAnnotationEditor
      {...loaded}
      blankSize={blankSize}
      focusComments={focusComments}
      focusCommentId={focusCommentId}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
