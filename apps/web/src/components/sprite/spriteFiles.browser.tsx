import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import {
  decodeSpriteSource,
  exportSpriteAssets,
  exportSpriteProject,
  importSpriteProject,
} from "./spriteFiles";
import { newSpriteProject, sliceFrames } from "./spriteModel";
import { saveSpriteProject, listSpriteProjects, deleteSpriteProject } from "./spriteStorage";
async function fixture() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "red";
  ctx.fillRect(4, 8, 6, 6);
  ctx.fillStyle = "blue";
  ctx.fillRect(20, 2, 6, 6);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  const source = await decodeSpriteSource(blob, "test.png");
  const p = newSpriteProject();
  p.width = 16;
  p.height = 16;
  p.sources = [source];
  p.threadId = "private-thread";
  p.providerId = "private-provider";
  p.actions[0]!.frames = sliceFrames(source, {
    mode: "grid",
    columns: 2,
    rows: 1,
    width: 16,
    height: 16,
    margin: 0,
    gap: 0,
  });
  return p;
}
describe("portable sprite exports in a real browser", () => {
  it("round trips editable projects without remote bindings and restores IndexedDB blobs", async () => {
    const p = await fixture();
    const blob = await exportSpriteProject(p);
    const restored = await importSpriteProject(new File([blob], "sprite.zip"));
    expect(restored.id).not.toBe(p.id);
    expect(restored.threadId).toBeNull();
    expect(restored.providerId).toBe("");
    expect(restored.actions).toEqual(p.actions);
    expect(new Uint8Array(await restored.sources[0]!.blob.arrayBuffer())).toEqual(
      new Uint8Array(await p.sources[0]!.blob.arrayBuffer()),
    );
    await saveSpriteProject(restored);
    expect(
      (await listSpriteProjects()).find((x) => x.id === restored.id)?.sources[0]!.blob.size,
    ).toBe(p.sources[0]!.blob.size);
    await deleteSpriteProject(restored.id);
  });
  it("exports atlas rectangles and sequence pixels with matching alpha and motion", async () => {
    const p = await fixture();
    for (const mode of ["atlas", "sequence"] as const) {
      const blob = await exportSpriteAssets(p, [p.actions[0]!.id], mode, 2, 2);
      const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      const metadata = JSON.parse(strFromU8(files["animation.json"]!));
      expect(metadata.actions[0].frames).toHaveLength(2);
      expect(metadata.actions[0].frames[0].durationMs).toBeCloseTo(1000 / 12);
      const filename =
        mode === "atlas" ? metadata.actions[0].image : metadata.actions[0].frames[1].file;
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(files[filename]!)], { type: "image/png" }),
      );
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const ctx = c.getContext("2d")!;
      const offset = mode === "atlas" ? 18 : 0;
      expect([...ctx.getImageData(offset + 4, 2, 1, 1).data]).toEqual([0, 0, 255, 255]);
      expect(ctx.getImageData(offset, 0, 1, 1).data[3]).toBe(0);
      if (mode === "atlas") {
        expect(c.width).toBe(34);
        expect(metadata.actions[0].frames[1].x).toBe(18);
        expect(ctx.getImageData(16, 8, 1, 1).data[3]).toBe(0);
      }
    }
  });
  it("rejects unsupported packages, bad frame references and empty export actions", async () => {
    const p = await fixture();
    const files = unzipSync(new Uint8Array(await (await exportSpriteProject(p)).arrayBuffer()));
    const data = JSON.parse(strFromU8(files["project.json"]!));
    data.actions[0].frames[0].sourceId = "missing";
    files["project.json"] = strToU8(JSON.stringify(data));
    await expect(
      importSpriteProject(new File([new Uint8Array(zipSync(files))], "bad.zip")),
    ).rejects.toThrow(/reference/);
    data.version = 99;
    files["project.json"] = strToU8(JSON.stringify(data));
    await expect(
      importSpriteProject(new File([new Uint8Array(zipSync(files))], "future.zip")),
    ).rejects.toThrow(/Unsupported/);
    p.actions[0]!.frames = [];
    await expect(exportSpriteAssets(p, [p.actions[0]!.id], "atlas", 2, 0)).rejects.toThrow(
      /no frames/,
    );
  });
});

it("replaces decoded source images without drawing a released ImageBitmap", async () => {
  const { render } = await import("vitest-browser-react");
  const { SpritePreview } = await import("./SpritePreview");
  const p = await fixture();
  const view = await render(<SpritePreview project={p} frame={p.actions[0]!.frames[0]!} />);
  await expect
    .poll(
      () => document.querySelector("canvas")?.getContext("2d")?.getImageData(4, 8, 1, 1).data[3],
    )
    .toBe(255);
  const next = { ...p, sources: [...p.sources] };
  await view.rerender(<SpritePreview project={next} frame={next.actions[0]!.frames[1]!} />);
  await expect
    .poll(
      () => document.querySelector("canvas")?.getContext("2d")?.getImageData(4, 2, 1, 1).data[2],
    )
    .toBe(255);
  await view.unmount();
});
