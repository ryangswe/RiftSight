// Minimal hand-rolled migration runner — deliberately not a library
// (Prisma/Drizzle/Knex), matching this repo's small-dependency-footprint
// style and this milestone's "small schema initially" scope. Each pending
// migration's statements plus its schema_migrations bookkeeping row are
// applied as one atomic batch (via libsql's own multi-statement `batch`,
// not a manually-managed transaction — combining an explicit
// transaction() with executeMultiple() was found to not see its own
// writes against the local sqlite3 driver; `batch` doesn't have that
// issue), so a failing migration never gets recorded as applied.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "./client.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const MIGRATION_FILENAME_PATTERN = /^(\d+)_(.+)\.sql$/;

/** Reads every NNNN_name.sql file from db/migrations/ — shared by scripts/migrate.ts (the standalone deploy-time command) and index.ts (which also applies pending migrations at boot as a safety net; see index.ts's comment on why both exist). */
export async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = file.match(MIGRATION_FILENAME_PATTERN);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Migration filename "${file}" doesn't match the expected NNNN_name.sql pattern`);
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    migrations.push({ version: Number(match[1]), name: match[2], sql });
  }
  return migrations;
}

// Strips full-line `--` comments before splitting on `;` — migration files
// document each table with a leading comment block, and leaving those
// attached to the following statement caused a real failure against the
// file-backed libsql driver ("not an error" / SQLITE_UNKNOWN_0) that
// comment-free inline SQL in unit tests never exercised. Only handles line
// comments (not block `/* */` comments or `--` inside a string literal) —
// sufficient for this project's own simple schema files, not a general SQL
// parser.
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const index = line.indexOf("--");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

function splitStatements(sql: string): string[] {
  return stripLineComments(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export async function runMigrations(db: DbClient, migrations: Migration[]): Promise<{ applied: string[] }> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  );

  const appliedRows = await db.execute("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(appliedRows.rows.map((row) => Number(row["version"])));

  const pending = migrations.filter((m) => !appliedVersions.has(m.version)).sort((a, b) => a.version - b.version);

  const applied: string[] = [];
  for (const migration of pending) {
    await db.batch(
      [
        ...splitStatements(migration.sql),
        {
          sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          args: [migration.version, migration.name, new Date().toISOString()],
        },
      ],
      "write"
    );
    applied.push(migration.name);
  }

  return { applied };
}
