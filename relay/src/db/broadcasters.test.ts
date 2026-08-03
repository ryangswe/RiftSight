import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import { getBroadcasterByTwitchUserId, upsertBroadcaster } from "./broadcasters.js";

let db: DbClient;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, [
    {
      version: 1,
      name: "init",
      sql: `CREATE TABLE broadcasters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        twitch_user_id TEXT NOT NULL UNIQUE,
        twitch_login TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    },
  ]);
});

afterEach(() => {
  db.close();
});

describe("getBroadcasterByTwitchUserId", () => {
  it("returns null when no broadcaster is linked yet", async () => {
    expect(await getBroadcasterByTwitchUserId(db, "12345")).toBeNull();
  });
});

describe("upsertBroadcaster", () => {
  it("creates a new broadcaster row on first link", async () => {
    const broadcaster = await upsertBroadcaster(db, "12345", "juicykaraage");
    expect(broadcaster.twitchUserId).toBe("12345");
    expect(broadcaster.twitchLogin).toBe("juicykaraage");
    expect(broadcaster.createdAt).toBe(broadcaster.updatedAt);
  });

  it("is retrievable afterward by twitch user id", async () => {
    await upsertBroadcaster(db, "12345", "juicykaraage");
    const found = await getBroadcasterByTwitchUserId(db, "12345");
    expect(found?.twitchLogin).toBe("juicykaraage");
  });

  it("updates the login and updated_at on a relink, keeping the same row and created_at", async () => {
    const first = await upsertBroadcaster(db, "12345", "old_name");
    const second = await upsertBroadcaster(db, "12345", "new_name");

    expect(second.id).toBe(first.id);
    expect(second.twitchLogin).toBe("new_name");
    expect(second.createdAt).toBe(first.createdAt);

    const all = await db.execute("SELECT * FROM broadcasters");
    expect(all.rows.length).toBe(1);
  });

  it("keeps distinct broadcasters as separate rows", async () => {
    await upsertBroadcaster(db, "111", "streamer_one");
    await upsertBroadcaster(db, "222", "streamer_two");
    const all = await db.execute("SELECT * FROM broadcasters");
    expect(all.rows.length).toBe(2);
  });
});
