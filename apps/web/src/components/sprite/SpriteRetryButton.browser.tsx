import "../../index.css";
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { SpriteRun } from "@synara/contracts";
import { previewAhaThemeState } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { SpriteRetryButton } from "./SpriteRetryButton";
const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({
  drawingApi: () => ({ spriteRetryConfirm: mocks.retry }),
}));
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }));
});
const failed = {
  id: "failed",
  status: "failed",
  input: { kind: "animation" },
  context: {
    projectId: "p",
    threadId: "t",
    providerId: "provider",
    model: "image",
    action: "idle",
  },
  frames: [],
  source: null,
  submissionParameters: { size: "512x512", outputFormat: "gif", frameCount: 8 },
} as unknown as SpriteRun;
it("requires explicit confirmation and reuses the request id after a lost response", async () => {
  mocks.retry
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce({ context: null, runs: [] });
  const onState = vi.fn();
  await page.viewport(430, 900);
  await render(<SpriteRetryButton runs={[failed]} allRuns={[failed]} onState={onState} />);
  await page.getByRole("button", { name: "Retry failed tasks", exact: true }).click();
  expect(mocks.retry).not.toHaveBeenCalled();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-retry-light.png" });
  const theme = structuredClone(DEFAULT_THEME_STATE);
  theme.mode = "dark";
  Object.assign(theme.chromeThemes.dark, { surface: "#0B172A", ink: "#EAF2FC", accent: "#68B9F0" });
  previewAhaThemeState(serializeThemeState(theme));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-retry-current-skin.png" });
  await expect
    .element(
      page.getByText("Retry uses the original submitted settings and may incur another charge."),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Retry with original settings (1)", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
  await page.getByRole("button", { name: "Retry with original settings (1)", exact: true }).click();
  expect(mocks.retry.mock.calls[0]![0]).toEqual(mocks.retry.mock.calls[1]![0]);
  expect(onState).toHaveBeenCalledTimes(1);
});
it("omits succeeded tasks and existing retry attempts", async () => {
  const success = { ...failed, id: "success", status: "ready" as const, source: {} as never };
  const next = { ...failed, id: "next", status: "running" as const, retryOfRunId: failed.id };
  await render(
    <SpriteRetryButton
      runs={[failed, success, next]}
      allRuns={[failed, success, next]}
      onState={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Retry failed tasks", exact: true }))
    .not.toBeInTheDocument();
});
it("replans failed sprite-sheet tasks as GIF instead of resending them", async () => {
  const sheet = {
    ...failed,
    id: "sheet",
    submissionParameters: { size: "1152x576", outputFormat: "png" },
  } as SpriteRun;
  const onModify = vi.fn();
  await render(
    <SpriteRetryButton runs={[sheet]} allRuns={[sheet]} onState={() => {}} onModify={onModify} />,
  );
  await expect
    .element(page.getByRole("button", { name: "Retry failed tasks", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Prepare a GIF plan", exact: true }).click();
  expect(onModify).toHaveBeenCalledExactlyOnceWith(sheet);
  expect(mocks.retry).not.toHaveBeenCalled();
});
