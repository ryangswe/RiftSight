// CLI for src/db/copy.ts — copies the relay's rows from one database to
// another. The Turso cutover tool (docs/scaling-plan.md Stage 0 / operator
// checklist) and the way a staging database gets seeded from a production
// backup.
//
// Usage:
//   SRC=file:./backup.db DST='libsql://riftsight-<org>.turso.io' DST_AUTH_TOKEN=... \
//     npm run copy-db -w relay [-- --force]
//
//   SRC / DST            libsql URLs (file:, libsql://, https://). Required.
//   SRC_AUTH_TOKEN       auth token for SRC when it's remote (optional).
//   DST_AUTH_TOKEN       auth token for DST when it's remote (required for Turso).
//   --force              truncate the target's relay tables and re-copy.
//
// The target must already be migrated (`npm run migrate -w relay` with
// RIFTSIGHT_DB_PATH pointed at it) — this copies rows only. Tokens come
// from the environment, never the command line, never a log line.

import { createDbClient } from "../src/db/client.js";
import { copyDatabase, CopyRefusedError } from "../src/db/copy.js";

const src = process.env["SRC"];
const dst = process.env["DST"];
const force = process.argv.includes("--force");

if (!src || !dst) {
  console.error("[copy-db] SRC and DST are required (libsql URLs). See the header of relay/scripts/copy-db.ts.");
  process.exit(2);
}
if (src === dst) {
  console.error("[copy-db] SRC and DST are the same URL — refusing.");
  process.exit(2);
}

const redact = (url: string): string => url.replace(/authToken=[^&]+/g, "authToken=<redacted>");
console.log(`[copy-db] ${redact(src)} -> ${redact(dst)}${force ? " (--force: target tables will be truncated first)" : ""}`);

const source = createDbClient(src, process.env["SRC_AUTH_TOKEN"] || undefined);
const target = createDbClient(dst, process.env["DST_AUTH_TOKEN"] || undefined);

try {
  const summary = await copyDatabase(source, target, { force });
  if (summary.truncated) console.log("[copy-db] target tables truncated before copy");
  for (const { table, sourceRows, targetRows } of summary.tables) {
    console.log(`[copy-db] ${table.padEnd(22)} source ${String(sourceRows).padStart(5)}  target ${String(targetRows).padStart(5)}`);
  }
  console.log("[copy-db] done — every table's target count matches its source");
} catch (err) {
  if (err instanceof CopyRefusedError) {
    console.error(`[copy-db] refused: ${err.message}`);
    process.exit(3);
  }
  console.error("[copy-db] failed:", err);
  process.exit(1);
} finally {
  source.close();
  target.close();
}
