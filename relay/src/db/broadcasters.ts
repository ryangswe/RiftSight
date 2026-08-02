import type { DbClient } from "./client.js";

export interface Broadcaster {
  id: number;
  twitchUserId: string;
  twitchLogin: string;
  createdAt: string;
  updatedAt: string;
}

function rowToBroadcaster(row: Record<string, unknown>): Broadcaster {
  return {
    id: Number(row["id"]),
    twitchUserId: String(row["twitch_user_id"]),
    twitchLogin: String(row["twitch_login"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export async function getBroadcasterByTwitchUserId(db: DbClient, twitchUserId: string): Promise<Broadcaster | null> {
  const result = await db.execute({
    sql: "SELECT * FROM broadcasters WHERE twitch_user_id = ?",
    args: [twitchUserId],
  });
  const row = result.rows[0];
  return row ? rowToBroadcaster(row) : null;
}

/** Creates the broadcaster row on first link, or refreshes twitch_login/updated_at on a later relink — a display name can change, the row identity (twitch_user_id) never does. */
export async function upsertBroadcaster(db: DbClient, twitchUserId: string, twitchLogin: string): Promise<Broadcaster> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO broadcasters (twitch_user_id, twitch_login, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (twitch_user_id) DO UPDATE SET twitch_login = excluded.twitch_login, updated_at = excluded.updated_at
    `,
    args: [twitchUserId, twitchLogin, now, now],
  });
  const broadcaster = await getBroadcasterByTwitchUserId(db, twitchUserId);
  if (!broadcaster) {
    throw new Error(`upsertBroadcaster: row for twitch_user_id "${twitchUserId}" not found immediately after insert`);
  }
  return broadcaster;
}
