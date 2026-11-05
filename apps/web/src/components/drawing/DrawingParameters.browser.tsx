import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { ImageGenerationParameters } from "@synara/contracts";
import { DrawingParameters } from "./DrawingPickers";
import { normalizeDrawingParameters, updateDrawingParameters } from "./drawingParameters";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
afterEach(cleanup);
function Host({ initial }: { initial: ImageGenerationParameters }) {
  const [p, set] = useState(() => normalizeDrawingParameters(initial).parameters);
  return (
    <div>
      <DrawingParameters
        parameters={p}
        onChange={(patch) => set((current) => updateDrawingParameters(current, patch).parameters)}
      />
      <output data-testid="parameters">{JSON.stringify(p)}</output>
    </div>
  );
}
const parameters = () =>
  JSON.parse(page.getByTestId("parameters").element().textContent ?? "{}") as Record<
    string,
    unknown
  >;

it("sizes GIF frames below the still minimum and warns about the combined sheet", async () => {
  await render(<Host initial={{ n: 1, outputFormat: "gif", frameCount: 4 }} />);
  await page.getByRole("button", { name: "Frame size", exact: true }).click();
  await expect.element(page.getByText("Set frame dimensions")).toBeVisible();
  await page.getByRole("button", { name: "By aspect ratio", exact: true }).click();
  await page.getByRole("button", { name: "512", exact: true }).click();
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await expect.element(page.getByText("512×512", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Custom width and height", exact: true }).click();
  await page.getByRole("textbox", { name: "Width", exact: true }).fill("256");
  await page.getByRole("textbox", { name: "Height", exact: true }).fill("256");
  await expect.element(page.getByText(/below the minimum pixel budget/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await vi.waitFor(() => expect(parameters().size).toBe("256x256"));
});

it("accepts typed frame counts and durations within the official range", async () => {
  await render(<Host initial={{ n: 1, outputFormat: "gif" }} />);
  await page.getByRole("button", { name: /^Frames: / }).click();
  const frames = page.getByRole("spinbutton", { name: "Custom", exact: true });
  await frames.fill("33");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(parameters().frameCount).toBe(33));
  await frames.fill("99");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(parameters().frameCount).toBe(64));
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: /^Per frame: / }).click();
  const duration = page.getByRole("spinbutton", { name: "Custom", exact: true });
  await duration.fill("1234");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(parameters().frameDurationMs).toBe(1230));
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: /^Complexity: / }).click();
  await page.getByRole("menuitemradio", { name: "Low" }).click();
  await vi.waitFor(() => expect(parameters().complexity).toBe("low"));
});
