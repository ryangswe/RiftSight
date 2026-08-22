// Row-level copy of the relay's persistent data from one database to
// another — the tool behind the SQLite-volume -> Turso cutover
// (docs/scaling-plan.md Stage 0) and reusable for seeding a staging
// database from a production backup. Both ends are ordinary DbClients, so
// the same code copies file -> libsql, file -> file, or :memory: -> file
// (which is how it's tested).
//
// Deliberately strict rather than clever:
// - The target must ALREADY be migrated (run `npm run migrate` against it
//   first). This copies rows, never schema, and refuses to run if the
//   target's schema_migrations doesn't cover everything the source has —
//   so a target that's behind (or ahead, with a table this code doesn't
//   know about) fails loudly instead of half-copying.
// - The table list is explicit and ordered parents-before-children, and the
//   source must contain exactly those tables: a new migration that adds a
//   table makes this refuse to run until TABLE_COPY_ORDER is updated, which
//   is the point — silently skipping a table would be the worst outcome.
// - Ids are copied verbatim (INSERT with explicit id), never reassigned:
//   broadcasters.id is the relay's session key and the FK target for
//   producer credentials, so a renumbered copy would orphan every streamer.
// - A non-empty target is refused unless `force` is set, which truncates
//   the listed tables (children first) before copying — the "re-copy right
//   before the cutover to pick up rows written since the first pass" move.

import type { DbClient } from "./client.js";

/** Parents before children — producer_credentials references broadcasters. schema_migrations is never copied (see header). */
export const TABLE_COPY_ORDER: readonly string[] = ["broadcasters", "twitch_allowlist", "producer_credentials"];

const BOOKKEEPING_TABLES: readonly string[] = ["schema_migrations"];

/** Rows per INSERT batch — small enough that a single batch stays well under any remote request-size limit, large enough that a few hundred rows is a handful of round trips. */
const BATCH_SIZE = 200;

export interface CopySummary {
  tables: Array<{ table: string; sourceRows: number; targetRows: number }>;
  truncated: boolean;
}

export class CopyRefusedError extends Error {}

async function listUserTables(db: DbClient): Promise<string[]> {
  const result = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return result.rows.map((row) => String(row[0]));
}

async function countRows(db: DbClient, table: string): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) FROM ${table}`);
  return Number(result.rows[0]?.[0] ?? 0);
}

async function appliedVersions(db: DbClient): Promise<Set<number>> {
  const result = await db.execute("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => Number(row[0])));
}

function setDifference(a: Iterable<string | number>, b: Set<string | number>): Array<string | number> {
  return [...a].filter((item) => !b.has(item));
}

export async function copyDatabase(source: DbClient, target: DbClient, options: { force?: boolean } = {}): Promise<CopySummary> {
  const expected = new Set<string>([...TABLE_COPY_ORDER, ...BOOKKEEPING_TABLES]);

  const sourceTables = await listUserTables(source);
  const unknown = sourceTables.filter((t) => !expected.has(t));
  const missingFromSource = setDifference(expected, new Set(sourceTables));
  if (unknown.length > 0) {
    throw new CopyRefusedError(
      `source has table(s) this tool doesn't know about: ${unknown.join(", ")} — add them to TABLE_COPY_ORDER (parents before children) before copying`
    );
  }
  if (missingFromSource.length > 0) {
    throw new CopyRefusedError(`source is missing expected table(s): ${missingFromSource.join(", ")} — is SRC really a migrated relay database?`);
  }

  const targetTables = new Set(await listUserTables(target));
  const missingFromTarget = setDifference(expected, targetTables);
  if (missingFromTarget.length > 0) {
    throw new CopyRefusedError(
      `target is missing table(s): ${missingFromTarget.join(", ")} — run \`npm run migrate -w relay\` against DST first (this tool copies rows, never schema)`
    );
  }

  const sourceVersions = await appliedVersions(source);
  const targetVersions = await appliedVersions(target);
  const behind = setDifference(sourceVersions, targetVersions);
  if (behind.length > 0) {
    throw new CopyRefusedError(`target schema is behind the source — missing migration version(s) ${behind.join(", ")}; migrate DST first`);
  }

  let truncated = false;
  const preexisting: string[] = [];
  for (const table of TABLE_COPY_ORDER) {
    if ((await countRows(target, table)) > 0) preexisting.push(table);
  }
  if (preexisting.length > 0) {
    if (!options.force) {
      throw new CopyRefusedError(`target already has rows in ${preexisting.join(", ")} — pass --force to truncate those tables and re-copy`);
    }
    // Children first so no FK is ever left dangling mid-truncate.
    for (const table of [...TABLE_COPY_ORDER].reverse()) {
      await target.execute(`DELETE FROM ${table}`);
    }
    truncated = true;
  }

  const summary: CopySummary = { tables: [], truncated };
  for (const table of TABLE_COPY_ORDER) {
    const rows = await source.execute(`SELECT * FROM ${table}`);
    const columns = rows.columns;
    if (columns.length === 0) throw new Error(`could not read columns of ${table}`);
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
    for (let offset = 0; offset < rows.rows.length; offset += BATCH_SIZE) {
      const batch = rows.rows.slice(offset, offset + BATCH_SIZE).map((row) => ({
        sql,
        args: columns.map((_, index) => row[index] ?? null),
      }));
      await target.batch(batch, "write");
    }
    const targetRows = await countRows(target, table);
    summary.tables.push({ table, sourceRows: rows.rows.length, targetRows });
    if (targetRows !== rows.rows.length) {
      throw new Error(`row count mismatch after copying ${table}: source ${rows.rows.length}, target ${targetRows}`);
    }
  }
  return summary;
}
