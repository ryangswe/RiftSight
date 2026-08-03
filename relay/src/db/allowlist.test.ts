import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import { addToAllowlist, isAllowed, listAllowlist, removeFromAllowlist } from "./allowlist.js";

let db: DbClient;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, [
    {
      version: 1,
      name: "init",
      sql: `CREATE TABLE twitch_allowlist (
        twitch_user_id TEXT PRIMARY KEY,
        added_at TEXT NOT NULL,
        note TEXT
      );`,
    },
  ]);
});

afterEach(() => {
  db.close();
});

describe("isAllowed", () => {
  it("is false for a Twitch user id that was never added", async () => {
    expect(await isAllowed(db, "12345")).toBe(false);
  });

  it("is true once added", async () => {
    await addToAllowlist(db, "12345");
    expect(await isAllowed(db, "12345")).toBe(true);
  });

  it("is false again after removal — this is how a beta streamer's access is revoked", async () => {
    await addToAllowlist(db, "12345");
    await removeFromAllowlist(db, "12345");
    expect(await isAllowed(db, "12345")).toBe(false);
  });
});

describe("addToAllowlist", () => {
  it("stores an optional note", async () => {
    await addToAllowlist(db, "12345", "approved via Discord DM 2026-07-30");
    const entries = await listAllowlist(db);
    expect(entries[0]?.note).toBe("approved via Discord DM 2026-07-30");
  });

  it("is idempotent — adding the same id twice does not error or duplicate", async () => {
    await addToAllowlist(db, "12345", "first note");
    await addToAllowlist(db, "12345", "second note attempt");
    const entries = await listAllowlist(db);
    expect(entries.length).toBe(1);
    // ON CONFLICT DO NOTHING — the original note is kept, not overwritten.
    expect(entries[0]?.note).toBe("first note");
  });
});

describe("removeFromAllowlist", () => {
  it("is a harmless no-op for an id that was never added", async () => {
    await expect(removeFromAllowlist(db, "does-not-exist")).resolves.toBeUndefined();
  });
});

describe("listAllowlist", () => {
  it("returns an empty list when nothing has been added", async () => {
    expect(await listAllowlist(db)).toEqual([]);
  });

  it("lists every allowed Twitch user id by id, never by display name (no such field exists here)", async () => {
    await addToAllowlist(db, "111");
    await addToAllowlist(db, "222", "note for 222");
    const entries = await listAllowlist(db);
    const ids = entries.map((e) => e.twitchUserId).sort();
    expect(ids).toEqual(["111", "222"]);
  });
});
