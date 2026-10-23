import "../../index.css";
import { afterEach, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { ConfirmDialogHost, confirmDialog } from "./confirm-dialog";

vi.mock("~/aha/AppearanceProvider", () => ({ useAhaTranslation: () => (text: string) => text }));
afterEach(async () => {
  await cleanup();
});

it("resolves true only for the confirm button and focuses Cancel for destructive actions", async () => {
  await render(<ConfirmDialogHost />);
  const removal = confirmDialog({
    title: 'Remove batch record "Icons"?',
    description: "Original images are kept.",
    confirmLabel: "Remove",
    destructive: true,
  });
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toHaveTextContent('Remove batch record "Icons"?');
  await expect.element(dialog).toHaveTextContent("Original images are kept.");
  await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await page.getByRole("button", { name: "Remove" }).click();
  expect(await removal).toBe(true);
  await expect.element(dialog).not.toBeInTheDocument();

  const cancelled = confirmDialog({ title: "Replace the drawing draft?" });
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(await cancelled).toBe(false);
});

it("cancels an unanswered request when a newer one replaces it", async () => {
  await render(<ConfirmDialogHost />);
  const first = confirmDialog({ title: "First" });
  const second = confirmDialog({ title: "Second" });
  expect(await first).toBe(false);
  await expect.element(page.getByRole("alertdialog")).toHaveTextContent("Second");
  await page.getByRole("button", { name: "Confirm" }).click();
  expect(await second).toBe(true);
});
