import { afterEach, describe, expect, it } from "vitest";
import { migratedWorkspacePath, setWorkspaceMigrationMappings } from "./workspaceMigrationPaths";
import { buildLocalImageUrl } from "./localImageUrls";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { resolveWorkspaceFileOpenTarget } from "./workspaceFileOpener";
afterEach(() => setWorkspaceMigrationMappings([]));
describe("scoped historical workspace links", () => {
  it("rewrites image, markdown and editor paths only within their migrated workspace", () => {
    setWorkspaceMigrationMappings([
      { projectId: "p", source: "/old/project", target: "/new/project" },
    ]);
    expect(migratedWorkspacePath("/old/project/file.png", "/new/project")).toBe(
      "/new/project/file.png",
    );
    expect(migratedWorkspacePath("/old/project/file.png", "/different")).toBe(
      "/old/project/file.png",
    );
    expect(migratedWorkspacePath("/old/project/../private/file", "/new/project")).toBe(
      "/old/project/../private/file",
    );
    expect(migratedWorkspacePath("/old/project-extra/file", "/new/project")).toBe(
      "/old/project-extra/file",
    );
    expect(resolveMarkdownFileLinkTarget("/old/project/file.ts:4", "/new/project")).toBe(
      "/new/project/file.ts:4",
    );
    expect(resolveWorkspaceFileOpenTarget("/old/project/file.ts:4", "/new/project")).toBe(
      "file.ts",
    );
    expect(buildLocalImageUrl({ src: "/old/project/file.png", cwd: "/new/project" })).toContain(
      "path=%2Fnew%2Fproject%2Ffile.png",
    );
  });
});
