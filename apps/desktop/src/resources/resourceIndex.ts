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
  revision = 0;
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
  private conditions(query: ResourceQuery, filtered = true) {
    const predicates: string[] = [];
    const values: (string | number)[] = [];
    if (query.kind) {
      predicates.push("kind = ?");
      values.push(query.kind);
    }
    if (query.recursive) {
      if (query.path) {
        predicates.push("instr(path, ?) = 1");
        values.push(query.path + "/");
      }
    } else {
      predicates.push("parent = ?");
      values.push(query.path);
    }
    if (filtered && query.query) {
      predicates.push(
        query.searchIn === "nameAndPath"
          ? "(instr(lower(name), lower(?)) > 0 OR instr(lower(path), lower(?)) > 0)"
          : "instr(lower(name), lower(?)) > 0",
      );
      values.push(query.query);
      if (query.searchIn === "nameAndPath") values.push(query.query);
    }
    if (filtered && query.tag) {
      predicates.push(
        "EXISTS (SELECT 1 FROM json_each(resource_entries.tags) WHERE instr(lower(value), lower(?)) > 0)",
      );
      values.push(query.tag);
    }
    if (filtered && query.originKind) {
      predicates.push("json_extract(data, '$.origin.kind') = ?");
      values.push(query.originKind);
    }
    if (filtered && query.type && query.type !== "all") {
      predicates.push("kind = 'file' AND category = ?");
      values.push(query.type);
    }
    return { where: predicates.length ? " WHERE " + predicates.join(" AND ") : "", values };
  }
  private ordering(sort: ResourceQuery["sort"]) {
    return (
      "kind ASC, " +
      (sort === "modified" ? "modified DESC, name COLLATE NOCASE" : "name COLLATE NOCASE") +
      ", id"
    );
  }
  list(query: ResourceQuery): ResourcePage {
    const { where, values } = this.conditions(query);
    const scope = this.conditions(query, false);
    const totals = this.database
      .prepare(
        "SELECT count(*) AS total, sum(kind = 'file') AS files, sum(kind = 'directory') AS directories FROM resource_entries" +
          where,
      )
      .get(...values)!;
    const scopeFiles = this.database
      .prepare(
        "SELECT count(*) AS n FROM resource_entries" +
          scope.where +
          (scope.where ? " AND " : " WHERE ") +
          "kind = 'file'",
      )
      .get(...scope.values)?.n;
    const rows = this.database
      .prepare(
        "SELECT data FROM resource_entries" +
          where +
          " ORDER BY " +
          this.ordering(query.sort) +
          " LIMIT 100 OFFSET ?",
      )
      .all(...values, query.offset ?? 0);
    return {
      entries: rows.map((row) => JSON.parse(String(row.data)) as ResourceEntry),
      total: Number(totals.total),
      revision: this.revision,
      stats: {
        scopeFiles: Number(scopeFiles ?? 0),
        matchedFiles: Number(totals.files ?? 0),
        matchedDirectories: Number(totals.directories ?? 0),
      },
    };
  }
  locate(entry: ResourceEntry, sort: ResourceQuery["sort"]) {
    const parent = entry.path.split("/").slice(0, -1).join("/");
    const row = this.database
      .prepare(
        "SELECT position FROM (SELECT id, row_number() OVER (ORDER BY " +
          this.ordering(sort) +
          ") - 1 AS position FROM resource_entries WHERE parent = ?) WHERE id = ?",
      )
      .get(parent, entry.id);
    if (!row) throw new Error("Resource no longer exists. Refresh the library.");
    return Math.floor(Number(row.position) / 100) * 100;
  }
  close() {
    this.database.close();
  }
}
