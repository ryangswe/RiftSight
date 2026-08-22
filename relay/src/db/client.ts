// Thin wrapper around @libsql/client so the rest of the relay imports one
// small surface (createDbClient) rather than depending on the library's
// exact API everywhere. The same client type works against a local file, a
// ":memory:" database (tests), or a remote libsql/Turso URL later — none of
// the code above this module needs to change for that swap.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

export type DbClient = Client;

/**
 * libsql's local-file driver fails to open a "file:" URL whose parent
 * directory doesn't exist yet (SQLite error 14, SQLITE_CANTOPEN) rather
 * than creating it — surfaces as ConnectionFailed on a fresh checkout,
 * since relay/data/ (env.ts's default RIFTSIGHT_DB_PATH target) isn't
 * committed to the repo. Every earlier live-verification of this module
 * happened to run against a directory that already existed (a manually
 * pre-created /tmp path, or ":memory:"), which is why this went unnoticed
 * until a real first run. No-op for ":memory:" or a remote libsql://https://
 * URL — there's no local directory to create for either.
 */
function ensureLocalFileDirectoryExists(url: string): void {
  if (!url.startsWith("file:")) return;
  const filePath = url.slice("file:".length);
  if (filePath === ":memory:") return;
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
}

/**
 * `authToken` is only meaningful for a remote libsql/Turso URL; it's
 * accepted (and ignored by the driver) for local "file:"/":memory:" URLs so
 * every caller can pass the env config through unconditionally.
 */
export function createDbClient(url: string, authToken?: string): DbClient {
  ensureLocalFileDirectoryExists(url);
  return authToken ? createClient({ url, authToken }) : createClient({ url });
}
