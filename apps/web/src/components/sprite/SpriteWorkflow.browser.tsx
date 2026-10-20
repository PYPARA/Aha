import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { useState } from "react";
import type { ImageAsset, SpriteState, SpriteCommand } from "@synara/contracts";
import { SpriteCharacterPanel } from "./SpriteCharacterPanel";
import { SpriteNumberField } from "./SpriteNumberField";
import { newSpriteProject, type SpriteProject } from "./spriteModel";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  upload: vi.fn(),
  urls: new Map<string, string>(),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({
  drawingApi: () => ({ spriteCommand: mocks.command }),
  uploadDrawingImage: mocks.upload,
  imageUrl: (asset: ImageAsset) => mocks.urls.get(asset.id) ?? asset.url,
}));
afterEach(async () => {
  await cleanup();
  for (const url of mocks.urls.values()) URL.revokeObjectURL(url);
  mocks.urls.clear();
  vi.clearAllMocks();
  localStorage.clear();
});
it("accepts empty and negative number drafts and commits on Enter or blur", async () => {
  const change = vi.fn();
  await render(<SpriteNumberField label="Offset X" value={192} min={-4096} onChange={change} />);
  const input = page.getByRole("spinbutton", { name: "Offset X" });
  await input.fill("");
  expect(change).not.toHaveBeenCalled();
  await input.fill("-");
  await expect.element(input).toHaveValue("-");
  expect(change).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveValue("192");
  await input.fill("-12");
  await userEvent.keyboard("{Enter}");
  expect(change).toHaveBeenLastCalledWith(-12);
  await input.fill("128");
  await userEvent.keyboard("{Tab}");
  expect(change).toHaveBeenLastCalledWith(128);
});
it("previews and explicitly approves a character before advancing, without an image generation request", async () => {
  await page.viewport(1150, 1000);
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#da7532";
  ctx.fillRect(22, 16, 20, 38);
  ctx.fillStyle = "#111827";
  ctx.fillRect(25, 23, 3, 3);
  ctx.fillRect(36, 23, 3, 3);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  const original: ImageAsset = {
    id: "original",
    name: "fox.png",
    mimeType: "image/png",
    width: 64,
    height: 64,
    bytes: blob.size,
    url: "/original",
    thumbnailUrl: "/original",
    createdAt: new Date().toISOString(),
  };
  const normalized = { ...original, id: "normalized", name: "character-reference.png" };
  mocks.urls.set("original", URL.createObjectURL(blob));
  mocks.urls.set("normalized", URL.createObjectURL(blob));
  mocks.upload.mockResolvedValue(original);
  mocks.command.mockImplementation(async (input: SpriteCommand) => {
    expect(["preview-character", "confirm-character"]).toContain(input.operation);
    const characterPreview = {
      source: original,
      asset: normalized,
      renderSpec: input.renderSpec!,
      registration: input.registration!,
      pivotX: 32,
      pivotY: 57,
      background: input.context!.background,
      chromaKey: input.context!.chromaKey,
    };
    return {
      context: input.context!,
      runs: [],
      characterPreview,
      ...(input.operation === "confirm-character"
        ? {
            canonical: {
              ...characterPreview,
              revision: "revision",
              confirmedAt: new Date().toISOString(),
            },
          }
        : {}),
    };
  });
  let latest: SpriteProject;
  function Host() {
    const [project, setProject] = useState<SpriteProject>(() => ({
      ...newSpriteProject(),
      sources: [{ id: "local", name: "fox.png", blob, width: 64, height: 64, assetId: "original" }],
      referenceSourceId: "local",
    }));
    latest = project;
    const [state, setState] = useState<SpriteState>({ context: null, runs: [] }),
      [done, setDone] = useState(false);
    return (
      <div style={{ maxWidth: 1000, margin: "auto", padding: 16 }}>
        {done ? (
          <p>Character approved; actions available</p>
        ) : (
          <SpriteCharacterPanel
            project={project}
            state={state}
            onChange={setProject}
            onState={setState}
            onDone={() => setDone(true)}
            onGenerate={() => {}}
          />
        )}
      </div>
    );
  }
  await render(<Host />);
  await expect
    .element(page.getByRole("button", { name: "Confirm character reference", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Preview reference", exact: true }).click();
  await expect
    .element(page.getByRole("img", { name: "Processed reference", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Confirm character reference", exact: true }))
    .toBeEnabled();
  await page.screenshot({ path: "../../../node_modules/.cache/aha-staged-character.png" });
  await page.getByRole("button", { name: "Confirm character reference", exact: true }).click();
  await expect.element(page.getByText("Character approved; actions available")).toBeVisible();
  expect(latest!.version).toBe(2);
  expect(latest!.renderSpec).toMatchObject({
    mode: "illustration",
    logicalWidth: 256,
    logicalHeight: 256,
    outputScale: 1,
  });
  expect(latest!.canonical?.revision).toBe("revision");
  expect(latest!.referenceSourceId).not.toBe("local");
  expect(mocks.command.mock.calls.map((call) => call[0].operation)).toEqual([
    "preview-character",
    "confirm-character",
  ]);
});
