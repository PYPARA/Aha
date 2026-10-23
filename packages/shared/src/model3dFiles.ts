// Node-only helpers shared by the model service and its desktop execution host.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export async function modelPath(root: string, ...parts: string[]): Promise<string> {
  if (parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === ".."))
    throw new Error("Invalid model asset path.");
  const resolved = path.resolve(root);
  // Check existing ancestors too; writing a configured root must never follow a symlink.
  let current = path.parse(resolved).root;
  for (const component of [...resolved.slice(current.length).split(path.sep), ...parts]) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Symbolic links are not supported in model projects.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}
export async function atomicModelFile(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export const modelErrorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
