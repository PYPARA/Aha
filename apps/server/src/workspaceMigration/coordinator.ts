import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  WorkspaceMigrationItem,
  WorkspaceMigrationStatus,
  WorkspacePathMapping,
} from "@synara/contracts/workspaceMigration";
import { ahaUserDirectories } from "@synara/shared/ahaUserDirectories";
import { atomicWriteJson, copyWorkspace, within } from "./copyWorkspace";
export interface MigrationProject {
  id: string;
  kind: string;
  title: string;
  root: string;
  deleted?: boolean;
}
export interface MigrationOwner {
  projects(): Promise<MigrationProject[]>;
  checkIdle(projectId: string): Promise<void>;
  backup(): Promise<string>;
  relocate(project: MigrationProject, target: string): Promise<void>;
}
const FileRecord = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number(),
  mode: z.number(),
});
const Item = z.object({
  projectId: z.string(),
  kind: z.string(),
  source: z.string(),
  target: z.string().nullable(),
  status: z.enum(["pending", "copying", "verified", "complete", "blocked"]),
  files: z.record(z.string(), FileRecord),
  error: z.string().optional(),
  conflicts: z.array(z.string()),
  updatedAt: z.string(),
});
const Manifest = z.object({
  version: z.literal(1),
  items: z.array(Item),
  backupPath: z.string().nullable(),
});
export class WorkspaceMigrationCoordinator {
  readonly file: string;
  directories: ReturnType<typeof ahaUserDirectories>;
  private items: WorkspaceMigrationItem[] = [];
  private backupPath: string | null = null;
  private error: string | null = null;
  private active: Promise<void> | null = null;
  private loaded = false;
  constructor(
    readonly stateDir: string,
    readonly owner: MigrationOwner,
    homeDir: string,
    documentsDirectory?: string,
  ) {
    this.file = path.join(stateDir, "aha-workspace-migration-v1.json");
    this.directories = ahaUserDirectories(homeDir, documentsDirectory);
  }
  status(): WorkspaceMigrationStatus {
    return {
      version: 1,
      running: this.active !== null,
      directories: this.directories,
      items: this.items,
      backupPath: this.backupPath,
      error: this.error,
    };
  }
  private async persist() {
    await atomicWriteJson(this.file, {
      version: 1,
      items: this.items,
      backupPath: this.backupPath,
    });
  }
  private destination(project: MigrationProject): string | null {
    const old = this.directories.legacyRoot;
    if (
      project.kind === "chat" &&
      project.root !== old &&
      within(project.root, old) &&
      !within(project.root, path.join(old, "Studio")) &&
      !within(project.root, path.join(old, "Groups"))
    )
      return path.join(this.directories.chats, path.relative(old, project.root));
    if (project.kind === "studio" && within(project.root, path.join(old, "Studio")))
      return path.join(
        this.directories.studio,
        path.relative(path.join(old, "Studio"), project.root),
      );
    if (project.kind === "group" && within(project.root, path.join(old, "Groups")))
      return path.join(
        this.directories.groups,
        path.relative(path.join(old, "Groups"), project.root),
      );
    return null;
  }
  async load() {
    if (this.loaded) return;
    try {
      const manifest = Manifest.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
      // A journal is data, never authority to copy arbitrary directories. Match source and target to the layout again at run time.
      this.items = manifest.items;
      this.backupPath = manifest.backupPath;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.error = `Could not read migration journal: ${String(e)}`;
        throw e;
      }
    }
    for (const key of Object.keys(this.directories) as (keyof typeof this.directories)[]) {
      let existing = this.directories[key];
      const suffix: string[] = [];
      while (true) {
        try {
          existing = await fs.realpath(existing);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const parent = path.dirname(existing);
          if (parent === existing) throw e;
          suffix.unshift(path.basename(existing));
          existing = parent;
        }
      }
      this.directories[key] = path.join(existing, ...suffix);
    }
    this.loaded = true;
  }
  run(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.perform()
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
  private async perform() {
    await this.load();
    this.error = null;
    for (const directory of [
      this.directories.chats,
      this.directories.studio,
      this.directories.groups,
    ])
      await fs.mkdir(directory, { recursive: true });
    let backedUpThisRun = false;
    const projects = await this.owner.projects();
    for (const project of projects.filter((p) => !p.deleted)) {
      let item = this.items.find((i) => i.projectId === project.id);
      if (item?.status === "complete") continue;
      const target = this.destination(project);
      if (
        item &&
        project.root === item.target &&
        this.destination({ ...project, root: item.source }) === item.target
      ) {
        item.status = "complete";
        item.error = undefined;
        await this.persist();
        continue;
      }
      if (!target) {
        // Do not relocate a legacy Home container whose root can include another app's files.
        if (
          (project.kind === "chat" || project.title === "Home") &&
          (project.root === this.directories.legacyRoot ||
            project.root === path.dirname(path.dirname(this.directories.root)))
        ) {
          if (!item) {
            item = {
              projectId: project.id,
              kind: project.kind,
              source: project.root,
              target: null,
              status: "blocked",
              files: {},
              conflicts: [],
              updatedAt: new Date().toISOString(),
            };
            this.items.push(item);
          }
          item.error =
            "Shared Home workspace cannot be attributed safely. Existing conversations keep their original directory.";
          await this.persist();
        }
        continue;
      }
      if (!item || item.source !== project.root || item.target !== target) {
        item = {
          projectId: project.id,
          kind: project.kind,
          source: project.root,
          target,
          status: "pending",
          files: {},
          conflicts: [],
          updatedAt: new Date().toISOString(),
        };
        this.items = this.items.filter((i) => i.projectId !== project.id);
        this.items.push(item);
      }
      try {
        await this.owner.checkIdle(project.id);
        // Never copy a parent that contains another project's workspace, even when that project is not managed.
        if (
          projects.some(
            (p) =>
              p.id !== project.id &&
              !p.deleted &&
              p.root !== project.root &&
              within(p.root, project.root),
          )
        )
          throw new Error(
            "Workspace contains another project's directory; ownership must be resolved before migration.",
          );
        if (projects.some((p) => p.id !== project.id && !p.deleted && p.root === target))
          throw new Error("Destination is already assigned to another project.");
        item.error = undefined;
        item.conflicts = [];
        item.updatedAt = new Date().toISOString();
        await copyWorkspace(item, () => this.persist());
        await this.owner.checkIdle(project.id);
        if (!backedUpThisRun) {
          this.backupPath = await this.owner.backup();
          backedUpThisRun = true;
          await this.persist();
        }
        // Journal contains the pending mapping before the atomic event commit, allowing recovery after a crash.
        await this.owner.relocate(project, target);
        item.status = "complete";
        item.updatedAt = new Date().toISOString();
        await this.persist();
      } catch (e) {
        item.status = "blocked";
        item.error = e instanceof Error ? e.message : String(e);
        await this.persist();
      }
    }
  }
  async mappings(): Promise<WorkspacePathMapping[]> {
    await this.load();
    const projects = await this.owner.projects();
    return this.items.flatMap((item) => {
      const project = projects.find((p) => p.id === item.projectId && !p.deleted);
      return project &&
        item.target &&
        project.root === item.target &&
        this.destination({ ...project, root: item.source }) === item.target
        ? [{ projectId: item.projectId, source: item.source, target: item.target }]
        : [];
    });
  }
}
const coordinators = new Map<string, WorkspaceMigrationCoordinator>();
export const registerWorkspaceMigration = (
  stateDir: string,
  coordinator: WorkspaceMigrationCoordinator,
) => {
  coordinators.set(stateDir, coordinator);
  return () => coordinators.delete(stateDir);
};
export const workspaceMigrationFor = (stateDir: string) => coordinators.get(stateDir);
