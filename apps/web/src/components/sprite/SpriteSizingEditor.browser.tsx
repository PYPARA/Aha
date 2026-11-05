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
it("requests each GIF frame at twice the output and splits long actions evenly", async () => {
  await render(<Host />);
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("512x512");
  await page.getByRole("spinbutton", { name: "Frames", exact: true }).fill("5");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("512x512");
  await page.getByRole("spinbutton", { name: "Frames", exact: true }).fill("20");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("512x512,512x512");
  await expect
    .element(page.getByText("Image requests: 2 · Cost unknown", { exact: true }))
    .toBeVisible();
});
it("re-derives a legacy whole-sheet size, then keeps an explicit per-frame size", async () => {
  await render(<Host legacy />);
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("512x512");
  await page.getByRole("button", { name: "Adopt recommended frame size", exact: true }).click();
  await page.getByRole("combobox", { name: "GIF frame size", exact: true }).click();
  await page.getByRole("option", { name: "Specify frame size", exact: true }).click();
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("1024x1024");
});
it("lowers source sampling within the pixel minimum and sets frames per request", async () => {
  await render(<Host />);
  await page.getByRole("combobox", { name: "Source sampling", exact: true }).click();
  await page.getByRole("option", { name: "1×", exact: true }).click();
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("288x288");
  await page.getByRole("spinbutton", { name: "Frames per request", exact: true }).fill("4");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("compiled-size")).toHaveTextContent("416x416,416x416");
  await expect
    .element(
      page.getByText("Output frame size: 256×256 · Output size follows project settings", {
        exact: true,
      }),
    )
    .toBeVisible();
});
