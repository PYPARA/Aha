import { SpriteId, SpriteProjectDataSchema } from "@synara/contracts/spriteLibrarySchema";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  type SpriteProjectData,
  type SpriteLibrarySnapshot,
  type SpriteLibraryImage,
} from "@synara/contracts/spriteLibrary";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export class SpriteLibrary {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async safe(relative: string, create = false): Promise<string> {
    if (create) await fs.mkdir(this.root, { recursive: true });
    const root = await fs.realpath(this.root);
    if ((await fs.lstat(this.root)).isSymbolicLink())
      throw new Error("Sprite directory cannot be a symbolic link.");
    const parts = relative.split("/").filter(Boolean);
    let current = root;
    for (const part of parts) {
      if (part === "." || part === ".." || part.includes("\\"))
        throw new Error("Invalid sprite path.");
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error("Sprite paths cannot be symbolic links.");
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
    return current;
  }
  private marker(id: string) {
    return `.deletions/${SpriteId.parse(id)}.json`;
  }
  private async deleting(id: string) {
    try {
      await fs.access(await this.safe(this.marker(id)));
      return true;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  }
  private async atomic(relative: string, data: string | Uint8Array) {
    const target = await this.safe(relative, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, { flag: "wx" });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async list(): Promise<SpriteLibrarySnapshot> {
    await this.safe("", true);
    const projects: SpriteLibrarySnapshot["projects"] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SpriteId.safeParse(entry.name).success) continue;
      const id = entry.name;
      try {
        const p = await this.get(id, true);
        projects.push({
          id,
          name: p.name,
          updatedAt: p.updatedAt,
          actionCount: p.actions.length,
          deleting: await this.deleting(id),
        });
      } catch (e) {
        projects.push({
          id,
          name: id,
          updatedAt: "",
          actionCount: 0,
          deleting: await this.deleting(id),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // A interrupted deletion remains reachable even if its directory has already gone.
    const markers = await fs.readdir(await this.safe(".deletions")).catch((e) => {
      if (missing(e)) return [];
      throw e;
    });
    for (const marker of markers) {
      const id = marker.replace(/\.json$/, "");
      if (
        marker.endsWith(".json") &&
        SpriteId.safeParse(id).success &&
        !JSON.parse(await fs.readFile(await this.safe(this.marker(id)), "utf8")).done &&
        !projects.some((p) => p.id === id)
      )
        projects.push({ id, name: id, updatedAt: "", actionCount: 0, deleting: true });
    }
    return {
      root: this.root,
      projects: projects.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }
  async get(id: string, allowDeleting = false): Promise<SpriteProjectData> {
    SpriteId.parse(id);
    if (!allowDeleting && (await this.deleting(id)))
      throw new Error("This sprite project is being deleted.");
    const p = SpriteProjectDataSchema.parse(
      JSON.parse(await fs.readFile(await this.safe(`${id}/project.json`), "utf8")),
    );
    if (p.id !== id) throw new Error("Sprite project ID does not match its folder.");
    return p;
  }
  async readImage(id: string, file: string): Promise<Uint8Array> {
    SpriteId.parse(id);
    if (file !== "thumbnail.png") {
      const p = await this.get(id);
      if (!p.sources.some((s) => s.file === file)) throw new Error("Unknown sprite image.");
    }
    const bytes = await fs.readFile(await this.safe(`${id}/${file}`));
    if (
      file !== "thumbnail.png" &&
      file.split("/")[1]?.split(".")[0] !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Sprite image hash mismatch.");
    return new Uint8Array(bytes);
  }
  async save(raw: SpriteProjectData, images: SpriteLibraryImage[], thumbnail: Uint8Array | null) {
    const p = SpriteProjectDataSchema.parse(raw);
    await this.safe("", true);
    if (await this.deleting(p.id)) throw new Error("This sprite project is being deleted.");
    // Never replace an unreadable project with a new blank document.
    try {
      const previous = await this.get(p.id);
      if (
        p.sources.some((s) => s.usage === "generated-frame") &&
        !previous.sources.some((s) => s.usage === "generated-frame")
      ) {
        const backup = `${p.id}/project.pre-frame-roles.json`;
        try {
          await fs.access(await this.safe(backup));
        } catch (e) {
          if (!missing(e)) throw e;
          await this.atomic(backup, JSON.stringify(previous, null, 2));
        }
      }
    } catch (e) {
      if (!missing(e)) throw e;
    }
    const supplied = new Map(images.map((i) => [i.file, i.bytes]));
    let total = 0;
    for (const source of p.sources) {
      const bytes = supplied.get(source.file) ?? (await this.readExisting(p.id, source.file));
      total += bytes.byteLength;
      if (bytes.byteLength > 20 * 1024 * 1024 || total > 80 * 1024 * 1024)
        throw new Error("Project images exceed 80 MiB.");
      if (
        source.file.split("/")[1]?.split(".")[0] !==
        createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error("Sprite image hash mismatch.");
      const metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata();
      const format = source.mimeType === "image/jpeg" ? "jpeg" : source.mimeType.split("/")[1];
      if (
        metadata.width !== source.width ||
        metadata.height !== source.height ||
        metadata.format !== format ||
        (metadata.pages ?? 1) > 1
      )
        throw new Error("Invalid sprite source image.");
      const existing = await this.readExisting(p.id, source.file).catch((e) => {
        if (missing(e)) return null;
        throw e;
      });
      if (!existing || !existing.equals(Buffer.from(bytes)))
        await this.atomic(`${p.id}/${source.file}`, bytes);
    }
    if (thumbnail) {
      const thumb = await sharp(thumbnail, { limitInputPixels: 1_048_576 })
        .resize(128, 128, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      await this.atomic(`${p.id}/thumbnail.png`, thumb);
    } else await fs.rm(await this.safe(`${p.id}/thumbnail.png`), { force: true });
    await this.atomic(`${p.id}/project.json`, JSON.stringify(p, null, 2));
    const liveFiles = new Set(p.sources.map((s) => s.file));
    try {
      const backup = SpriteProjectDataSchema.parse(
        JSON.parse(
          await fs.readFile(await this.safe(`${p.id}/project.pre-frame-roles.json`), "utf8"),
        ),
      );
      for (const source of backup.sources) liveFiles.add(source.file);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    const imageRoot = await this.safe(`${p.id}/images`);
    for (const file of await fs.readdir(imageRoot).catch((e) => {
      if (missing(e)) return [];
      throw e;
    }))
      if (/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(file) && !liveFiles.has(`images/${file}`))
        await fs.rm(await this.safe(`${p.id}/images/${file}`), { force: true });
  }
  private async readExisting(id: string, file: string) {
    return fs.readFile(await this.safe(`${id}/${file}`));
  }
  async rename(id: string, name: string) {
    const p = await this.get(id);
    const next = SpriteProjectDataSchema.parse({ ...p, name, updatedAt: new Date().toISOString() });
    await this.atomic(`${id}/project.json`, JSON.stringify(next, null, 2));
  }
  async beginDelete(id: string) {
    SpriteId.parse(id);
    if (!(await this.deleting(id)))
      await this.atomic(this.marker(id), JSON.stringify({ id, done: false }));
  }
  async finishDelete(id: string) {
    if (!(await this.deleting(id))) throw new Error("Begin sprite deletion first.");
    await fs.rm(await this.safe(SpriteId.parse(id)), { recursive: true, force: true });
    // Keep a tombstone so old autosave requests cannot resurrect the project.
    await this.atomic(this.marker(id), JSON.stringify({ id, done: true }));
  }
}
