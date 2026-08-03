import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { addToAllowlist } from "../db/allowlist.js";
import { upsertBroadcaster } from "../db/broadcasters.js";
import { issueProducerCredential } from "../db/producer-credentials.js";
import { authenticateProducerUpgrade, extractProducerCredential, isProducerUpgradePath } from "./producer-auth.js";

describe("isProducerUpgradePath", () => {
  it("recognizes the /ws/producer path regardless of query string", () => {
    expect(isProducerUpgradePath("/ws/producer")).toBe(true);
    expect(isProducerUpgradePath("/ws/producer?credential=abc")).toBe(true);
  });

  it("rejects any other path", () => {
    expect(isProducerUpgradePath("/")).toBe(false);
    expect(isProducerUpgradePath("/ws/viewer")).toBe(false);
    expect(isProducerUpgradePath("/ws/producerish")).toBe(false);
  });
});

describe("extractProducerCredential", () => {
  it("reads the credential query param", () => {
    expect(extractProducerCredential("/ws/producer?credential=abc123")).toBe("abc123");
  });

  it("returns undefined when absent", () => {
    expect(extractProducerCredential("/ws/producer")).toBeUndefined();
  });
});

describe("authenticateProducerUpgrade", () => {
  let db: DbClient;
  let broadcasterId: number;

  beforeEach(async () => {
    db = createDbClient(":memory:");
    await runMigrations(db, [
      {
        version: 1,
        name: "init",
        sql: `
          CREATE TABLE broadcasters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            twitch_user_id TEXT NOT NULL UNIQUE,
            twitch_login TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE twitch_allowlist (
            twitch_user_id TEXT PRIMARY KEY,
            added_at TEXT NOT NULL,
            note TEXT
          );
        `,
      },
      {
        version: 2,
        name: "producer_credentials",
        sql: `
          CREATE TABLE producer_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broadcaster_id INTEGER NOT NULL REFERENCES broadcasters(id),
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            revoked_at TEXT
          );
        `,
      },
    ]);
    await addToAllowlist(db, "141981764");
    const broadcaster = await upsertBroadcaster(db, "141981764", "juicykaraage");
    broadcasterId = broadcaster.id;
  });

  afterEach(() => {
    db.close();
  });

  it("authenticates a valid credential and resolves the broadcaster's channel id", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const result = await authenticateProducerUpgrade({ url: `/ws/producer?credential=${token}` } as never, db);
    expect(result).toEqual({ authenticated: true, broadcasterId, twitchUserId: "141981764" });
  });

  it("rejects a missing credential", async () => {
    const result = await authenticateProducerUpgrade({ url: "/ws/producer" } as never, db);
    expect(result).toEqual({ authenticated: false, reason: "missing credential" });
  });

  it("rejects an unknown credential", async () => {
    const result = await authenticateProducerUpgrade({ url: "/ws/producer?credential=not-a-real-token" } as never, db);
    expect(result.authenticated).toBe(false);
  });
});
