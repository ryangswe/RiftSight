// The RiftSight broadcaster — since migration 0005, just the internal,
// platform-neutral identity core: an opaque autoincrement id (which
// producer credentials bind to, and which keys relay sessions) plus
// timestamps. Everything platform-specific (Twitch user id, YouTube
// channel id, display names) lives in platform_identities (identities.ts)
// as linked external identities. A broadcaster can have zero identities
// mid-onboarding, one, or one per platform.

import type { DbClient } from "./client.js";

export interface Broadcaster {
  id: number;
  createdAt: string;
  updatedAt: string;
}

function rowToBroadcaster(row: Record<string, unknown>): Broadcaster {
  return {
    id: Number(row["id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export async function createBroadcaster(db: DbClient): Promise<Broadcaster> {
  const now = new Date().toISOString();
  const inserted = await db.execute({
    sql: "INSERT INTO broadcasters (created_at, updated_at) VALUES (?, ?)",
    args: [now, now],
  });
  // lastInsertRowid, not a re-select — there's no natural key to re-select
  // by (that's the whole point of this table now), and "latest row" would
  // be racy under concurrent onboarding.
  const id = Number(inserted.lastInsertRowid);
  if (!Number.isFinite(id) || id <= 0) throw new Error("createBroadcaster: driver returned no lastInsertRowid");
  return { id, createdAt: now, updatedAt: now };
}

export async function getBroadcasterById(db: DbClient, broadcasterId: number): Promise<Broadcaster | null> {
  const result = await db.execute({ sql: "SELECT * FROM broadcasters WHERE id = ?", args: [broadcasterId] });
  const row = result.rows[0];
  return row ? rowToBroadcaster(row) : null;
}
