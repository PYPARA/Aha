import type { ResourceEntry, ResourceQuery } from "@synara/contracts/resourceLibrary";
export const RESOURCE_ROOT_ID = "$root";
export interface ResourceLocation {
  mode: "all" | "recent" | "directory";
  path: string;
  directoryId?: string | null;
  recursive: boolean;
}
export interface ResourcePreferences {
  version: 2;
  location: ResourceLocation;
  view: "grid" | "list";
  sort: "name" | "modified";
  expandedIds: string[];
  sidebarRem: number;
}
export const initialResourcePreferences = (): ResourcePreferences => ({
  version: 2,
  location: { mode: "all", path: "", recursive: false },
  view: "grid",
  sort: "modified",
  expandedIds: [RESOURCE_ROOT_ID],
  sidebarRem: 15,
});
export const directoryLocation = (
  path: string,
  directories: readonly ResourceEntry[],
): ResourceLocation => ({
  mode: "directory",
  path,
  directoryId: directories.find((d) => d.path === path)?.id ?? null,
  recursive: false,
});
export function readResourcePreferences(
  libraryId: string,
  directories: readonly ResourceEntry[] = [],
): ResourcePreferences {
  const defaults = initialResourcePreferences();
  try {
    const value = JSON.parse(localStorage.getItem(`aha:resources:${libraryId}`) ?? "null");
    if (
      ![1, 2].includes(value?.version) ||
      !["all", "recent", "project", "directory"].includes(value.location?.mode) ||
      typeof value.location.path !== "string"
    )
      return defaults;
    const old = value.location;
    const location: ResourceLocation =
      old.mode === "project"
        ? { ...directoryLocation(old.path, directories), recursive: true }
        : {
            ...old,
            ...(old.mode === "directory"
              ? {
                  directoryId:
                    old.directoryId ?? directories.find((d) => d.path === old.path)?.id ?? null,
                }
              : {}),
            recursive: !!old.recursive,
          };
    return {
      ...defaults,
      location,
      view: value.view === "list" ? "list" : "grid",
      sort: value.sort === "name" ? "name" : "modified",
      expandedIds: Array.isArray(value.expandedIds)
        ? value.expandedIds.filter((id: unknown) => typeof id === "string")
        : [RESOURCE_ROOT_ID],
      sidebarRem:
        typeof value.sidebarRem === "number" ? Math.max(12, Math.min(20, value.sidebarRem)) : 15,
    };
  } catch {
    return defaults;
  }
}
export function resolveResourceLocation(
  location: ResourceLocation,
  directories: readonly ResourceEntry[],
): ResourceLocation {
  if (location.mode !== "directory") return { ...location, path: "" };
  const identity = location.directoryId
    ? directories.find((d) => d.id === location.directoryId)
    : directories.find((d) => d.path === location.path);
  if (identity) return { ...location, path: identity.path, directoryId: identity.id };
  if (!location.path) return { ...location, directoryId: null };
  let path = location.path.split("/").slice(0, -1).join("/");
  while (path && !directories.some((d) => d.path === path))
    path = path.split("/").slice(0, -1).join("/");
  return directoryLocation(path, directories);
}
export function resourceQuery(
  location: ResourceLocation,
  query: string,
  tag: string,
  type: ResourceQuery["type"],
  sort: ResourceQuery["sort"],
  offset: number,
): ResourceQuery {
  const recursive = location.mode !== "directory" || location.recursive;
  return {
    path: location.path,
    recursive,
    ...(recursive ? { kind: "file" as const } : {}),
    query,
    searchIn: "nameAndPath",
    tag,
    type,
    sort: location.mode === "recent" ? "modified" : sort,
    offset,
  };
}
export function expandedResourceAncestors(
  path: string,
  directories: readonly ResourceEntry[],
): string[] {
  const ids = [RESOURCE_ROOT_ID];
  let parent = path.split("/").slice(0, -1).join("/");
  while (parent) {
    const d = directories.find((d) => d.path === parent);
    if (d) ids.push(d.id);
    parent = parent.split("/").slice(0, -1).join("/");
  }
  return ids;
}
