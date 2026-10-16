import { useState } from "react";
import type { ImageAsset } from "@synara/contracts";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { imageUrl } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
export function SpriteImageDialog({
  asset,
  onClose,
}: {
  asset: ImageAsset | null;
  onClose: () => void;
}) {
  const tr = useAhaTranslation();
  const [zoom, setZoom] = useState(100);
  const [background, setBackground] = useState("checker");
  return (
    <Dialog
      open={!!asset}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{tr("View image")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Button size="sm" variant="outline" onClick={() => setZoom((v) => Math.max(25, v - 25))}>
            −
          </Button>
          <span className="text-xs">{zoom}%</span>
          <Button size="sm" variant="outline" onClick={() => setZoom((v) => Math.min(400, v + 25))}>
            +
          </Button>
          <select
            aria-label={tr("Preview background")}
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            className="rounded border bg-background p-1 text-xs"
          >
            <option value="checker">{tr("Transparency grid")}</option>
            <option value="light">{tr("Light")}</option>
            <option value="dark">{tr("Dark")}</option>
          </select>
          <span className="text-xs text-muted-foreground">
            {asset?.width} × {asset?.height}
          </span>
        </div>
        <div
          className="max-h-[70vh] overflow-auto p-4"
          style={{
            backgroundColor: background === "dark" ? "#18181b" : "#f4f4f5",
            backgroundImage:
              background === "checker"
                ? "repeating-conic-gradient(#d4d4d8 0% 25%,transparent 0% 50%)"
                : undefined,
            backgroundSize: "20px 20px",
          }}
        >
          {asset && (
            <img
              src={imageUrl(asset)}
              alt={asset.name}
              className="mx-auto object-contain [image-rendering:pixelated]"
              style={{ width: `${zoom}%`, maxWidth: "none" }}
            />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
