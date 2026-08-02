import type { DbClient } from "./client.js";
import { generateProducerCredential, hashProducerCredential } from "../auth/producer-credential.js";

export interface ValidatedProducerCredential {
  broadcasterId: number;
  /** The Twitch channel id this credential's producer connection may publish to — resolved server-side, never trusted from the client. */
  twitchUserId: string;
}

/** Mints a new credential for a broadcaster and persists only its hash. Returns the RAW token — shown to the caller exactly once, never retrievable again. */
export async function issueProducerCredential(db: DbClient, broadcasterId: number): Promise<string> {
  const token = generateProducerCredential();
  const tokenHash = hashProducerCredential(token);
  await db.execute({
    sql: "INSERT INTO producer_credentials (broadcaster_id, token_hash, created_at) VALUES (?, ?, ?)",
    args: [broadcasterId, tokenHash, new Date().toISOString()],
  });
  return token;
}

/**
 * Resolves a presented raw token to the broadcaster it's bound to, or null
 * if the credential doesn't exist, has been explicitly revoked, OR its
 * broadcaster is no longer on the closed-beta allowlist — this JOIN is
 * what makes "remove a streamer from the allowlist" alone sufficient to
 * block their future producer connections, with no separate revocation
 * step needed at removal time (see allowlist.ts's removeFromAllowlist doc
 * comment). An already-open connection isn't force-disconnected by this;
 * it only blocks future connection attempts (checked at every WS upgrade —
 * see ws/producer.ts, a later stage).
 */
export async function validateProducerCredential(db: DbClient, rawToken: string): Promise<ValidatedProducerCredential | null> {
  const tokenHash = hashProducerCredential(rawToken);
  const result = await db.execute({
    sql: `
      SELECT pc.broadcaster_id AS broadcaster_id, b.twitch_user_id AS twitch_user_id
      FROM producer_credentials pc
      JOIN broadcasters b ON b.id = pc.broadcaster_id
      JOIN twitch_allowlist a ON a.twitch_user_id = b.twitch_user_id
      WHERE pc.token_hash = ? AND pc.revoked_at IS NULL
    `,
    args: [tokenHash],
  });
  const row = result.rows[0];
  if (!row) return null;
  return { broadcasterId: Number(row["broadcaster_id"]), twitchUserId: String(row["twitch_user_id"]) };
}

export async function revokeAllCredentialsForBroadcaster(db: DbClient, broadcasterId: number): Promise<void> {
  await db.execute({
    sql: "UPDATE producer_credentials SET revoked_at = ? WHERE broadcaster_id = ? AND revoked_at IS NULL",
    args: [new Date().toISOString(), broadcasterId],
  });
}

/** Atomically invalidates every current credential for a broadcaster and issues a fresh one — used both for on-demand rotation and (implicitly, via revocation) whenever a credential is suspected compromised. */
export async function rotateProducerCredential(db: DbClient, broadcasterId: number): Promise<string> {
  await revokeAllCredentialsForBroadcaster(db, broadcasterId);
  return issueProducerCredential(db, broadcasterId);
}
