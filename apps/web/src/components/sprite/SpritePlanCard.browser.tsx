import "../../index.css";
import { previewAhaThemeState } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type {
  SpriteState,
  SpriteGenerationPlan,
  SpriteCommand,
  SpritePlanConfirmInput,
} from "@synara/contracts";
import { MessageId, TurnId } from "@synara/contracts";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { deriveTimelineEntries, deriveWorkLogEntries } from "~/workLog";
import { makeActivity } from "~/storeTestFixtures";
import { SpritePlanCard } from "./SpritePlanCard";
const mocks = vi.hoisted(() => ({
  state: { context: null, runs: [], plans: [] } as SpriteState,
  command: vi.fn(),
  confirm: vi.fn(),
  retry: vi.fn(),
  navigate: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("~/aha/AppearanceProvider", async (original) => ({
  ...(await original<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (s: string) => s,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../drawing/useDrawing", () => ({
  useImageProviders: () => ({
    data: [{ id: "drawing", name: "OpenAI", enabled: true, models: [{ id: "gpt-image" }] }],
  }),
  drawingApi: () => ({
    spriteCommand: mocks.command,
    spriteConfirm: mocks.confirm,
    spriteRetryConfirm: mocks.retry,
    onEvent: () => () => {},
  }),
  uploadDrawingImage: mocks.upload,
  imageUrl: () =>
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect x='16' y='12' width='32' height='42' rx='10' fill='%23b7a7e5'/%3E%3C/svg%3E",
}));
function initialPlan(): SpriteGenerationPlan {
  return {
    id: "plan",
    projectId: "project",
    threadId: "thread",
    turnId: "turn",
    requestId: "request",
    version: 1,
    status: "draft",
    confirmedAt: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    configuration: {
      kind: "animation",
      mode: "combined",
      prompt: "A small fox, pixel art, side view. Keep the same character across every action.",
      actions: [8, 12, 6].map((frameCount, i) => ({
        id: `action-${i}`,
        name: ["idle", "walk", "jump"][i]!,
        description: ["Breathe gently", "Walk to the right", "Jump and land"][i]!,
        enabled: true,
        frameCount,
        fps: 12,
        loop: i < 2,
      })),
      references: [
        {
          referenceId: "attachment:fox",
          role: "character",
          actionId: null,
          asset: {
            id: "fox",
            name: "fox.png",
            mimeType: "image/png",
            url: "/asset",
            thumbnailUrl: "/thumb",
            width: 256,
            height: 256,
            bytes: 100,
            createdAt: "2026-10-14T00:00:00.000Z",
          },
        },
      ],
      providerId: "drawing",
      model: "gpt-image",
      width: 256,
      height: 256,
      background: "transparent",
      chromaKey: "#00ff00",
      parameters: { n: 1, size: "auto", quality: "auto", outputFormat: "png" },
    },
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.removeItem("aha-sprite-plan-focus");
  await page.viewport(820, 1200);
  mocks.state = { context: null, runs: [], plans: [initialPlan()] };
  mocks.command.mockImplementation(async (input: SpriteCommand) => {
    if (input.operation === "update-plan") {
      const p = mocks.state.plans![0]!;
      mocks.state = {
        ...mocks.state,
        plans: [{ ...p, version: p.version + 1, configuration: input.configuration! }],
      };
    }
    if (input.operation === "dismiss-plan")
      mocks.state = { ...mocks.state, plans: [{ ...mocks.state.plans![0]!, status: "dismissed" }] };
    return structuredClone(mocks.state);
  });
  mocks.confirm.mockImplementation(async (_input: SpritePlanConfirmInput) => {
    mocks.state = { ...mocks.state, plans: [{ ...mocks.state.plans![0]!, status: "confirmed" }] };
    return structuredClone(mocks.state);
  });
});
afterEach(async () => {
  await cleanup();
  document.querySelectorAll("[data-plan-test]").forEach((el) => el.remove());
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }));
});
async function mount() {
  const expandByDefault = localStorage.getItem("aha-sprite-plan-collapsed:plan") === null;
  const host = document.createElement("div");
  host.dataset.planTest = "true";
  host.style.cssText = "max-width:720px;margin:24px auto;padding:0 16px;";
  document.body.append(host);
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SpritePlanCard projectId="project" planId="plan" threadId="thread" />
    </QueryClientProvider>,
    { container: host },
  );
  await expect
    .element(page.getByRole("heading", { name: /^(Action|Character) generation$/ }))
    .toBeVisible();
  if (expandByDefault && mocks.state.plans![0]!.status === "draft")
    await page.getByRole("button", { name: "Modify parameters", exact: true }).click();
  return host;
}
it("shows an editable multi-action plan and submits only the saved version", async () => {
  await mount();
  expect(mocks.confirm).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("1 image tasks · 3 actions · 26 frames", { exact: true }))
    .toBeVisible();
  await page.getByRole("spinbutton", { name: "Frames 1" }).fill("10");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => mocks.state.plans![0]!.configuration.actions[0]!.frameCount).toBe(10);
  await expect.element(page.getByRole("button", { name: "Start generation · 1" })).toBeEnabled();
  await page.getByRole("button", { name: "Start generation · 1" }).click();
  expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({
    projectId: "project",
    planId: "plan",
    threadId: "thread",
    version: 2,
  });
  await expect.element(page.getByRole("button", { name: "Expand plan" })).toBeVisible();
  await page.getByRole("button", { name: "Expand plan" }).click();
  await expect.element(page.getByRole("spinbutton", { name: "Frames 1" })).not.toBeInTheDocument();
});
it("changes generation mode and blocks animation without a character reference", async () => {
  await mount();
  await page.getByRole("combobox", { name: "Generation mode" }).click();
  await page.getByRole("option", { name: "One image per action", exact: true }).click();
  await expect
    .element(page.getByText("3 image tasks · 3 actions · 26 frames", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start generation · 3" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove reference fox.png" }).click();
  await expect
    .element(page.getByText("Add a reference image before generating animation.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start generation · 3" })).toBeDisabled();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("sends the chosen 512 request dimensions without increasing the output frame or hiding other request parameters", async () => {
  await mount();
  await page.getByText("Drawing settings", { exact: true }).click();
  await page.getByRole("button", { name: "Size", exact: true }).click();
  await page.getByRole("button", { name: "512×512", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => mocks.state.plans![0]!.configuration.parameters.size).toBe("512x512");
  expect(mocks.state.plans![0]!.configuration.width).toBe(256);
  await page.getByRole("combobox", { name: "Quality", exact: true }).click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect.poll(() => mocks.state.plans![0]!.configuration.parameters.quality).toBe("high");
  expect(mocks.state.plans![0]!.configuration.parameters.size).toBe("512x512");
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("keeps conflicting edits visible and requires reload before confirming", async () => {
  await mount();
  mocks.command.mockImplementation(async (input: SpriteCommand) => {
    if (input.operation === "update-plan")
      throw new Error("Plan changed. Refresh before editing or confirming.");
    return structuredClone(mocks.state);
  });
  await page.getByRole("spinbutton", { name: "Frames 1" }).fill("10");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      page.getByText("Plan changed. Refresh before editing or confirming.", { exact: false }),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload plan" }).click();
  await expect.element(page.getByRole("spinbutton", { name: "Frames 1" })).toHaveValue("8");
});
it("fits narrow chat widths and uses project styling in light and dark themes", async () => {
  await page.viewport(430, 1600);
  const host = await mount();
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-plan-light.png" });
  previewAhaThemeState(serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-plan-dark.png" });
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
});
it.each([false, true])(
  "shows the actual proposal after the chat settles and reopens (conversationOnly=%s)",
  async (conversationOnly) => {
    const host = document.createElement("div");
    host.dataset.planTest = "true";
    host.style.cssText = "display:flex;flex-direction:column;width:720px;height:950px;";
    document.body.append(host);
    const turnId = TurnId.makeUnsafe("turn");
    const work = deriveWorkLogEntries(
      [
        makeActivity({
          id: "proposal",
          kind: "tool.completed",
          summary: "sprite_animation",
          turnId,
          createdAt: "2026-10-14T00:00:02.000Z",
          payload: {
            itemType: "mcp_tool_call",
            data: {
              item: {
                type: "mcpToolCall",
                id: "retry",
                server: "synara",
                tool: "sprite_animation",
                arguments: { operation: "retry" },
                status: "completed",
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        spritePlan: { projectId: "project", planId: "plan", threadId: "thread" },
                      }),
                    },
                  ],
                },
              },
            },
          },
        }),
      ],
      undefined,
    );
    const view = (working: boolean) => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MessagesTimeline
          hasMessages
          isWorking={working}
          activeTurnInProgress={working}
          activeTurnStartedAt={null}
          activeTurnId={turnId}
          conversationOnly={conversationOnly}
          timelineEntries={deriveTimelineEntries(
            [
              {
                id: MessageId.makeUnsafe("user"),
                role: "user",
                text: "Continue",
                createdAt: "2026-10-14T00:00:00.000Z",
                streaming: false,
              },
              {
                id: MessageId.makeUnsafe("answer"),
                role: "assistant",
                text: "Please confirm the plan card.",
                turnId,
                createdAt: "2026-10-14T00:00:03.000Z",
                completedAt: "2026-10-14T00:00:04.000Z",
                streaming: working,
              },
            ],
            [],
            work,
          )}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-10-14T00:00:05.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </QueryClientProvider>
    );
    const screen = await render(view(true), { container: host });
    await expect
      .element(page.getByRole("heading", { name: /^(Action|Character) generation$/ }))
      .toBeVisible();
    await screen.rerender(view(false));
    await expect
      .element(page.getByRole("heading", { name: /^(Action|Character) generation$/ }))
      .toBeVisible();
    expect(host.querySelectorAll('section[aria-label="Sprite generation plan"]')).toHaveLength(1);
    const answer = host.querySelector('[data-message-id="answer"]')!;
    const planCard = host.querySelector('section[aria-label="Sprite generation plan"]')!;
    expect(
      answer.compareDocumentPosition(planCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await page.getByRole("button", { name: "Modify parameters", exact: true }).click();
    await page.getByRole("combobox", { name: "Generation mode" }).click();
    await page.getByRole("option", { name: "One image per action", exact: true }).click();
    await expect.poll(() => mocks.state.plans![0]!.version).toBe(2);
    await expect
      .element(page.getByRole("heading", { name: /^(Action|Character) generation$/ }))
      .toBeVisible();
    await screen.rerender(<div />);
    await screen.rerender(view(false));
    await expect
      .element(page.getByRole("heading", { name: /^(Action|Character) generation$/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Generation mode" }))
      .toHaveTextContent("One image per action");
    await page.screenshot({
      path: `../../../node_modules/.cache/aha-sprite-plan-after-reply-${conversationOnly}.png`,
    });
  },
);

it("saves edits while collapsed and restores the local disclosure preference after reopening", async () => {
  await mount();
  await page.getByRole("spinbutton", { name: "Frames 1" }).fill("10");
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Collapse plan" }).click();
  await expect.poll(() => mocks.state.plans![0]!.configuration.actions[0]!.frameCount).toBe(10);
  await expect.element(page.getByRole("button", { name: "Modify parameters" })).toBeVisible();
  await cleanup();
  await mount();
  await expect.element(page.getByRole("button", { name: "Modify parameters" })).toBeVisible();
  await page.getByRole("button", { name: "Modify parameters" }).click();
  await expect.element(page.getByRole("spinbutton", { name: "Frames 1" })).toHaveValue("10");
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("restores a single prompt from legacy text and edits drawing background without losing content", async () => {
  mocks.state = {
    context: null,
    runs: [],
    plans: [
      {
        ...initialPlan(),
        configuration: {
          ...initialPlan().configuration,
          prompt: "",
          legacyPrompt: "A fox on a green background at 256x256",
          needsReview: true,
          creative: { character: "", style: "", view: "", sources: {} },
        },
      },
    ],
  };
  await mount();
  await expect
    .element(page.getByRole("textbox", { name: "Prompt", exact: true }))
    .toHaveValue("A fox on a green background at 256x256");
  await page
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("A fox wearing a green coat, pixel art, side view");
  await expect.poll(() => mocks.state.plans![0]!.configuration.prompt).toContain("green coat");
  await page.getByText("Drawing settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Generated background" }).click();
  await page.getByRole("option", { name: "Chroma background", exact: true }).click();
  await expect.poll(() => mocks.state.plans![0]!.configuration.background).toBe("chroma");
  expect(mocks.state.plans![0]!.configuration.creative).toBeUndefined();
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it("registers pasted references in the conversation and saves them without generating", async () => {
  mocks.upload.mockResolvedValue({
    ...initialPlan().configuration.references[0]!.asset,
    id: "pasted",
    name: "pasted.png",
  });
  await mount();
  const zone = document.querySelector<HTMLElement>(
    '[data-sprite-plan-id="plan"] [data-sprite-reference-drop]',
  )!;
  const data = new DataTransfer();
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/png"),
  );
  data.items.add(new File([blob], "pasted.png", { type: "image/png" }));
  zone.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  await expect.poll(() => mocks.state.plans![0]!.configuration.references.length).toBe(2);
  expect(
    mocks.command.mock.calls.some(
      ([c]) => c.operation === "import-references" && c.threadId === "thread",
    ),
  ).toBe(true);
  expect(mocks.confirm).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Remove reference pasted.png" }).click();
  await expect.poll(() => mocks.state.plans![0]!.configuration.references.length).toBe(1);
});
it("uses the current skin palette without losing contrast in a narrow card", async () => {
  const theme = structuredClone(DEFAULT_THEME_STATE);
  theme.mode = "dark";
  Object.assign(theme.chromeThemes.dark, { surface: "#0B172A", ink: "#EAF2FC", accent: "#68B9F0" });
  previewAhaThemeState(serializeThemeState(theme));
  await page.viewport(430, 1600);
  const host = await mount();
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await page.screenshot({ path: "../../../node_modules/.cache/aha-sprite-plan-current-skin.png" });
});

it.each([true, false])(
  "offers original-parameter retry when the confirmed plan is collapsed=%s",
  async (collapsed) => {
    const plan = { ...initialPlan(), status: "confirmed" as const };
    const config = plan.configuration;
    const run: import("@synara/contracts").SpriteRun = {
      id: "failed",
      planId: plan.id,
      planVersion: plan.version,
      configuration: config,
      input: { kind: config.kind, prompt: config.prompt, requestId: "original" },
      context: {
        projectId: "project",
        threadId: "thread",
        name: "Fox",
        providerId: config.providerId,
        model: config.model,
        referenceAssetId: null,
        action: "idle",
        frameCount: 8,
        fps: 12,
        width: 256,
        height: 256,
        background: "transparent",
        chromaKey: "#00ff00",
      },
      status: "failed",
      jobId: "job",
      source: null,
      frames: [],
      warnings: [],
      error: "Image provider returned invalid JSON (524).",
      createdAt: plan.createdAt,
    };
    mocks.state = { context: null, plans: [plan], runs: [run] };
    localStorage.setItem("aha-sprite-plan-collapsed:plan", String(collapsed));
    mocks.retry.mockImplementation(async () => {
      mocks.state = {
        ...mocks.state,
        runs: [run, { ...run, id: "retry", retryOfRunId: run.id, status: "running", error: null }],
      };
      return structuredClone(mocks.state);
    });
    await mount();
    await page.getByRole("button", { name: "Retry failed tasks", exact: true }).click();
    expect(mocks.retry).not.toHaveBeenCalled();
    await page
      .getByRole("button", { name: "Retry with original settings (1)", exact: true })
      .click();
    expect(mocks.retry).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project", threadId: "thread", runIds: ["failed"] }),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.command.mock.calls.every(([input]) => input.operation === "get")).toBe(true);
  },
);
