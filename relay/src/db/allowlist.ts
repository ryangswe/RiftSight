import type { DbClient } from "./client.js";

export interface AllowlistEntry {
  twitchUserId: string;
  addedAt: string;
  note: string | null;
}

export async function isAllowed(db: DbClient, twitchUserId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM twitch_allowlist WHERE twitch_user_id = ?",
    args: [twitchUserId],
  });
  return result.rows.length > 0;
}

export async function addToAllowlist(db: DbClient, twitchUserId: string, note?: string): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO twitch_allowlist (twitch_user_id, added_at, note)
      VALUES (?, ?, ?)
      ON CONFLICT (twitch_user_id) DO NOTHING
    `,
    args: [twitchUserId, new Date().toISOString(), note ?? null],
  });
}

/** Also the mechanism for revoking a beta streamer — producer-credential validation (added in a later stage) checks this list, so removal here blocks future producer access without needing a separate revocation step. */
export async function removeFromAllowlist(db: DbClient, twitchUserId: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM twitch_allowlist WHERE twitch_user_id = ?",
    args: [twitchUserId],
  });
}

export async function listAllowlist(db: DbClient): Promise<AllowlistEntry[]> {
  const result = await db.execute("SELECT * FROM twitch_allowlist ORDER BY added_at ASC");
  return result.rows.map((row) => ({
    twitchUserId: String(row["twitch_user_id"]),
    addedAt: String(row["added_at"]),
    note: row["note"] === null ? null : String(row["note"]),
  }));
}

// ---------------------------------------------------------------------------
// YouTube beta allowlist — the same gate twitch_allowlist provides for
// Twitch linking, for YouTube-only onboarding (see auth/google routes).
// Kept as a separate table (not a generic platform_allowlist) so the
// existing twitch_allowlist operator surface, CLI, and revocation
// semantics stay byte-identical.
// ---------------------------------------------------------------------------

export async function isYouTubeAllowed(db: DbClient, youtubeChannelId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM youtube_allowlist WHERE youtube_channel_id = ?",
    args: [youtubeChannelId],
  });
  return result.rows.length > 0;
}

export async function addToYouTubeAllowlist(db: DbClient, youtubeChannelId: string, note?: string): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO youtube_allowlist (youtube_channel_id, added_at, note)
      VALUES (?, ?, ?)
      ON CONFLICT (youtube_channel_id) DO NOTHING
    `,
    args: [youtubeChannelId, new Date().toISOString(), note ?? null],
  });
}

export async function removeFromYouTubeAllowlist(db: DbClient, youtubeChannelId: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM youtube_allowlist WHERE youtube_channel_id = ?",
    args: [youtubeChannelId],
  });
}

/**
 * The beta-permission check for a broadcaster as a whole: permitted iff ANY
 * linked identity is on its platform's allowlist. This is what credential
 * validation gates on (see producer-credentials.ts) — so removing a
 * streamer's identity from its allowlist still revokes their producer
 * access with no separate revocation step, exactly as before the identity
 * refactor, and a Twitch+YouTube broadcaster stays permitted as long as
 * EITHER platform still vouches for them.
 */
export async function isBroadcasterPermitted(db: DbClient, broadcasterId: number): Promise<boolean> {
  const result = await db.execute({
    sql: `
      SELECT 1 FROM platform_identities pi
      LEFT JOIN twitch_allowlist ta ON pi.platform = 'twitch' AND ta.twitch_user_id = pi.external_id
      LEFT JOIN youtube_allowlist ya ON pi.platform = 'youtube' AND ya.youtube_channel_id = pi.external_id
      WHERE pi.broadcaster_id = ? AND (ta.twitch_user_id IS NOT NULL OR ya.youtube_channel_id IS NOT NULL)
      LIMIT 1
    `,
    args: [broadcasterId],
  });
  return result.rows.length > 0;
}
