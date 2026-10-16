import "../../index.css";
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";
import { useState } from "react";
import { spriteGridSlice, type SpriteRun, type SpriteState } from "@synara/contracts";
import { SpriteSliceEditor } from "./SpriteSliceEditor";
import { previewAhaThemeState } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
const url =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='192' height='96'%3E%3Crect x='10' y='10' width='20' height='30' fill='%238888cc'/%3E%3Crect x='74' y='10' width='20' height='30' fill='%238888cc'/%3E%3Crect x='10' y='58' width='20' height='30' fill='%238888cc'/%3E%3C/svg%3E";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({
  drawingApi: () => ({ spriteCommand: mocks.command }),
  imageUrl: () => url,
}));
function fixture(): SpriteRun {
  const source = {
    id: "source",
    name: "sheet.png",
    url,
    thumbnailUrl: url,
    width: 192,
    height: 96,
    mimeType: "image/png" as const,
    bytes: 100,
    createdAt: "2026-10-15T00:00:00Z",
  };
  const actions = ["idle", "jump"].map((id) => ({
    id,
    name: id,
    description: "",
    frameCount: 3,
    fps: 12,
    loop: true,
    enabled: true,
  }));
  const slice = spriteGridSlice(192, 96, actions),
    suggestion = spriteGridSlice(
      128,
      96,
      actions.map((a) => ({ ...a, frameCount: 2 })),
    );
  return {
    id: "run",
    context: {
      projectId: "project",
      threadId: "thread",
      name: "Sprite",
      providerId: "provider",
      model: "image",
      referenceAssetId: null,
      action: "idle",
      frameCount: 3,
      fps: 12,
      width: 64,
      height: 64,
      background: "transparent",
      chromaKey: "#00ff00",
    },
    input: { kind: "animation", prompt: "A sprite", requestId: "request" },
    source,
    jobId: "job",
    status: "needs-adjustment",
    frames: [],
    actions: [],
    warnings: [],
    error: null,
    createdAt: source.createdAt,
    selectedCandidateId: source.id,
    candidates: [
      {
        id: source.id,
        source,
        status: "needs-adjustment",
        frames: [],
        actions: [],
        warnings: [],
        error: null,
        version: 1,
        slice,
        analysis: {
          algorithmVersion: "layout-1",
          sourceId: source.id,
          width: 192,
          height: 96,
          plannedFrames: 6,
          cells: 6,
          nonEmptyCells: 3,
          suspectedSubjects: 4,
          reliable: true,
          issues: [],
          suggestion,
        },
      },
    ],
    configuration: {
      kind: "animation",
      mode: "combined",
      prompt: "A sprite",
      actions,
      references: [],
      providerId: "provider",
      model: "image",
      width: 64,
      height: 64,
      background: "transparent",
      chromaKey: "#00ff00",
      parameters: { n: 1, size: "192x96" },
    },
  };
}
function Host() {
  const [state, setState] = useState<SpriteState>({ context: null, runs: [fixture()] });
  return (
    <div style={{ maxWidth: 1000, margin: "auto", padding: 16 }}>
      <SpriteSliceEditor run={state.runs[0]!} onState={setState} onBack={() => {}} />
    </div>
  );
}
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }));
});
it("keeps saved review separate from frame edits and submits the actual corrected cells", async () => {
  mocks.command.mockImplementation(async (input) => {
    const run = fixture();
    const candidate = run.candidates![0]!;
    return {
      context: null,
      runs: [
        {
          ...run,
          candidates: [{ ...candidate, slice: input.slice, version: 2, processingVersionId: "v2" }],
        },
      ],
    };
  });
  await render(<Host />);
  await page.getByRole("button", { name: "Use content suggestion", exact: true }).click();
  await page.getByRole("checkbox", { name: /I checked this action/ }).click();
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("15");
  await expect
    .element(page.getByRole("checkbox", { name: /I checked this action/ }))
    .not.toBeChecked();
  await page.getByRole("checkbox", { name: /I checked this action/ }).click();
  await page.getByRole("button", { name: "Save slicing correction", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "save-slicing",
      version: 1,
      slice: expect.objectContaining({
        reviewedActionIds: ["idle"],
        rows: expect.arrayContaining([
          expect.objectContaining({
            action: expect.objectContaining({ id: "idle", fps: 15 }),
            cells: expect.any(Array),
          }),
        ]),
      }),
    }),
  );
  expect(
    mocks.command.mock.calls[0]![0].slice.rows.map((r: { cells: unknown[] }) => r.cells.length),
  ).toEqual([2, 2]);
  await expect
    .element(page.getByText("Slicing correction saved. No image was generated.", { exact: true }))
    .toBeVisible();
});
it("fits a narrow repair workspace and preserves the current skin contrast", async () => {
  await page.viewport(430, 1100);
  const theme = structuredClone(DEFAULT_THEME_STATE);
  theme.mode = "dark";
  Object.assign(theme.chromeThemes.dark, { surface: "#0B172A", ink: "#EAF2FC", accent: "#68B9F0" });
  previewAhaThemeState(serializeThemeState(theme));
  await render(<Host />);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({
    path: "../../../node_modules/.cache/aha-sprite-slicing-current-skin.png",
  });
  await page.getByRole("button", { name: "Use content suggestion", exact: true }).click();
  await expect
    .element(page.getByRole("spinbutton", { name: "Frames", exact: true }))
    .toHaveValue(2);
});
it("reopens the saved content region instead of resetting its handles to the full image", async () => {
  const run = fixture();
  const saved = {
    ...run,
    candidates: [{ ...run.candidates![0]!, slice: run.candidates![0]!.analysis!.suggestion }],
  };
  await render(<SpriteSliceEditor run={saved} onState={() => {}} onBack={() => {}} />);
  await expect
    .element(page.getByRole("spinbutton", { name: "Content width", exact: true }))
    .toHaveValue(128);
  await expect
    .element(page.getByRole("spinbutton", { name: "Frames", exact: true }))
    .toHaveValue(2);
});
it("keeps the edited version when another client updates the candidate", async () => {
  mocks.command.mockRejectedValue(new Error("Candidate changed. Refresh before editing."));
  const run = fixture();
  const screen = await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("15");
  const changed = { ...run, candidates: [{ ...run.candidates![0]!, version: 2 }] };
  await screen.rerender(<SpriteSliceEditor run={changed} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("button", { name: "Save slicing correction", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Candidate changed. Refresh before editing.");
  await expect.element(page.getByRole("spinbutton", { name: "FPS", exact: true })).toHaveValue(15);
});
