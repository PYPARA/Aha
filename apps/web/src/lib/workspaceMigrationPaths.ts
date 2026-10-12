import { useSyncExternalStore } from "react";
import type { WorkspacePathMapping } from "@synara/contracts/workspaceMigration";
let mappings: readonly WorkspacePathMapping[] = [];
let revision = 0;
const listeners = new Set<() => void>();
export function setWorkspaceMigrationMappings(value: readonly WorkspacePathMapping[]) {
  if (JSON.stringify(mappings) === JSON.stringify(value)) return;
  mappings = value;
  revision++;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function useWorkspaceMigrationPaths() {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
}
const normalized = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/u, "");
const inside = (file: string, root: string) => file === root || file.startsWith(root + "/");
/** Mapping is usable only in the owning project's migrated workspace. Never remap global links. */
export function migratedWorkspacePath(file: string, cwd: string | null | undefined): string {
  if (!cwd) return file;
  const input = normalized(file),
    workspace = normalized(cwd);
  if (input.split("/").includes("..") || workspace.split("/").includes("..")) return file;
  for (const mapping of mappings) {
    const source = normalized(mapping.source),
      target = normalized(mapping.target);
    if (inside(workspace, target) && inside(input, source))
      return target + input.slice(source.length);
  }
  return file;
}
