import { describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { loadMigrations, runMigrations } from "./migrate.js";
import { copyDatabase, CopyRefusedError, TABLE_COPY_ORDER } from "./copy.js";
import { upsertBroadcaster } from "./broadcasters.js";
import { addToAllowlist, listAllowlist } from "./allowlist.js";
import { issueProducerCredential, validateProducerCredential } from "./producer-credentials.js";

async function migratedDb(): Promise<DbClient> {
  const db = createDbClient(":memory:");
  await runMigrations(db, await loadMigrations());
  return db;
}

/** A realistic source: one broadcaster created the normal way, one inserted with a deliberately non-sequential id (the cutover must preserve ids, never renumber), an allowlist row, and a live credential bound to the odd id. */
async function seededSource(): Promise<{ db: DbClient; token: string }> {
  const db = await migratedDb();
  await upsertBroadcaster(db, "111", "alice");
  await db.execute({
    sql: "INSERT INTO broadcasters (id, twitch_user_id, twitch_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    args: [7, "222", "bob", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  });
  await addToAllowlist(db, "111", "seed");
  await addToAllowlist(db, "222");
  const token = await issueProducerCredential(db, 7);
  return { db, token };
}

describe("copyDatabase", () => {
  it("copies every relay table with ids preserved, and a credential issued on the source validates on the target", async () => {
    const { db: source, token } = await seededSource();
    const target = await migratedDb();

    const summary = await copyDatabase(source, target);

    expect(summary.truncated).toBe(false);
    expect(summary.tables.map((t) => t.table)).toEqual([...TABLE_COPY_ORDER]);
    for (const { sourceRows, targetRows } of summary.tables) expect(targetRows).toBe(sourceRows);

    const bob = await target.execute("SELECT id, twitch_login FROM broadcasters WHERE twitch_user_id = '222'");
    expect(Number(bob.rows[0]?.[0])).toBe(7); // explicit id survived, not reassigned by AUTOINCREMENT
    expect(bob.rows[0]?.[1]).toBe("bob");
    expect((await listAllowlist(target)).map((e) => e.twitchUserId).sort()).toEqual(["111", "222"]);
    const validated = await validateProducerCredential(target, token);
    expect(validated?.broadcasterId).toBe(7); // token hash + FK binding copied intact

    source.close();
    target.close();
  });

  it("refuses a non-empty target without --force, and with --force truncates then re-copies to matching counts", async () => {
    const { db: source } = await seededSource();
    const target = await migratedDb();
    await upsertBroadcaster(target, "999", "stale-row");

    await expect(copyDatabase(source, target)).rejects.toBeInstanceOf(CopyRefusedError);
    expect(Number((await target.execute("SELECT COUNT(*) FROM broadcasters")).rows[0]?.[0])).toBe(1); // untouched on refusal

    const summary = await copyDatabase(source, target, { force: true });
    expect(summary.truncated).toBe(true);
    const ids = (await target.execute("SELECT twitch_user_id FROM broadcasters ORDER BY id")).rows.map((r) => r[0]);
    expect(ids).toEqual(["111", "222"]); // the stale row is gone, the source's rows are exactly what's there

    source.close();
    target.close();
  });

  it("refuses an unmigrated target instead of copying rows into nothing", async () => {
    const { db: source } = await seededSource();
    const target = createDbClient(":memory:");
    await expect(copyDatabase(source, target)).rejects.toThrow(/run `npm run migrate -w relay` against DST first/);
    source.close();
    target.close();
  });

  it("refuses a source with a table it doesn't know about (schema drift must update TABLE_COPY_ORDER, never be skipped)", async () => {
    const { db: source } = await seededSource();
    await source.execute("CREATE TABLE youtube_allowlist (channel_id TEXT PRIMARY KEY)");
    const target = await migratedDb();
    await expect(copyDatabase(source, target)).rejects.toThrow(/youtube_allowlist/);
    source.close();
    target.close();
  });
});
