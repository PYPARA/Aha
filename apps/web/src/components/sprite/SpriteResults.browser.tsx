import "../../index.css";
import { previewAhaThemeState } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { SpriteRun, SpriteState, ImageAsset } from "@synara/contracts";
import { SpriteResults } from "./SpriteResults";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
const image =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Crect x='30' y='15' width='68' height='100' rx='14' fill='%23b7a7e5'/%3E%3C/svg%3E";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({
  imageUrl: () => image,
  drawingApi: () => ({ spriteCommand: mocks.command }),
}));
const asset: ImageAsset = {
  id: "image",
  name: "fox.png",
  mimeType: "image/png",
  width: 256,
  height: 256,
  url: image,
  thumbnailUrl: image,
  bytes: 100,
  createdAt: "2026-10-14T00:00:00.000Z",
};
function run(id: string, character = true, failed = false): SpriteRun {
  return {
    id,
    planId: character ? "character-plan" : "animation-plan",
    planVersion: 1,
    input: { kind: character ? "character" : "animation", prompt: "A fox", requestId: id },
    context: {
      projectId: "project",
      threadId: "thread",
      name: "Fox",
      action: "walk",
      frameCount: 8,
      fps: 12,
      width: 256,
      height: 256,
      providerId: "drawing",
      model: "image",
      referenceAssetId: null,
      background: "transparent",
      chromaKey: "#00ff00",
    },
    status: failed ? "failed" : "ready",
    jobId: id,
    source: failed ? null : asset,
    frames: failed ? [] : [asset],
    warnings: [],
    error: failed ? "Image provider returned invalid JSON (524)." : null,
    createdAt: "2026-10-14T00:00:01.000Z",
    ...(!character
      ? {
          actions: [
            {
              action: {
                id: "walk",
                name: "walk",
                description: "walk right",
                enabled: true,
                frameCount: 8,
                fps: 12,
                loop: true,
              },
              frames: [asset],
              warnings: [],
            },
          ],
        }
      : {}),
  };
}
const actions = {
  onPreview: vi.fn(),
  onCommand: vi.fn(),
  onOriginal: vi.fn(),
  onAdjust: vi.fn(),
  onReference: vi.fn(),
  onPlan: vi.fn(),
};
async function mount(state: SpriteState) {
  const host = document.createElement("div");
  host.dataset.resultsTest = "true";
  host.style.cssText = "max-width:740px;margin:16px auto;padding:0 12px;";
  document.body.append(host);
  const view = (next: SpriteState) => <SpriteResults state={next} adopted={[]} {...actions} />;
  const screen = await render(view(state), { container: host });
  return { host, screen, view };
}
afterEach(async () => {
  await cleanup();
  document.querySelectorAll("[data-results-test]").forEach((e) => e.remove());
  vi.clearAllMocks();
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }));
});
it("shows a character preview, chooses a reference and omits animation-only menu actions", async () => {
  const character = run("character");
  const state = { context: null, runs: [character] };
  await mount(state);
  await page.getByRole("button", { name: /Static image.*ready/ }).click();
  await page.getByRole("button", { name: "View image", exact: true }).click();
  expect(actions.onOriginal).toHaveBeenCalledWith(asset);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to plan references" }).click();
  expect(actions.onReference).toHaveBeenCalledWith(character);
  await page.getByRole("button", { name: /Static image.*ready/ }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect.element(page.getByRole("menuitem", { name: "View original sheet" })).toBeVisible();
  expect(document.body.textContent).not.toContain("Correct frame slicing");
  expect(document.body.textContent).not.toContain("Regenerate this action");
  await page.getByRole("menuitem", { name: "Edit before generating again" }).click();
  expect(actions.onCommand).toHaveBeenCalledWith(character, "retry");
});
it("groups separate actions, retains partial failures, and labels non-generating frame corrections", async () => {
  const walk = run("walk", false),
    failed = {
      ...run("jump", false, true),
      context: { ...run("jump", false, true).context, action: "jump" },
    };
  await mount({ context: null, runs: [walk, failed] });
  await page.getByRole("button", { name: /Action animation.*2.*failed/ }).click();
  await expect.element(page.getByText("One image per action · 2 image tasks")).toBeVisible();
  const failure = page.getByTestId("sprite-result-jump");
  await failure.getByText("Error details").click();
  await expect
    .element(failure.getByText("Image provider returned invalid JSON (524)."))
    .toBeVisible();
  await failure.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit before generating again" }).click();
  expect(actions.onCommand).toHaveBeenCalledWith(failed, "retry");
  await page.getByRole("button", { name: /Action animation.*2.*failed/ }).click();
  const success = page.getByTestId("sprite-result-walk");
  await success.getByRole("button", { name: "walk Action options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Regenerate this action" }).click();
  expect(actions.onCommand).toHaveBeenCalledWith(walk, "retry", "walk");
});
it("fits the narrow workspace in light and dark themes", async () => {
  await page.viewport(430, 1100);
  const { host } = await mount({
    context: null,
    runs: [run("character"), run("walk", false), run("failed", false, true)],
  });
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-results-light.png" });
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-results-dark.png" });
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  await page.getByRole("button", { name: /Static image.*ready/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-task-detail-dark.png" });
});

it("soft removes records and restores the same tasks with undo", async () => {
  let state: SpriteState = { context: null, runs: [run("failed", true, true), run("ready")] };
  mocks.command.mockImplementation(async (input: { operation: string; runIds: string[] }) => {
    state = {
      ...state,
      runs: state.runs.map((r) =>
        input.runIds.includes(r.id)
          ? {
              ...r,
              removedAt: input.operation === "remove-run" ? "2026-10-14T00:00:00.000Z" : null,
            }
          : r,
      ),
    };
    return state;
  });
  let screen: Awaited<ReturnType<typeof render>>;
  const view = () => (
    <SpriteResults
      state={state}
      adopted={[]}
      {...actions}
      onState={(next) => {
        state = next;
        void screen.rerender(view());
      }}
    />
  );
  screen = await render(view());
  await page.getByRole("button", { name: "Manage tasks" }).click();
  await page.getByRole("menuitem", { name: "Clear failed records" }).click();
  await expect.element(page.getByRole("button", { name: "Undo removal" })).toBeVisible();
  expect(state.runs.find((r) => r.id === "failed")?.removedAt).toBeTruthy();
  expect(state.runs).toHaveLength(2);
  await page.getByRole("button", { name: "Undo removal" }).click();
  await expect.poll(() => state.runs.find((r) => r.id === "failed")?.removedAt).toBeNull();
  expect(actions.onCommand).not.toHaveBeenCalled();
});
it("uses one action list, keeps preview separate from selection and exposes slicing correction", async () => {
  await page.viewport(1280, 900);
  const animation = run("animation", false),
    outputs = Array.from({ length: 8 }, (_, i) => ({
      action: {
        id: `a-${i}`,
        name: ["idle", "walk", "run", "jump", "wave", "nod", "hit", "victory"][i]!,
        description: "",
        enabled: true,
        frameCount: 2,
        fps: 12,
        loop: true,
      },
      frames: [asset, asset],
      warnings: [],
    }));
  const complete = { ...animation, actions: outputs, frames: outputs.flatMap((a) => a.frames) };
  const onAdopt = vi.fn(async (_run: SpriteRun, _ids: string[], _replace?: boolean) => {});
  const theme = structuredClone(DEFAULT_THEME_STATE);
  theme.mode = "dark";
  Object.assign(theme.chromeThemes.dark, { surface: "#0B172A", ink: "#EAF2FC", accent: "#68B9F0" });
  previewAhaThemeState(serializeThemeState(theme));
  await render(
    <SpriteResults
      state={{ context: null, runs: [complete] }}
      adopted={[]}
      {...actions}
      onAdopt={onAdopt}
    />,
  );
  await page.getByRole("button", { name: /Action animation.*8.*ready/ }).click();
  await page.getByRole("button", { name: /jump 2 frames/ }).click();
  await expect.element(page.getByRole("checkbox", { name: "Select action: idle" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Select action: walk" }).click();
  await expect
    .element(page.getByRole("button", { name: "Add selected actions (7)", exact: true }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Preview animation");
  await page.screenshot({
    path: "../../../node_modules/.cache/aha-sprite-task-redesign-current-skin.png",
  });
  await page.getByRole("button", { name: "Add selected actions (7)", exact: true }).click();
  expect(onAdopt).toHaveBeenCalledWith(complete, expect.arrayContaining(["a-0", "a-3"]), false);
  expect(onAdopt.mock.calls[0]![1]).not.toContain("a-1");
});
