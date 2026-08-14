import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  clearYouTubeChannel,
  findBroadcasterByYouTubeChannel,
  getBroadcasterById,
  getBroadcasterByTwitchUserId,
  setYouTubeChannel,
  upsertBroadcaster,
} from "./broadcasters.js";

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
    {
      // Mirrors migrations/0004_youtube_channels.sql — this file's schema
      // is a synthetic inline copy (see the version-1 entry above), so the
      // youtube column addition is mirrored the same way.
      version: 2,
      name: "youtube_channels",
      sql: `ALTER TABLE broadcasters ADD COLUMN youtube_channel_id TEXT;
        CREATE UNIQUE INDEX idx_broadcasters_youtube_channel
          ON broadcasters(youtube_channel_id)
          WHERE youtube_channel_id IS NOT NULL;`,
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

describe("setYouTubeChannel / findBroadcasterByYouTubeChannel", () => {
  const CHANNEL_A = "UC" + "a".repeat(22);
  const CHANNEL_B = "UC" + "b".repeat(22);

  it("claims a channel and resolves it back to the broadcaster", async () => {
    const broadcaster = await upsertBroadcaster(db, "12345", "juicykaraage");
    expect(await setYouTubeChannel(db, broadcaster.id, CHANNEL_A)).toBe("ok");
    const found = await findBroadcasterByYouTubeChannel(db, CHANNEL_A);
    expect(found?.id).toBe(broadcaster.id);
    expect(found?.twitchUserId).toBe("12345");
    expect(found?.youtubeChannelId).toBe(CHANNEL_A);
  });

  it("re-claiming your own channel is ok, and replacing it moves the claim", async () => {
    const broadcaster = await upsertBroadcaster(db, "12345", "juicykaraage");
    expect(await setYouTubeChannel(db, broadcaster.id, CHANNEL_A)).toBe("ok");
    expect(await setYouTubeChannel(db, broadcaster.id, CHANNEL_A)).toBe("ok");
    expect(await setYouTubeChannel(db, broadcaster.id, CHANNEL_B)).toBe("ok");
    expect(await findBroadcasterByYouTubeChannel(db, CHANNEL_A)).toBeNull();
    expect((await findBroadcasterByYouTubeChannel(db, CHANNEL_B))?.id).toBe(broadcaster.id);
  });

  it("conflicts when a different broadcaster already claimed the channel", async () => {
    const first = await upsertBroadcaster(db, "111", "first");
    const second = await upsertBroadcaster(db, "222", "second");
    expect(await setYouTubeChannel(db, first.id, CHANNEL_A)).toBe("ok");
    expect(await setYouTubeChannel(db, second.id, CHANNEL_A)).toBe("conflict");
    expect((await findBroadcasterByYouTubeChannel(db, CHANNEL_A))?.id).toBe(first.id);
  });

  it("clearYouTubeChannel releases the claim so another broadcaster can take it", async () => {
    const first = await upsertBroadcaster(db, "111", "first");
    const second = await upsertBroadcaster(db, "222", "second");
    await setYouTubeChannel(db, first.id, CHANNEL_A);
    await clearYouTubeChannel(db, first.id);
    expect(await findBroadcasterByYouTubeChannel(db, CHANNEL_A)).toBeNull();
    expect((await getBroadcasterById(db, first.id))?.youtubeChannelId).toBeNull();
    expect(await setYouTubeChannel(db, second.id, CHANNEL_A)).toBe("ok");
  });

  it("two broadcasters with NULL channels coexist (partial unique index)", async () => {
    await upsertBroadcaster(db, "111", "first");
    await upsertBroadcaster(db, "222", "second");
    expect(await findBroadcasterByYouTubeChannel(db, CHANNEL_A)).toBeNull();
  });
});
