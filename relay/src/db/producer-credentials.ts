import type { DbClient } from "./client.js";
import { generateProducerCredential, hashProducerCredential } from "../auth/producer-credential.js";
import { isAllowed } from "./allowlist.js";

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

export type ProducerCredentialStatus = "valid" | "invalid_or_malformed" | "revoked_or_replaced" | "not_allowlisted";

/**
 * Read-only diagnostic breakdown for GET /api/producer-credential/status —
 * deliberately NOT used by the WS-upgrade auth path, which continues to
 * call only validateProducerCredential above for the actual yes/no
 * connection decision. This exists purely to give the extension (after an
 * ambiguous WebSocket failure — the browser can't see the HTTP status of a
 * failed upgrade) a finer-grained reason than validateProducerCredential's
 * single null/non-null result can express.
 *
 * There is no "expired" outcome: this schema has no credential-expiry
 * column (producer_credentials only ever has created_at/revoked_at — see
 * its migration's own doc comment, "no forced expiry, long-lived by
 * default"), so "revoked" and "replaced" were already the same DB state
 * (rotation revokes the old token) before this function existed — one
 * bucket, not two, rather than inventing a distinction the data can't
 * support.
 */
export async function inspectProducerCredential(db: DbClient, rawToken: string): Promise<ProducerCredentialStatus> {
  const tokenHash = hashProducerCredential(rawToken);
  const result = await db.execute({
    sql: `
      SELECT pc.revoked_at AS revoked_at, b.twitch_user_id AS twitch_user_id
      FROM producer_credentials pc
      JOIN broadcasters b ON b.id = pc.broadcaster_id
      WHERE pc.token_hash = ?
    `,
    args: [tokenHash],
  });
  const row = result.rows[0];
  if (!row) return "invalid_or_malformed";
  if (row["revoked_at"] !== null) return "revoked_or_replaced";

  const twitchUserId = String(row["twitch_user_id"]);
  const allowed = await isAllowed(db, twitchUserId);
  if (!allowed) return "not_allowlisted";

  return "valid";
}

export async function revokeAllCredentialsForBroadcaster(db: DbClient, broadcasterId: number): Promise<void> {
  await db.execute({
    sql: "UPDATE producer_credentials SET revoked_at = ? WHERE broadcaster_id = ? AND revoked_at IS NULL",
    args: [new Date().toISOString(), broadcasterId],
  });
}

/**
 * Atomically invalidates every current credential for a broadcaster and
 * issues a fresh one — used both for on-demand rotation and (implicitly,
 * via revocation) whenever a credential is suspected compromised.
 *
 * Deliberately does NOT delegate to revokeAllCredentialsForBroadcaster
 * above — that function stays a generic "revoke, no further detail"
 * primitive (its own tests call it directly to set up revoked-credential
 * fixtures), while rotation sets `rotated_at` alongside `revoked_at` in one
 * UPDATE, so a superseded row's timestamps accurately record *why* it was
 * revoked. Today rotation is the only path that ever revokes a credential,
 * but keeping the two write paths distinct means that stays true by
 * construction, not by every future revocation path having to remember not
 * to set rotated_at.
 */
export async function rotateProducerCredential(db: DbClient, broadcasterId: number): Promise<string> {
  const timestamp = new Date().toISOString();
  await db.execute({
    sql: "UPDATE producer_credentials SET revoked_at = ?, rotated_at = ? WHERE broadcaster_id = ? AND revoked_at IS NULL",
    args: [timestamp, timestamp, broadcasterId],
  });
  return issueProducerCredential(db, broadcasterId);
}

/**
 * Best-effort freshness signal for an operator, updated once per successful
 * producer WebSocket authentication (see ws/producer-auth.ts) — never per
 * overlay-state message, which would mean a write on every card-detection
 * publish (many times a minute) instead of once per connection attempt. A
 * no-op (zero rows affected) if the token doesn't resolve to anything,
 * which is fine — this is only ever called right after a successful
 * validateProducerCredential, so that shouldn't happen in practice, but the
 * function doesn't need to assume it won't.
 */
export async function touchProducerCredentialLastUsed(db: DbClient, rawToken: string): Promise<void> {
  const tokenHash = hashProducerCredential(rawToken);
  await db.execute({
    sql: "UPDATE producer_credentials SET last_used_at = ? WHERE token_hash = ?",
    args: [new Date().toISOString(), tokenHash],
  });
}

export interface ProducerCredentialLifecycle {
  issuedAt: string;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  /** Convenience for callers — equivalent to `revokedAt === null`. */
  active: boolean;
}

/**
 * Read-only operator reporting query — every credential a broadcaster has
 * ever had, most recent first, for the `credential-status` CLI command
 * (see scripts/seed-allowlist.ts). Deliberately never selects token_hash:
 * this is meant to be safe to print to a terminal or paste into a support
 * conversation, unlike the actual credential material. Sorted by
 * created_at then id (both DESC) rather than created_at alone — a
 * millisecond-resolution ISO timestamp isn't enough to break ties between
 * two credentials issued in the same millisecond (e.g. rotation's
 * revoke-then-immediately-reissue), but id (autoincrement) always is.
 */
export async function listCredentialLifecycleForBroadcaster(
  db: DbClient,
  twitchUserId: string
): Promise<ProducerCredentialLifecycle[]> {
  const result = await db.execute({
    sql: `
      SELECT pc.created_at AS issued_at, pc.last_used_at AS last_used_at, pc.rotated_at AS rotated_at, pc.revoked_at AS revoked_at
      FROM producer_credentials pc
      JOIN broadcasters b ON b.id = pc.broadcaster_id
      WHERE b.twitch_user_id = ?
      ORDER BY pc.created_at DESC, pc.id DESC
    `,
    args: [twitchUserId],
  });
  return result.rows.map((row) => ({
    issuedAt: String(row["issued_at"]),
    lastUsedAt: row["last_used_at"] === null ? null : String(row["last_used_at"]),
    rotatedAt: row["rotated_at"] === null ? null : String(row["rotated_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    active: row["revoked_at"] === null,
  }));
}
