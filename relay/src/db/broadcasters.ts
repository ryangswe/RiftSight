import type { DbClient } from "./client.js";

export interface Broadcaster {
  id: number;
  twitchUserId: string;
  twitchLogin: string;
  /** The streamer-claimed YouTube channel id ("UC..."), or null if never claimed — see migration 0004 and setYouTubeChannel below. */
  youtubeChannelId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToBroadcaster(row: Record<string, unknown>): Broadcaster {
  return {
    id: Number(row["id"]),
    twitchUserId: String(row["twitch_user_id"]),
    twitchLogin: String(row["twitch_login"]),
    youtubeChannelId: row["youtube_channel_id"] == null ? null : String(row["youtube_channel_id"]),
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

/**
 * Claims (or re-claims — setting your own current value is a no-op "ok") a
 * YouTube channel for one broadcaster. "conflict" when a DIFFERENT
 * broadcaster already holds the channel: the pre-check catches the normal
 * case with a friendly answer, and the partial UNIQUE index (migration
 * 0004) still backstops the race where two claims interleave — that late
 * failure surfaces as "conflict" too, not a thrown error, so the API layer
 * has exactly two outcomes to map. Format validation (the UC... pattern)
 * is the caller's job; this layer treats the id as an opaque string.
 */
export async function setYouTubeChannel(db: DbClient, broadcasterId: number, youtubeChannelId: string): Promise<"ok" | "conflict"> {
  const existing = await findBroadcasterByYouTubeChannel(db, youtubeChannelId);
  if (existing && existing.id !== broadcasterId) return "conflict";
  try {
    await db.execute({
      sql: "UPDATE broadcasters SET youtube_channel_id = ?, updated_at = ? WHERE id = ?",
      args: [youtubeChannelId, new Date().toISOString(), broadcasterId],
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return "conflict";
    throw error;
  }
  return "ok";
}

export async function clearYouTubeChannel(db: DbClient, broadcasterId: number): Promise<void> {
  await db.execute({
    sql: "UPDATE broadcasters SET youtube_channel_id = NULL, updated_at = ? WHERE id = ?",
    args: [new Date().toISOString(), broadcasterId],
  });
}

export async function getBroadcasterById(db: DbClient, broadcasterId: number): Promise<Broadcaster | null> {
  const result = await db.execute({ sql: "SELECT * FROM broadcasters WHERE id = ?", args: [broadcasterId] });
  const row = result.rows[0];
  return row ? rowToBroadcaster(row) : null;
}

/** The viewer-path resolution query: which broadcaster (if any) has claimed this YouTube channel. The relay maps the result's twitchUserId — the session key every producer publishes under — into admitViewer. */
export async function findBroadcasterByYouTubeChannel(db: DbClient, youtubeChannelId: string): Promise<Broadcaster | null> {
  const result = await db.execute({
    sql: "SELECT * FROM broadcasters WHERE youtube_channel_id = ?",
    args: [youtubeChannelId],
  });
  const row = result.rows[0];
  return row ? rowToBroadcaster(row) : null;
}
