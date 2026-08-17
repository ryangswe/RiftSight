// The migration-survival test: seeds a database with REAL legacy-shaped
// data (pre-0005 broadcasters rows with twitch columns and a claimed
// youtube channel, an allowlist entry, a live producer credential), then
// applies 0005 and proves an existing Twitch broadcaster keeps working
// with no re-registration: same broadcaster id, credential still
// validates, both platform channels still resolve, allowlist revocation
// still bites.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations, type Migration } from "./migrate.js";
import { validateProducerCredential, issueProducerCredential } from "./producer-credentials.js";
import { findIdentity, listIdentitiesForBroadcaster } from "./identities.js";
import { removeFromAllowlist } from "./allowlist.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const FILES = [
  "0001_init.sql",
  "0002_producer_credentials.sql",
  "0003_producer_credential_lifecycle.sql",
  "0004_youtube_channels.sql",
  "0005_platform_identities.sql",
];

async function loadFile(file: string, version: number): Promise<Migration> {
  return { version, name: file, sql: await readFile(path.join(migrationsDir, file), "utf8") };
}

const CHANNEL = "UC" + "a".repeat(22);

let db: DbClient;

beforeEach(() => {
  db = createDbClient(":memory:");
});

afterEach(() => {
  db.close();
});

describe("migration 0005 against legacy data", () => {
  it("preserves an existing Twitch broadcaster end to end: id, credential, both channel mappings, revocation", async () => {
    // 1. A pre-identity-refactor world: migrations 0001-0004 only.
    const legacy = await Promise.all(FILES.slice(0, 4).map((f, i) => loadFile(f, i + 1)));
    await runMigrations(db, legacy);

    // 2. Legacy-shaped rows, written the way the OLD code wrote them.
    await db.execute({
      sql: "INSERT INTO broadcasters (twitch_user_id, twitch_login, youtube_channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: ["141981764", "juicykaraage", CHANNEL, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    });
    const broadcasterId = Number(
      (await db.execute({ sql: "SELECT id FROM broadcasters WHERE twitch_user_id = ?", args: ["141981764"] })).rows[0]!["id"]
    );
    await db.execute({
      sql: "INSERT INTO twitch_allowlist (twitch_user_id, added_at) VALUES (?, ?)",
      args: ["141981764", "2026-01-01T00:00:00Z"],
    });
    const credential = await issueProducerCredential(db, broadcasterId);

    // 3. The upgrade under test.
    await runMigrations(db, [...legacy, await loadFile(FILES[4]!, 5)]);

    // 4. Identities backfilled, broadcaster id preserved.
    const twitch = await findIdentity(db, "twitch", "141981764");
    expect(twitch?.broadcasterId).toBe(broadcasterId);
    expect(twitch?.displayName).toBe("juicykaraage");
    const youtube = await findIdentity(db, "youtube", CHANNEL);
    expect(youtube?.broadcasterId).toBe(broadcasterId);
    expect(await listIdentitiesForBroadcaster(db, broadcasterId)).toHaveLength(2);

    // 5. The pre-migration credential still validates — no re-registration.
    expect(await validateProducerCredential(db, credential)).toEqual({ broadcasterId });

    // 6. Allowlist removal still revokes, post-migration.
    await removeFromAllowlist(db, "141981764");
    expect(await validateProducerCredential(db, credential)).toBeNull();
  });

  it("a legacy broadcaster with no youtube claim migrates with only a twitch identity", async () => {
    const legacy = await Promise.all(FILES.slice(0, 4).map((f, i) => loadFile(f, i + 1)));
    await runMigrations(db, legacy);
    await db.execute({
      sql: "INSERT INTO broadcasters (twitch_user_id, twitch_login, created_at, updated_at) VALUES (?, ?, ?, ?)",
      args: ["555", "twitch_only", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    });
    await runMigrations(db, [...legacy, await loadFile(FILES[4]!, 5)]);

    const identity = await findIdentity(db, "twitch", "555");
    expect(identity).not.toBeNull();
    expect(await listIdentitiesForBroadcaster(db, identity!.broadcasterId)).toHaveLength(1);
  });
});
