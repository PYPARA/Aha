import { copyPngBlobToDesktopClipboard } from "~/lib/desktopClipboard";

async function sourcePng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("PNG encoding failed."))),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

/** Copy full source pixels, independent of thumbnail size and current frame selection. */
export async function copySpriteSourceToClipboard(blob: Blob, isCurrent: () => boolean) {
  const prepare = async () => {
    const png = await sourcePng(blob);
    if (!isCurrent()) throw new Error("The selected image has been removed.");
    return png;
  };
  if (window.desktopBridge?.clipboard?.writeImagePngDataUrl) {
    if (await copyPngBlobToDesktopClipboard(await prepare())) return;
  } else if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // Start the clipboard write during the menu gesture; decoding can finish later.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": prepare() })]);
      return;
    } catch {
      // Report denied or unsupported clipboard writes through the workbench error UI.
    }
  }
  throw new Error("Could not copy image. Check clipboard permissions and try again.");
}
