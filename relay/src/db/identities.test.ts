import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { loadMigrations, runMigrations } from "./migrate.js";
import { createBroadcaster } from "./broadcasters.js";
import { addToAllowlist, addToYouTubeAllowlist, isBroadcasterPermitted, removeFromAllowlist } from "./allowlist.js";
import {
  clearPlatformIdentity,
  findIdentity,
  getIdentityForBroadcaster,
  linkOrCreateBroadcasterWithIdentity,
  listIdentitiesForBroadcaster,
  setPlatformIdentity,
} from "./identities.js";

const CHANNEL_A = "UC" + "a".repeat(22);

let db: DbClient;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, await loadMigrations());
});

afterEach(() => {
  db.close();
});

describe("setPlatformIdentity / findIdentity", () => {
  it("links an identity and resolves it back", async () => {
    const broadcaster = await createBroadcaster(db);
    expect(await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", "juicykaraage")).toBe("ok");
    const found = await findIdentity(db, "twitch", "12345");
    expect(found).toEqual({ broadcasterId: broadcaster.id, platform: "twitch", externalId: "12345", displayName: "juicykaraage" });
  });

  it("re-linking your own identity refreshes the display name", async () => {
    const broadcaster = await createBroadcaster(db);
    await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", "old_name");
    expect(await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", "new_name")).toBe("ok");
    expect((await findIdentity(db, "twitch", "12345"))?.displayName).toBe("new_name");
  });

  it("linking a different channel on the same platform replaces the old link", async () => {
    const broadcaster = await createBroadcaster(db);
    await setPlatformIdentity(db, broadcaster.id, "youtube", CHANNEL_A, null);
    expect(await setPlatformIdentity(db, broadcaster.id, "youtube", "UC" + "b".repeat(22), null)).toBe("ok");
    expect(await findIdentity(db, "youtube", CHANNEL_A)).toBeNull();
    expect((await listIdentitiesForBroadcaster(db, broadcaster.id)).length).toBe(1);
  });

  it("conflicts when a different broadcaster owns the identity", async () => {
    const first = await createBroadcaster(db);
    const second = await createBroadcaster(db);
    await setPlatformIdentity(db, first.id, "youtube", CHANNEL_A, null);
    expect(await setPlatformIdentity(db, second.id, "youtube", CHANNEL_A, null)).toBe("conflict");
  });

  it("platforms are independent axes — twitch and youtube identities coexist on one broadcaster", async () => {
    const broadcaster = await createBroadcaster(db);
    await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", "name");
    await setPlatformIdentity(db, broadcaster.id, "youtube", CHANNEL_A, null);
    const identities = await listIdentitiesForBroadcaster(db, broadcaster.id);
    expect(identities.map((i) => i.platform)).toEqual(["twitch", "youtube"]);
    expect((await getIdentityForBroadcaster(db, broadcaster.id, "youtube"))?.externalId).toBe(CHANNEL_A);
  });

  it("clearPlatformIdentity releases the identity for another broadcaster", async () => {
    const first = await createBroadcaster(db);
    const second = await createBroadcaster(db);
    await setPlatformIdentity(db, first.id, "youtube", CHANNEL_A, null);
    await clearPlatformIdentity(db, first.id, "youtube");
    expect(await setPlatformIdentity(db, second.id, "youtube", CHANNEL_A, null)).toBe("ok");
  });
});

describe("linkOrCreateBroadcasterWithIdentity", () => {
  it("creates a fresh broadcaster for a first-time link", async () => {
    const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "12345", "name");
    expect((await findIdentity(db, "twitch", "12345"))?.broadcasterId).toBe(broadcasterId);
  });

  it("resolves a relink to the same broadcaster instead of creating a duplicate", async () => {
    const first = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "12345", "name");
    const second = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "12345", "renamed");
    expect(second.broadcasterId).toBe(first.broadcasterId);
    expect((await findIdentity(db, "twitch", "12345"))?.displayName).toBe("renamed");
  });

  it("a YouTube-only broadcaster requires no Twitch anything", async () => {
    const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(db, "youtube", CHANNEL_A, "My Channel");
    const identities = await listIdentitiesForBroadcaster(db, broadcasterId);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.platform).toBe("youtube");
  });
});

describe("isBroadcasterPermitted", () => {
  it("false with no identities, or identities on no allowlist", async () => {
    const broadcaster = await createBroadcaster(db);
    expect(await isBroadcasterPermitted(db, broadcaster.id)).toBe(false);
    await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", null);
    expect(await isBroadcasterPermitted(db, broadcaster.id)).toBe(false);
  });

  it("true via the twitch allowlist, and revoked by removal — the legacy revocation semantics, preserved", async () => {
    const broadcaster = await createBroadcaster(db);
    await setPlatformIdentity(db, broadcaster.id, "twitch", "12345", null);
    await addToAllowlist(db, "12345");
    expect(await isBroadcasterPermitted(db, broadcaster.id)).toBe(true);
    await removeFromAllowlist(db, "12345");
    expect(await isBroadcasterPermitted(db, broadcaster.id)).toBe(false);
  });

  it("true via the youtube allowlist alone — a YouTube-only broadcaster is fully permitted without Twitch", async () => {
    const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(db, "youtube", CHANNEL_A, null);
    expect(await isBroadcasterPermitted(db, broadcasterId)).toBe(false);
    await addToYouTubeAllowlist(db, CHANNEL_A);
    expect(await isBroadcasterPermitted(db, broadcasterId)).toBe(true);
  });

  it("either platform's allowlist suffices for a dual-platform broadcaster", async () => {
    const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "12345", null);
    await setPlatformIdentity(db, broadcasterId, "youtube", CHANNEL_A, null);
    await addToYouTubeAllowlist(db, CHANNEL_A); // NOT on the twitch allowlist
    expect(await isBroadcasterPermitted(db, broadcasterId)).toBe(true);
  });
});
