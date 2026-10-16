import { afterEach, expect, it, vi } from "vitest";
import { copySpriteSourceToClipboard } from "./spriteClipboard";

afterEach(() => vi.unstubAllGlobals());

async function fixture(type: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "red";
  ctx.fillRect(8, 8, 16, 16);
  return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), type, 1));
}

async function pixels(blob: Blob) {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  image.close();
  return {
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

it.each(["image/png", "image/jpeg", "image/webp"])(
  "copies full %s source pixels as a native PNG",
  async (type) => {
    const write = vi.fn(async (_url: string) => true);
    vi.stubGlobal("desktopBridge", { clipboard: { writeImagePngDataUrl: write } });
    const blob = await fixture(type);
    await copySpriteSourceToClipboard(blob, () => true);
    expect(write).toHaveBeenCalledTimes(1);
    const url = write.mock.calls[0]![0];
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const copied = await (await fetch(url)).blob();
    expect(await pixels(copied)).toEqual(await pixels(blob));
    if (type === "image/png")
      expect(new Uint8Array(await copied.arrayBuffer())).toEqual(
        new Uint8Array(await blob.arrayBuffer()),
      );
  },
);

it("supplies the browser clipboard a PNG promise and preserves transparent pixels", async () => {
  vi.stubGlobal("desktopBridge", undefined);
  const write = vi.fn(async (_items: ClipboardItem[]) => {});
  // Keep the real browser ClipboardItem so its promise conversion is exercised.
  vi.stubGlobal("navigator", { clipboard: { write } });
  const blob = await fixture("image/webp");
  await copySpriteSourceToClipboard(blob, () => true);
  const item = write.mock.calls[0]![0][0]!;
  expect(item.types).toEqual(["image/png"]);
  const copied = await item.getType("image/png");
  expect(await pixels(copied)).toEqual(await pixels(blob));
  expect((await pixels(copied)).data[3]).toBe(0);
});

it("reports native and browser write failures and prevents copying a removed source", async () => {
  const write = vi.fn(async (_url: string) => false);
  vi.stubGlobal("desktopBridge", { clipboard: { writeImagePngDataUrl: write } });
  const blob = await fixture("image/png");
  await expect(copySpriteSourceToClipboard(blob, () => true)).rejects.toThrow(
    "Could not copy image",
  );
  write.mockClear();
  await expect(copySpriteSourceToClipboard(blob, () => false)).rejects.toThrow("removed");
  expect(write).not.toHaveBeenCalled();
  vi.stubGlobal("desktopBridge", undefined);
  vi.stubGlobal("navigator", {
    clipboard: {
      write: async () => {
        throw new Error("Permission denied");
      },
    },
  });
  await expect(copySpriteSourceToClipboard(blob, () => true)).rejects.toThrow(
    "Could not copy image",
  );
  vi.stubGlobal("navigator", {});
  await expect(copySpriteSourceToClipboard(blob, () => true)).rejects.toThrow(
    "Could not copy image",
  );
});
