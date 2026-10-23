import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Model3DCommand, Model3DEnvironment, Model3DProject } from "@synara/contracts";
import Model3DWorkbench from "./Model3DWorkbench";
import { ModelRuntimeDialog, shouldRemindBlender } from "./ModelRuntimeDialog";

const mocks = vi.hoisted(() => ({ command: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (text: string) => text }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ model3d: { ...mocks, onEvent: () => () => {} } }),
}));
vi.mock("./ModelChat", () => ({ ModelChat: () => <div>Model conversation</div> }));
vi.mock("../RouteSurface", () => ({
  RouteSurfaceHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));

let environment: Model3DEnvironment;
let project: Model3DProject;
const close = vi.fn();
const changed = vi.fn();
const mountDialog = (intent: "settings" | "blender" = "settings") =>
  render(
    <ModelRuntimeDialog
      intent={intent}
      initial={environment}
      onClose={close}
      onChanged={changed}
    />,
  );
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("aha:model3d:blender-intro:v1");
  environment = {
    desktop: true,
    blenderPath: "/Applications/Blender.app/Contents/MacOS/Blender",
    uvxPath: "/Users/test/.local/bin/uvx",
    prepared: true,
    blenderVersion: "Blender 5.2.2 LTS",
    error: null,
  };
  project = {
    schemaVersion: 1,
    id: "project",
    revision: 1,
    name: "Chest",
    updatedAt: new Date().toISOString(),
    mode: "threejs",
    triangleBudget: 5000,
    textureBudget: 2048,
    threadId: null,
    adoptedVersionId: null,
    previewVersionId: null,
    versions: [],
    jobs: [],
    textures: [],
    archived: false,
  };
  mocks.get.mockImplementation(async () => project);
  mocks.list.mockResolvedValue([]);
  mocks.command.mockImplementation(async (input: Model3DCommand) => {
    if (input.operation === "update") {
      project = { ...project, revision: project.revision + 1, mode: input.mode ?? project.mode };
      return { project };
    }
    return { project: null, environment };
  });
});
afterEach(async () => {
  await cleanup();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--app-font-size-ui");
  localStorage.removeItem("aha:model3d:blender-intro:v1");
  await page.viewport(1280, 900);
});

