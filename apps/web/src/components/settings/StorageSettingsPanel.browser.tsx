import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StorageSettingsPanel } from "./StorageSettingsPanel";
import type { WorkspaceMigrationStatus } from "@synara/contracts/workspaceMigration";
import {
  migratedWorkspacePath,
  setWorkspaceMigrationMappings,
} from "~/lib/workspaceMigrationPaths";
vi.mock("~/aha/AppearanceProvider", async (original) => ({
  ...(await original<typeof import("~/aha/AppearanceProvider")>()),
  useAhaTranslation: () => (text: string) => text,
}));
const originalFetch = window.fetch;
let status: WorkspaceMigrationStatus & {
  mappings: { projectId: string; source: string; target: string }[];
};
const requests: string[] = [];
beforeEach(() => {
  status = {
    version: 1,
    running: false,
    directories: {
      root: "/documents/Aha",
      resource: "/documents/Aha/Resource",
      chats: "/documents/Aha/Chats",
      studio: "/documents/Aha/Studio",
      groups: "/documents/Aha/Groups",
      legacyRoot: "/documents/Synara",
    },
    backupPath: "/state/backup.sqlite",
    error: null,
    items: [
      {
        projectId: "one",
        kind: "chat",
        source: "/documents/Synara/old",
        target: "/documents/Aha/Chats/old",
        status: "blocked",
        files: {},
        conflicts: ["hero.png"],
        error: "Destination contains different files.",
        updatedAt: "now",
      },
    ],
    mappings: [],
  };
  requests.length = 0;
  window.fetch = vi.fn(async (input, init) => {
    if (String(input).includes("/api/storage/migration")) {
      requests.push(`${init?.method ?? "GET"} ${input}`);
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  });
});
afterEach(async () => {
  await cleanup();
  window.fetch = originalFetch;
  setWorkspaceMigrationMappings([]);
});
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StorageSettingsPanel />
    </QueryClientProvider>,
  );
}
describe("storage settings", () => {
  it("shows all four destinations, explicit conflicts and the retry action", async () => {
    await mount();
    await expect.element(page.getByText("/documents/Aha/Resource", { exact: true })).toBeVisible();
    await expect.element(page.getByText("/documents/Aha/Chats", { exact: true })).toBeVisible();
    await expect.element(page.getByText("hero.png", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry migration" }).click();
    await vi.waitFor(() =>
      expect(requests.some((r) => r.startsWith("POST") && r.includes("/retry"))).toBe(true),
    );
  });
  it("reflects in-progress migration and loads scoped historical aliases", async () => {
    status.running = true;
    status.items[0]!.status = "copying";
    status.mappings = [
      { projectId: "one", source: "/documents/Synara/old", target: "/documents/Aha/Chats/old" },
    ];
    await mount();
    await expect.element(page.getByRole("button", { name: "Retry migration" })).toBeDisabled();
    await vi.waitFor(() =>
      expect(
        migratedWorkspacePath("/documents/Synara/old/hero.png", "/documents/Aha/Chats/old"),
      ).toBe("/documents/Aha/Chats/old/hero.png"),
    );
  });
});
