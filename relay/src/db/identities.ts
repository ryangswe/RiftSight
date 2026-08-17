// Linked external platform identities for a RiftSight broadcaster — the
// data half of the identity-model correction (migration 0005). The
// broadcaster itself is just `broadcasters.id`; Twitch and YouTube rows
// here point at it. One identity per (platform, external_id) fleet-wide
// (a channel can't belong to two broadcasters), and — by this module's
// replace-own semantics — effectively one identity per platform per
// broadcaster (linking a new channel on the same platform replaces the
// old link, mirroring the old setYouTubeChannel behavior).

import type { DbClient } from "./client.js";
import { createBroadcaster } from "./broadcasters.js";

export type Platform = "twitch" | "youtube";

export interface PlatformIdentity {
  broadcasterId: number;
  platform: Platform;
  externalId: string;
  displayName: string | null;
}

function rowToIdentity(row: Record<string, unknown>): PlatformIdentity {
  return {
    broadcasterId: Number(row["broadcaster_id"]),
    platform: String(row["platform"]) as Platform,
    externalId: String(row["external_id"]),
    displayName: row["display_name"] == null ? null : String(row["display_name"]),
  };
}

/** The viewer-path resolution query for BOTH platforms: which broadcaster (if any) owns this external channel id. */
export async function findIdentity(db: DbClient, platform: Platform, externalId: string): Promise<PlatformIdentity | null> {
  const result = await db.execute({
    sql: "SELECT * FROM platform_identities WHERE platform = ? AND external_id = ?",
    args: [platform, externalId],
  });
  const row = result.rows[0];
  return row ? rowToIdentity(row) : null;
}

export async function getIdentityForBroadcaster(db: DbClient, broadcasterId: number, platform: Platform): Promise<PlatformIdentity | null> {
  const result = await db.execute({
    sql: "SELECT * FROM platform_identities WHERE broadcaster_id = ? AND platform = ?",
    args: [broadcasterId, platform],
  });
  const row = result.rows[0];
  return row ? rowToIdentity(row) : null;
}

export async function listIdentitiesForBroadcaster(db: DbClient, broadcasterId: number): Promise<PlatformIdentity[]> {
  const result = await db.execute({
    sql: "SELECT * FROM platform_identities WHERE broadcaster_id = ? ORDER BY platform ASC",
    args: [broadcasterId],
  });
  return result.rows.map(rowToIdentity);
}

/**
 * Links (or re-links/replaces — setting your own current value refreshes
 * display_name, and linking a different channel on the same platform
 * replaces the old link) an external identity for one broadcaster.
 * "conflict" when a DIFFERENT broadcaster already owns the identity: the
 * pre-check answers the normal case, and the UNIQUE(platform, external_id)
 * constraint still backstops the interleaved race — surfaced as "conflict"
 * too, so callers have exactly two outcomes. External-id format validation
 * is the caller's job; this layer treats ids as opaque strings.
 */
export async function setPlatformIdentity(
  db: DbClient,
  broadcasterId: number,
  platform: Platform,
  externalId: string,
  displayName: string | null
): Promise<"ok" | "conflict"> {
  const existing = await findIdentity(db, platform, externalId);
  if (existing && existing.broadcasterId !== broadcasterId) return "conflict";

  const now = new Date().toISOString();
  try {
    // Replace-own: one identity per platform per broadcaster.
    await db.execute({
      sql: "DELETE FROM platform_identities WHERE broadcaster_id = ? AND platform = ?",
      args: [broadcasterId, platform],
    });
    await db.execute({
      sql: "INSERT INTO platform_identities (broadcaster_id, platform, external_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [broadcasterId, platform, externalId, displayName, now, now],
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return "conflict";
    throw error;
  }
  return "ok";
}

export async function clearPlatformIdentity(db: DbClient, broadcasterId: number, platform: Platform): Promise<void> {
  await db.execute({
    sql: "DELETE FROM platform_identities WHERE broadcaster_id = ? AND platform = ?",
    args: [broadcasterId, platform],
  });
}

/**
 * The account-linking primitive shared by every platform OAuth callback
 * (Twitch today, Google/YouTube next): resolve an external identity to its
 * existing broadcaster, or create a fresh internal broadcaster for a
 * first-time link — then set/refresh the identity either way. Returns the
 * broadcaster id the identity now belongs to. "conflict" is impossible
 * here by construction (an existing identity resolves to its own
 * broadcaster; a new one has no owner), so callers get a plain id back.
 */
export async function linkOrCreateBroadcasterWithIdentity(
  db: DbClient,
  platform: Platform,
  externalId: string,
  displayName: string | null
): Promise<{ broadcasterId: number }> {
  const existing = await findIdentity(db, platform, externalId);
  const broadcasterId = existing ? existing.broadcasterId : (await createBroadcaster(db)).id;
  await setPlatformIdentity(db, broadcasterId, platform, externalId, displayName);
  return { broadcasterId };
}