it("reminds after a successful Blender selection, remembers acknowledgement, and repeats when dependencies are missing", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <div style={{ height: 700, display: "flex", flexDirection: "column" }}>
        <Model3DWorkbench projectId="project" />
      </div>
    </QueryClientProvider>,
  );
  const route = page.getByRole("combobox", { name: "Modeling route" });
  await route.click();
  await page.getByRole("option", { name: "Blender MCP" }).click();
  await expect.element(page.getByRole("dialog", { name: "Model with Blender" })).toBeVisible();
  await page.getByRole("button", { name: "Use Blender", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(shouldRemindBlender(environment)).toBe(false);
  await route.click();
  await page.getByRole("option", { name: "Three.js", exact: true }).click();
  await expect.element(route).toHaveTextContent("Three.js");
  await route.click();
  await page.getByRole("option", { name: "Blender MCP" }).click();
  await expect.element(route).toHaveTextContent("Blender MCP");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  environment = { ...environment, prepared: false };
  await route.click();
  await page.getByRole("option", { name: "Three.js", exact: true }).click();
  await expect.element(route).toHaveTextContent("Three.js");
  await route.click();
  await page.getByRole("option", { name: "Blender MCP" }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Prepare Blender dependencies");
  expect(
    mocks.command.mock.calls.some(
      ([c]) =>
        c.operation === "prepare-runtime" ||
        c.operation === "check-runtime" ||
        c.operation === "submit",
    ),
  ).toBe(false);
});

it("prepares only on request, reports progress, and leaves the new ready state for explicit acknowledgement", async () => {
  environment = { ...environment, prepared: false };
  let complete: (() => void) | undefined;
  mocks.command.mockImplementation(async (input: Model3DCommand) => {
    if (input.operation === "prepare-runtime") {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      environment = { ...environment, prepared: true };
    }
    return { project: null, environment };
  });
  await mountDialog("blender");
  await page.getByRole("button", { name: "Prepare Blender runtime", exact: true }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Preparing Blender dependencies…");
  await expect
    .element(page.getByRole("button", { name: "Preparing…", exact: true }))
    .toBeDisabled();
  complete!();
  await expect
    .element(page.getByRole("button", { name: "Use Blender", exact: true }))
    .toBeEnabled();
  expect(close).not.toHaveBeenCalled();
  expect(mocks.command.mock.calls.map(([c]) => c.operation)).toEqual([
    "environment",
    "blender-settings",
    "prepare-runtime",
  ]);
});

it("shows connection errors inside the dialog and supports an explicit successful retry", async () => {
  let fail = true;
  mocks.command.mockImplementation(async (input: Model3DCommand) => {
    if (input.operation === "check-runtime" && fail)
      throw new Error("Cannot connect to the dedicated Blender instance.");
    return { project: null, environment };
  });
  await mountDialog();
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect
    .element(page.getByRole("dialog").getByRole("alert"))
    .toHaveTextContent("Cannot connect to the dedicated Blender instance.");
  fail = false;
  await page.getByRole("button", { name: "Save and check", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Blender connection verified");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

it("retains a typed path when choosing the other executable or receiving a refreshed environment", async () => {
  const view = await mountDialog();
  const uvx = page.getByRole("textbox", { name: "uvx executable", exact: true });
  await expect.element(uvx).toBeEnabled();
  await uvx.fill("/custom/path/uvx");
  await page.getByRole("button", { name: "Choose Blender executable", exact: true }).click();
  await expect.element(uvx).toHaveValue("/custom/path/uvx");
  await view.rerender(
    <ModelRuntimeDialog
      intent="settings"
      initial={{ ...environment, blenderVersion: "Refreshed version" }}
      onClose={close}
      onChanged={changed}
    />,
  );
  await expect.element(uvx).toHaveValue("/custom/path/uvx");
  await page.getByRole("button", { name: "Save and check", exact: true }).click();
  expect(mocks.command).toHaveBeenCalledWith({
    operation: "blender-settings",
    blenderPath: environment.blenderPath,
    uvxPath: "/custom/path/uvx",
  });
});

it("recovers a failed detection and never offers local setup without a desktop host", async () => {
  mocks.command.mockRejectedValueOnce(new Error("Host unavailable"));
  await render(
    <ModelRuntimeDialog intent="blender" initial={undefined} onClose={close} onChanged={changed} />,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Use Blender", exact: true }))
    .toBeEnabled();
  await cleanup();
  environment = { ...environment, desktop: false };
  await mountDialog("blender");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Open Aha desktop to use Blender");
  await expect
    .element(page.getByRole("textbox", { name: "Blender executable", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Use Blender", exact: true }))
    .not.toBeInTheDocument();
});

it("keeps fields inset and footer reachable on a narrow window with enlarged text, in either theme", async () => {
  await page.viewport(420, 620);
  document.documentElement.style.setProperty("--app-font-size-ui", "20px");
  for (const dark of [false, true]) {
    document.documentElement.classList.toggle("dark", dark);
    await mountDialog();
    await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
    const popup = document.querySelector('[data-slot="dialog-popup"]')!.getBoundingClientRect();
    const input = document.querySelector("input")!.getBoundingClientRect();
    const footer = document.querySelector('[data-slot="dialog-footer"]')!.getBoundingClientRect();
    expect(input.left - popup.left).toBeGreaterThanOrEqual(12);
    expect(popup.right - input.right).toBeGreaterThanOrEqual(12);
    expect(footer.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(document.querySelector('[data-slot="dialog-panel"]')!.scrollWidth).toBeLessThanOrEqual(
      popup.width,
    );
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalled();
    await cleanup();
  }
});
