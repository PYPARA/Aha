import type { ClipboardEvent, DragEvent } from "react";
import { decodeSpriteSource } from "./spriteFiles";

/** All image entry points validate and decode the same supported still-image formats. */
export async function decodeSpriteImages(files: readonly File[]) {
  if (files.length > 128) throw new Error("Import at most 128 images / 80 MiB at once.");
  const sources = [],
    errors: string[] = [];
  for (const file of files) {
    try {
      sources.push(await decodeSpriteSource(file, file.name));
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sources, errors };
}

export function spriteImageInput(onFiles: (files: File[]) => void) {
  return {
    "data-sprite-image-input": true,
    tabIndex: 0,
    onDragOver(event: DragEvent<HTMLElement>) {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.dataset.spriteDragActive = "true";
      }
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        delete event.currentTarget.dataset.spriteDragActive;
    },
    onDragEnd(event: DragEvent<HTMLElement>) {
      delete event.currentTarget.dataset.spriteDragActive;
    },
    onDrop(event: DragEvent<HTMLElement>) {
      delete event.currentTarget.dataset.spriteDragActive;
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      onFiles(Array.from(event.dataTransfer.files));
    },
    onPaste(event: ClipboardEvent<HTMLElement>) {
      if (
        event.defaultPrevented ||
        !event.clipboardData.files.length ||
        (event.target as Element).closest("input,textarea,[contenteditable=true]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onFiles(Array.from(event.clipboardData.files));
    },
  };
}
