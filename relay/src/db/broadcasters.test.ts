import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { loadMigrations, runMigrations } from "./migrate.js";
import { createBroadcaster, getBroadcasterById } from "./broadcasters.js";

let db: DbClient;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, await loadMigrations());
});

afterEach(() => {
  db.close();
});

describe("createBroadcaster / getBroadcasterById", () => {
  it("creates a bare internal broadcaster with no platform identity required", async () => {
    const broadcaster = await createBroadcaster(db);
    expect(broadcaster.id).toBeGreaterThan(0);
    expect(broadcaster.createdAt).toBe(broadcaster.updatedAt);
    const found = await getBroadcasterById(db, broadcaster.id);
    expect(found?.id).toBe(broadcaster.id);
  });

  it("assigns distinct ids to distinct broadcasters", async () => {
    const first = await createBroadcaster(db);
    const second = await createBroadcaster(db);
    expect(second.id).not.toBe(first.id);
  });

  it("returns null for an unknown id", async () => {
    expect(await getBroadcasterById(db, 424242)).toBeNull();
  });
});
