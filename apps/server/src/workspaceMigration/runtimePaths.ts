import { relocateProjectPath } from "../orchestration/projectRelocationPaths";
/** Preserve native session IDs and all opaque data; relocate only documented path fields. */
export function relocateRuntimePaths(
  json: string | null,
  source: string,
  target: string,
): string | null {
  if (!json) return json;
  const payload: unknown = JSON.parse(json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json;
  const result: Record<string, unknown> = { ...payload };
  for (const key of ["cwd", "workingDirectory"]) {
    const value = result[key];
    if (typeof value === "string") result[key] = relocateProjectPath(value, source, target);
  }
  if (Array.isArray(result.additionalDirectories))
    result.additionalDirectories = result.additionalDirectories.map((value) =>
      typeof value === "string" ? relocateProjectPath(value, source, target) : value,
    );
  return JSON.stringify(result);
}
