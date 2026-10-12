// Rebuildable local search index. Portable metadata remains in the resource folder.
import { DatabaseSync } from "node:sqlite";
import {
  resourceType,
  type ResourceEntry,
  type ResourcePage,
  type ResourceQuery,
} from "@synara/contracts/resourceLibrary";
export class ResourceIndex {
  private database: DatabaseSync;
  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec(`CREATE TABLE IF NOT EXISTS resource_entries (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, category TEXT NOT NULL, modified REAL NOT NULL,
      tags TEXT NOT NULL, data TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS resource_parent ON resource_entries(parent);
    CREATE INDEX IF NOT EXISTS resource_path ON resource_entries(path);`);
  }
  replace(entries: ResourceEntry[]) {
    this.database.exec("BEGIN");
    try {
      this.database.exec("DELETE FROM resource_entries");
      const insert = this.database.prepare(
        "INSERT INTO resource_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const e of entries)
        if (!e.deleted)
          insert.run(
            e.id,
            e.path,
            e.path.split("/").slice(0, -1).join("/"),
            e.name,
            e.kind,
            resourceType(e.name),
            e.modifiedAt,
            JSON.stringify(e.tags),
            JSON.stringify(e),
          );
      this.database.exec("COMMIT");
    } catch (e) {
      this.database.exec("ROLLBACK");
      throw e;
    }
  }
  list(query: ResourceQuery): ResourcePage {
    const predicates: string[] = [];
    const values: (string | number)[] = [];
    if (query.recursive) {
      if (query.path) {
        predicates.push("substr(path, 1, ?) = ?");
        values.push(query.path.length + 1, query.path + "/");
      }
    } else {
      predicates.push("parent = ?");
      values.push(query.path);
    }
    if (query.query) {
      predicates.push("instr(lower(name), lower(?)) > 0");
      values.push(query.query);
    }
    if (query.tag) {
      predicates.push(
        "EXISTS (SELECT 1 FROM json_each(resource_entries.tags) WHERE instr(lower(value), lower(?)) > 0)",
      );
      values.push(query.tag);
    }
    if (query.type && query.type !== "all") {
      predicates.push("kind = 'file' AND category = ?");
      values.push(query.type);
    }
    const where = predicates.length ? " WHERE " + predicates.join(" AND ") : "";
    const total = Number(
      this.database.prepare("SELECT count(*) AS n FROM resource_entries" + where).get(...values)
        ?.n ?? 0,
    );
    const order =
      query.sort === "modified" ? "modified DESC, name COLLATE NOCASE" : "name COLLATE NOCASE";
    const rows = this.database
      .prepare(
        "SELECT data FROM resource_entries" +
          where +
          " ORDER BY kind ASC, " +
          order +
          ", id LIMIT 100 OFFSET ?",
      )
      .all(...values, query.offset ?? 0);
    return { entries: rows.map((row) => JSON.parse(String(row.data)) as ResourceEntry), total };
  }
  close() {
    this.database.close();
  }
}
