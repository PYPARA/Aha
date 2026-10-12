import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceMigrationCoordinator, type MigrationProject } from "./coordinator";
import { copyWorkspace } from "./copyWorkspace";
import type { WorkspaceMigrationItem } from "@synara/contracts/workspaceMigration";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  copyFile: vi.fn((...args: Parameters<typeof fs.copyFile>) =>
    import("node:fs").then(
      (module) =>
        new Promise<void>((resolve, reject) =>
          module.copyFile(args[0], args[1], args[2] ?? 0, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
    ),
  ),
}));
let home: string;
let projects: MigrationProject[];
let source: string;
let changed = vi.fn<(id: string, target: string) => void>();
let blocked = false;
let backup = vi.fn<() => void>();
function coordinator() {
  return new WorkspaceMigrationCoordinator(
    path.join(home, "state"),
    {
      projects: async () => projects,
      checkIdle: async () => {
        if (blocked) throw new Error("active session");
      },
      backup: async () => {
        backup();
        return path.join(home, "backup.sqlite");
      },
      relocate: async (project, target) => {
        changed(project.id, target);
        projects = projects.map((p) => (p.id === project.id ? { ...p, root: target } : p));
      },
    },
    home,
  );
}
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-workspace-migrate-")));
  source = path.join(home, "Documents/Synara/2026-10-12/chat-one");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "hello.txt"), "hello");
  projects = [{ id: "chat1", kind: "chat", title: "Test", root: source }];
  changed = vi.fn();
  backup = vi.fn();
  blocked = false;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});
