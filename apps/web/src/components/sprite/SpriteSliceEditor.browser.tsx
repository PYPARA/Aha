import "../../index.css";
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import {
  spriteGridSlice,
  SPRITE_ANALYSIS_VERSION,
  type SpriteRun,
  type SpriteState,
} from "@synara/contracts";
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
          algorithmVersion: SPRITE_ANALYSIS_VERSION,
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
  localStorage.clear();
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
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("15");
  await userEvent.keyboard("{Enter}");
  await page
    .getByRole("button", { name: "Save corrections and return to review", exact: true })
    .click();
  expect(mocks.command).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "save-slicing",
      version: 1,
      slice: expect.objectContaining({
        reviewedActionIds: [],
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
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 2");
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
    .toHaveValue("128");
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 2");
});
it("keeps the edited version when another client updates the candidate", async () => {
  mocks.command.mockRejectedValue(new Error("Candidate changed. Refresh before editing."));
  const run = fixture();
  const screen = await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("15");
  await userEvent.keyboard("{Enter}");
  const changed = { ...run, candidates: [{ ...run.candidates![0]!, version: 2 }] };
  await screen.rerender(<SpriteSliceEditor run={changed} onState={() => {}} onBack={() => {}} />);
  await page
    .getByRole("button", { name: "Save corrections and return to review", exact: true })
    .click();
  expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
  await expect
    .element(page.getByRole("alert").last())
    .toHaveTextContent("Candidate changed. Refresh before editing.");
  await expect
    .element(page.getByRole("spinbutton", { name: "FPS", exact: true }))
    .toHaveValue("15");
});
it("undoes destructive layout changes and restores the unsaved draft after reopening", async () => {
  const run = fixture();
  await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("spinbutton", { name: "FPS", exact: true }).fill("24");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Use content suggestion", exact: true }).click();
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 2");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 3");
  await expect
    .element(page.getByRole("spinbutton", { name: "FPS", exact: true }))
    .toHaveValue("24");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 2");
  await cleanup();
  await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await expect.element(page.getByRole("button", { name: /^idle ·/ })).toHaveTextContent("idle · 2");
  await expect.element(page.getByRole("status")).toHaveTextContent("Restored your slicing draft.");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .element(page.getByRole("spinbutton", { name: "FPS", exact: true }))
    .toHaveValue("24");
});

it("keeps one action across physical rows, edits candidate offsets before adoption and preserves crop origins", async () => {
  const { spriteTaskSlice } = await import("@synara/contracts");
  const base = fixture();
  const action = { ...base.configuration!.actions[0]!, frameCount: 8 };
  const layout = {
    width: 192,
    height: 96,
    columns: 4,
    rows: 2,
    cells: Array.from({ length: 8 }, (_, i) => ({
      id: `cell-${i}`,
      actionId: action.id,
      frameIndex: i,
      x: (i % 4) * 48,
      y: Math.floor(i / 4) * 48,
      width: 48,
      height: 48,
    })),
  };
  const slice = spriteTaskSlice(layout, [action]);
  const run = {
    ...base,
    configuration: {
      ...base.configuration!,
      workflowVersion: 2 as const,
      actions: [action],
      layout,
    },
    candidates: [{ ...base.candidates![0]!, slice }],
  };
  mocks.command.mockImplementation(async (input) => ({
    context: null,
    runs: [{ ...run, candidates: [{ ...run.candidates![0]!, slice: input.slice, version: 2 }] }],
  }));
  await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await expect
    .element(page.getByRole("spinbutton", { name: "Columns", exact: true }))
    .toHaveValue("4");
  await expect
    .element(page.getByRole("spinbutton", { name: "Rows", exact: true }))
    .toHaveValue("2");
  await expect.element(page.getByRole("button", { name: "idle · 8", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Cell width", exact: true }).fill("47");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("spinbutton", { name: "Content origin X", exact: true }))
    .toHaveValue("0");
  await page.getByRole("tab", { name: "Alignment", exact: true }).click();
  await page.getByRole("button", { name: "Frame 5", exact: true }).click({ modifiers: ["Meta"] });
  await page.getByRole("spinbutton", { name: "Offset X", exact: true }).fill("3");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("spinbutton", { name: "Frame duration (ms)", exact: true }).fill("175");
  await userEvent.keyboard("{Enter}");
  await page
    .getByRole("button", { name: "Save corrections and return to review", exact: true })
    .click();
  const input = mocks.command.mock.calls[0]![0];
  expect(input.operation).toBe("save-slicing");
  expect(input.slice.edit.cells[0]).toMatchObject({ id: "cell-0", width: 47, originX: 0 });
  expect(input.slice.edit.actions[0].frames[0]).toMatchObject({ offsetX: 3, durationMs: 175 });
  expect(input.slice.edit.actions[0].frames[4]).toMatchObject({ offsetX: 3, durationMs: 175 });
  expect(input.slice.edit.actions[0].frames[1].offsetX).toBe(0);
  expect(input.slice.rows).toHaveLength(1);
  expect(input.slice.rows[0].cells).toHaveLength(8);
});
it("uses row grouping only after explicit selection and can undo it", async () => {
  const run = fixture();
  await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("tab", { name: "Action grouping", exact: true }).click();
  await page.getByRole("combobox", { name: "Organize actions", exact: true }).click();
  await page.getByRole("option", { name: "All valid cells as one action", exact: true }).click();
  await page.getByRole("button", { name: "Apply grouping", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect.element(page.getByRole("button", { name: "idle · 6", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "idle · 3", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "jump · 3", exact: true })).toBeVisible();
});

it("loads a historical processing version as an undoable draft without generating or adopting", async () => {
  const base = fixture(),
    candidate = base.candidates![0]!,
    old = {
      id: "old",
      createdAt: "2026-10-19T00:00:00Z",
      configuration: candidate.analysis!.suggestion,
      frames: [],
      actions: [],
      warnings: [],
      issues: [],
    },
    current = {
      ...old,
      id: "current",
      createdAt: "2026-10-20T00:00:00Z",
      configuration: candidate.slice!,
    };
  const run = {
    ...base,
    candidates: [
      { ...candidate, processingVersionId: "current", processingVersions: [old, current] },
    ],
  };
  await render(<SpriteSliceEditor run={run} onState={() => {}} onBack={() => {}} />);
  await page.getByRole("combobox", { name: "Processing versions", exact: true }).click();
  await page.getByRole("option", { name: /^v1 ·/ }).click();
  await expect.element(page.getByRole("button", { name: "idle · 2", exact: true })).toBeVisible();
  expect(mocks.command).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "idle · 3", exact: true })).toBeVisible();
});
