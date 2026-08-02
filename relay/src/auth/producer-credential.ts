// RiftSight's own producer credential — an opaque random token, not a
// signed JWT. Both "revocable" and "removing a beta streamer blocks
// future producer access" require checking live, mutable server state on
// every connection regardless of token type, so a JWT's main benefit
// (skip-the-DB-lookup verification) doesn't actually apply here; an opaque
// token avoids the extra complexity (claims, signing key management) for
// no offsetting gain. Only this token's SHA-256 hash is ever persisted
// (db/producer-credentials.ts) — the raw value exists only in memory
// during issuance/rotation and in the extension's own storage.
//
// Never confuse this with a Twitch Extension JWT (viewer auth,
// twitch-jwt.ts) or the Twitch API OAuth token (twitch-oauth.ts, used
// once and discarded) — see env.ts's RelayEnvConfig doc comment.

import { createHash, randomBytes } from "node:crypto";

export function generateProducerCredential(): string {
  return randomBytes(32).toString("base64url");
}

export function hashProducerCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
