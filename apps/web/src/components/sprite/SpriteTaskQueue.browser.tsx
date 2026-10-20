import "../../index.css";
import "./spriteWorkbench.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { SpriteRun, SpriteState } from "@synara/contracts";
import { SpriteTaskQueue } from "./SpriteTaskQueue";
import type { SpriteWorkbenchController } from "./SpriteWorkbench";
import { newSpriteProject } from "./spriteModel";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  reference: vi.fn(async () => {}),
  inspect: vi.fn(async () => {}),
  slicing: vi.fn(),
  original: vi.fn(),
  plan: vi.fn(async () => {}),
}));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("../drawing/useDrawing", () => ({ drawingApi: () => ({ spriteCommand: mocks.command }) }));
function run(
  id: string,
  kind: "animation" | "character" = "animation",
  status: SpriteRun["status"] = "ready",
): SpriteRun {
  const asset = {
    id: "source",
    name: "fox.png",
    mimeType: "image/png" as const,
    url: "/source",
    thumbnailUrl: "/source",
    width: 16,
    height: 16,
    bytes: 100,
    createdAt: "2026-10-19T00:00:00.000Z",
  };
  return {
    id,
    planId: "plan",
    context: {
      projectId: "project",
      threadId: "thread",
      name: "Fox",
      providerId: "provider",
      model: "image",
      referenceAssetId: null,
      action: id,
      frameCount: 1,
      fps: 12,
      width: 16,
      height: 16,
      background: "transparent",
      chromaKey: "#00ff00",
    },
    input: { kind, prompt: "fox", requestId: id },
    jobId: id,
    source: status === "failed" ? null : asset,
    frames: status === "failed" ? [] : [asset],
    actions:
      kind === "animation"
        ? [
            {
              action: {
                id,
                name: id,
                description: "",
                enabled: true,
                frameCount: 1,
                fps: 12,
                loop: true,
              },
              frames: [asset],
              warnings: [],
            },
          ]
        : [],
    status,
    warnings: [],
    error: status === "failed" ? "Provider unavailable" : null,
    createdAt: asset.createdAt,
  };
}
function Host({ initial }: { initial: SpriteState }) {
  const [state, setState] = useState(initial),
    [queueVisible, setQueueVisible] = useState(true);
  const project = { ...newSpriteProject(), id: "project" };
  const controller = {
    tr: (s: string) => s,
    project,
    state,
    taskReadStatus: "ready",
    setState,
    queueVisible,
    setQueueVisible,
    actionCandidates: [],
    safe: (fn: () => Promise<unknown>) => void fn(),
    inspectCandidate: mocks.inspect,
    openSlicing: mocks.slicing,
    setOriginalImage: mocks.original,
    useCharacterCandidate: mocks.reference,
    openPlanConversation: mocks.plan,
  } as unknown as SpriteWorkbenchController;
  return <SpriteTaskQueue controller={controller} />;
}
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});
it("routes static images to character preparation and original view", async () => {
  const character = run("character", "character");
  await render(<Host initial={{ context: null, runs: [character] }} />);
  await page.getByRole("button", { name: "Use as character reference", exact: true }).click();
  expect(mocks.reference).toHaveBeenCalledWith(character);
  await page.getByRole("button", { name: "View original image", exact: true }).click();
  expect(mocks.original).toHaveBeenCalledWith(character.source);
  expect(mocks.slicing).not.toHaveBeenCalled();
});
it("keeps failures visible and opens candidates and slicing without a task modal", async () => {
  const success = run("walk"),
    failed = run("jump", "animation", "failed");
  await render(<Host initial={{ context: null, runs: [success, failed] }} />);
  await expect.element(page.getByText("Provider unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review candidate", exact: true }).click();
  expect(mocks.inspect).toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await page.getByRole("button", { name: /^Generation tasks ·/ }).click();
  await page.getByRole("button", { name: "Adjust slicing and alignment", exact: true }).click();
  expect(mocks.slicing).toHaveBeenCalledWith(success);
});
it("soft removes failures and restores the same task from folded history", async () => {
  let state: SpriteState = {
    context: null,
    runs: [run("failed", "animation", "failed"), run("walk")],
  };
  mocks.command.mockImplementation(
    async (input: { operation: string; runIds: string[] }) =>
      (state = {
        ...state,
        runs: state.runs.map((r) =>
          input.runIds.includes(r.id)
            ? {
                ...r,
                removedAt: input.operation === "remove-run" ? "2026-10-19T00:00:00.000Z" : null,
              }
            : r,
        ),
      }),
  );
  await render(<Host initial={state} />);
  await page.getByRole("button", { name: "Clear failed records", exact: true }).click();
  await page.getByText("Earlier attempts and removed tasks", { exact: true }).click();
  await page.getByRole("button", { name: "Restore task", exact: true }).click();
  await expect.poll(() => state.runs[0]!.removedAt).toBeNull();
  expect(state.runs).toHaveLength(2);
});