describe("copy and switch managed Aha directories", () => {
  it("copies hidden files and permissions, switches only Aha records and preserves source", async () => {
    await fs.writeFile(path.join(source, ".hidden"), "secret", { mode: 0o600 });
    const unrelated = path.join(home, "Documents/Synara/other-app");
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, "data.txt"), "other");
    const c = coordinator();
    await c.run();
    expect(c.status().items[0]?.status).toBe("complete");
    const target = path.join(home, "Documents/Aha/Chats/2026-10-12/chat-one");
    expect(projects[0]?.root).toBe(target);
    expect(await fs.readFile(path.join(source, "hello.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(target, ".hidden"), "utf8")).toBe("secret");
    expect((await fs.stat(path.join(target, ".hidden"))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.join(home, "Documents/Aha/Chats"))).toEqual(["2026-10-12"]);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(await c.mappings()).toEqual([{ projectId: "chat1", source, target }]);
  });
  it("migrates referenced Studio and Groups, excludes custom projects and library locations", async () => {
    for (const [id, kind, relative] of [
      ["s", "studio", "Studio"],
      ["g", "group", "Groups/team"],
    ]) {
      const root = path.join(home, "Documents/Synara", relative!);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "asset.txt"), id!);
      projects.push({ id: id!, kind: kind!, root, title: id! });
    }
    projects.push({ id: "code", kind: "project", title: "code", root: path.join(home, "code") });
    await coordinator().run();
    expect(projects.find((p) => p.id === "s")?.root).toBe(path.join(home, "Documents/Aha/Studio"));
    expect(projects.find((p) => p.id === "g")?.root).toBe(
      path.join(home, "Documents/Aha/Groups/team"),
    );
    expect(projects.find((p) => p.id === "code")?.root).toBe(path.join(home, "code"));
  });
  it("never overwrites a destination conflict and retries successfully after resolution", async () => {
    const c = coordinator(),
      target = path.join(c.directories.chats, "2026-10-12/chat-one");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "hello.txt"), "different");
    await c.run();
    expect(c.status().items[0]?.status).toBe("blocked");
    expect(c.status().items[0]?.conflicts).toEqual(["hello.txt"]);
    expect(projects[0]?.root).toBe(source);
    expect(changed).not.toHaveBeenCalled();
    await fs.writeFile(path.join(target, "hello.txt"), "hello");
    await c.run();
    expect(c.status().items[0]?.status).toBe("complete");
  });
  it("does not recopy the old directory after completion, including after restart", async () => {
    const c = coordinator();
    await c.run();
    await fs.writeFile(path.join(source, "later.txt"), "Synara later edit");
    const reloaded = coordinator();
    await reloaded.run();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reloaded.status().items[0]?.status).toBe("complete");
    await expect(fs.stat(path.join(projects[0]!.root, "later.txt"))).rejects.toThrow();
  });
  it("resumes a copied project after event commit failure", async () => {
    let fail = true;
    const c = new WorkspaceMigrationCoordinator(
      path.join(home, "state"),
      {
        projects: async () => projects,
        checkIdle: async () => {},
        backup: async () => "backup.sqlite",
        relocate: async (project, target) => {
          if (fail) throw new Error("transaction failed");
          projects[0] = { ...project, root: target };
        },
      },
      home,
    );
    await c.run();
    expect(projects[0]?.root).toBe(source);
    expect(c.status().items[0]?.status).toBe("blocked");
    fail = false;
    await c.run();
    expect(c.status().items[0]?.status).toBe("complete");
  });
  it("recovers commit-before-journal crashes by inspecting the current project root", async () => {
    const c = coordinator();
    await c.run();
    const json = JSON.parse(await fs.readFile(c.file, "utf8"));
    json.items[0].status = "verified";
    await fs.writeFile(c.file, JSON.stringify(json));
    const reloaded = coordinator();
    await reloaded.run();
    expect(reloaded.status().items[0]?.status).toBe("complete");
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("retains ambiguous Home containers, active sessions and nested project ownership", async () => {
    projects.push({
      id: "home",
      kind: "chat",
      title: "Home",
      root: path.join(home, "Documents/Synara"),
    });
    blocked = true;
    const c = coordinator();
    await c.run();
    expect(c.status().items.every((i) => i.status === "blocked")).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    blocked = false;
    projects.push({
      id: "nested",
      kind: "project",
      title: "nested",
      root: path.join(source, "nested"),
    });
    await c.run();
    expect(c.status().items.find((i) => i.projectId === "chat1")?.error).toContain(
      "another project",
    );
  });
  it("keeps relative internal symlinks without following external ones or linked worktrees", async () => {
    await fs.symlink("hello.txt", path.join(source, "alias"));
    const c = coordinator();
    await c.run();
    expect(await fs.readlink(path.join(projects[0]!.root, "alias"))).toBe("hello.txt");
    projects = [
      {
        id: "external",
        kind: "chat",
        title: "external",
        root: path.join(home, "Documents/Synara/external"),
      },
    ];
    await fs.mkdir(projects[0]!.root);
    await fs.symlink(home, path.join(projects[0]!.root, "escape"));
    await c.run();
    expect(c.status().items.find((i) => i.projectId === "external")?.status).toBe("blocked");
    await fs.unlink(path.join(projects[0]!.root, "escape"));
    await fs.writeFile(
      path.join(projects[0]!.root, ".git"),
      "gitdir: /outside/.git/worktrees/test",
    );
    await c.run();
    expect(c.status().items.find((i) => i.projectId === "external")?.error).toContain("worktree");
  });
  it("detects source changes during copy and never authorizes a cutover", async () => {
    const item: WorkspaceMigrationItem = {
      projectId: "one",
      kind: "chat",
      source,
      target: path.join(home, "target"),
      status: "pending",
      files: {},
      conflicts: [],
      updatedAt: "now",
    };
    let edited = false;
    await expect(
      copyWorkspace(item, async () => {
        if (!edited && Object.keys(item.files).length) {
          edited = true;
          await fs.writeFile(path.join(source, "hello.txt"), "changed");
        }
      }),
    ).rejects.toThrow(/changed|verification/);
    expect(item.status).not.toBe("verified");
    expect(await fs.readFile(path.join(source, "hello.txt"), "utf8")).toBe("changed");
  });
  it("reports disk failures without switching and does not trust a forged journal target", async () => {
    const c = coordinator();
    await fs.mkdir(path.dirname(c.file), { recursive: true });
    await fs.writeFile(
      c.file,
      JSON.stringify({
        version: 1,
        backupPath: null,
        items: [
          {
            projectId: "chat1",
            kind: "chat",
            source,
            target: path.join(home, "forged"),
            status: "verified",
            files: {},
            conflicts: [],
            updatedAt: "now",
          },
        ],
      }),
    );
    const spy = vi
      .mocked(fs.copyFile)
      .mockRejectedValueOnce(Object.assign(new Error("No space left"), { code: "ENOSPC" }));
    await c.run();
    spy.mockClear();
    expect(c.status().items[0]?.status).toBe("blocked");
    expect(projects[0]?.root).toBe(source);
    expect(c.status().items[0]?.target).not.toContain("forged");
  });
});
