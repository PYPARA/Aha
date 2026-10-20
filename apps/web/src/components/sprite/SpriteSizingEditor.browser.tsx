import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import {
  DEFAULT_SPRITE_SIZING,
  NEW_SPRITE_RENDER_SPEC,
  spritePlanTasks,
  type SpritePlanConfiguration,
} from "@synara/contracts";
import { SpriteSizingEditor } from "./SpriteSizingEditor";
import { SpriteNumberField } from "./SpriteNumberField";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
afterEach(cleanup);
function Host({ legacy = false }: { legacy?: boolean }) {
  const [c, set] = useState<SpritePlanConfiguration>({
    workflowVersion: 2,
    renderSpec: NEW_SPRITE_RENDER_SPEC,
    ...(legacy ? {} : { sizing: DEFAULT_SPRITE_SIZING }),
    kind: "animation",
    mode: "separate",
    prompt: "Test",
    actions: [
      {
        id: "idle",
        name: "idle",
        description: "",
        enabled: true,
        frameCount: 8,
        fps: 12,
        loop: true,
      },
    ],
    references: [],
    providerId: "provider",
    model: "model",
    width: 256,
    height: 256,
    background: "transparent",
    chromaKey: "#00ff00",
    parameters: { n: 1, size: "1024x1024", outputFormat: "png" },
  });
  return (
    <div className="max-w-md p-4">
      <SpriteNumberField
        label="Frames"
        max={32}
        value={c.actions[0]!.frameCount}
        onChange={(frameCount) =>
          set((p) => ({ ...p, actions: [{ ...p.actions[0]!, frameCount }] }))
        }
      />
      <SpriteSizingEditor
        configuration={c}
        onChange={(patch) => set((p) => ({ ...p, ...patch }))}
      />
      <output data-testid="compiled-size">
        {spritePlanTasks(c)
          .map((t) => t.parameters.size)
          .join(",")}
      </output>
    </div>
  );
}
it("shows linked sizes, updates odd counts and preserves the 8-frame request limit", async () => {
  await render(<Host />);
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("1024x512");
  await page.getByRole("spinbutton", { name: "Frames", exact: true }).fill("5");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("768x512");
  await page.getByRole("spinbutton", { name: "Frames", exact: true }).fill("16");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("1024x512,1024x512");
});
it("keeps manual request dimensions when frames change, then allows explicit linked adoption", async () => {
  await render(<Host legacy />);
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("1024x1024");
  await page.getByRole("spinbutton", { name: "Frames", exact: true }).fill("6");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("1024x1024");
  await page.getByRole("button", { name: "Adopt recommended layout", exact: true }).click();
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("768x512");
});
it("keeps source sampling independent of output scale and never silently increases request count", async () => {
  await render(<Host />);
  await page.getByText("Layout parameters", { exact: true }).click();
  await page.getByRole("combobox", { name: "Source sampling", exact: true }).click();
  await page.getByRole("option", { name: "2×", exact: true }).click();
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("2048x1024");
  await expect
    .element(page.getByText("Image requests: 1 · Cost unknown", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText("Output frame size: 256×256 · Output size follows project settings", {
        exact: true,
      }),
    )
    .toBeVisible();
});
