import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { SpriteFramePicker } from "./SpriteFramePicker";
import { newSpriteProject, sliceFrames, type SpriteProject } from "./spriteModel";
vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (s: string) => s }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ contextMenu: { show: async () => "none" } }),
}));
afterEach(async () => {
  await cleanup();
  document.querySelectorAll("[data-frame-picker-host]").forEach((el) => el.remove());
});
function Fixture({ initial }: { initial: SpriteProject }) {
  const [frames, setFrames] = useState(initial.actions[0]!.frames),
    [selection, setSelection] = useState(new Set<string>()),
    [index, setIndex] = useState(0);
  return (
    <>
      <input aria-label="Outside text" />
      <SpriteFramePicker
        project={initial}
        frames={frames}
        actionId="action"
        index={index}
        selected={selection}
        onSelection={setSelection}
        onPreview={setIndex}
        onFrames={setFrames}
        onCreate={() => {}}
        onError={(e) => {
          throw e;
        }}
      />
      <output aria-label="Order">{frames.map((f) => f.x / 8 + 1).join(",")}</output>
    </>
  );
}
async function mount() {
  await page.viewport(1100, 900);
  const c = document.createElement("canvas");
  c.width = 400;
  c.height = 8;
  c.getContext("2d")!.fillRect(0, 0, 400, 8);
  const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), "image/png"));
  const p = newSpriteProject();
  p.sources = [{ id: "s", name: "sheet", width: 400, height: 8, blob }];
  p.actions[0]!.frames = sliceFrames(p.sources[0]!, {
    mode: "grid",
    columns: 50,
    rows: 1,
    width: 8,
    height: 8,
    margin: 0,
    gap: 0,
  });
  const host = document.createElement("div");
  host.dataset.framePickerHost = "true";
  host.style.cssText = "width:640px;padding:12px";
  document.body.append(host);
  await render(<Fixture initial={p} />, { container: host });
  return host;
}
it("reorders selected frames as a group and scopes frame keyboard shortcuts away from text inputs", async () => {
  await mount();
  await page.getByRole("button", { name: "Frame 2", exact: true }).click();
  await page.getByRole("button", { name: "Frame 4", exact: true }).click({ modifiers: ["Shift"] });
  await userEvent.dragAndDrop(
    page.getByRole("button", { name: "Frame 3", exact: true }),
    page.getByRole("button", { name: "Frame 1", exact: true }),
  );
  await expect.element(page.getByRole("status", { name: "Order" })).toHaveTextContent(/^2,3,4,1,5/);
  await page.getByRole("textbox", { name: "Outside text" }).fill("Keep typing");
  await userEvent.keyboard("{Backspace}");
  expect(document.querySelectorAll("[data-frame-id]")).toHaveLength(50);
  await page.getByRole("button", { name: "Frame 2", exact: true }).click();
  await userEvent.keyboard("{Control>}a{/Control}");
  expect(document.querySelectorAll('[data-frame-id][aria-pressed="true"]')).toHaveLength(50);
  await userEvent.keyboard("{Escape}");
  expect(document.querySelectorAll('[data-frame-id][aria-pressed="true"]')).toHaveLength(0);
});
it("box-selects from empty space, appends with Control and auto-scrolls at the strip edge", async () => {
  const host = await mount();
  const root = host.querySelector<HTMLDivElement>('[aria-label="Animation frames"]')!;
  // Pointer capture requires a trusted pointer; stub only capture for synthetic pointer coordinates.
  root.setPointerCapture = () => {};
  const bounds = root.getBoundingClientRect();
  const item = root.querySelector<HTMLElement>("[data-frame-id]")!.getBoundingClientRect();
  const send = (type: string, x: number, y: number, ctrlKey = false) =>
    root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
        button: 0,
        ctrlKey,
      }),
    );
  send("pointerdown", bounds.left + 3, bounds.top + 3);
  send("pointermove", item.right + 2, item.bottom + 2);
  send("pointerup", item.right + 2, item.bottom + 2);
  await expect.poll(() => root.querySelectorAll('[aria-pressed="true"]').length).toBe(1);
  send("pointerdown", bounds.left + 3, bounds.top + 3, true);
  send("pointermove", bounds.right - 2, item.bottom + 2, true);
  await expect.poll(() => root.scrollLeft).toBeGreaterThan(0);
  send("pointerup", bounds.right - 2, item.bottom + 2, true);
  expect(root.querySelectorAll('[aria-pressed="true"]').length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  expect(root.className).toContain("grid");
});
