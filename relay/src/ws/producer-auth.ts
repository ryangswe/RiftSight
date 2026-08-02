// Authenticates a producer WebSocket at the HTTP Upgrade step, before the
// socket is ever accepted — mirrors the viewer path's "never trust a
// client-asserted identity" discipline (see auth/twitch-jwt.ts), but for
// producers the credential is an opaque bearer token rather than a JWT
// (see auth/producer-credential.ts for why). Browsers' WebSocket API can't
// set a custom Authorization header on the handshake, so the credential
// travels as a query-string parameter on the /ws/producer upgrade request
// instead — the one part of the handshake a browser WebSocket client can
// actually control.

import type { IncomingMessage } from "node:http";
import type { DbClient } from "../db/client.js";
import { validateProducerCredential } from "../db/producer-credentials.js";

export const PRODUCER_WS_PATH = "/ws/producer";

export type ProducerAuthResult =
  | { authenticated: true; broadcasterId: number; twitchUserId: string }
  | { authenticated: false; reason: string };

/** Pure: true if this upgrade request's path is the authenticated-producer endpoint, not the legacy/viewer endpoint. */
export function isProducerUpgradePath(url: string): boolean {
  return new URL(url, "http://placeholder").pathname === PRODUCER_WS_PATH;
}

/** Pure: extracts the bearer credential from a /ws/producer upgrade request's query string. Split out from authenticateProducerUpgrade so the URL-parsing logic is testable without a database. */
export function extractProducerCredential(url: string): string | undefined {
  return new URL(url, "http://placeholder").searchParams.get("credential") ?? undefined;
}

/** Thin glue over validateProducerCredential — resolves a /ws/producer upgrade request's credential to the broadcaster it's bound to, or a rejection reason. Never throws; a DB error should fail the upgrade closed, not crash the server. */
export async function authenticateProducerUpgrade(req: IncomingMessage, db: DbClient): Promise<ProducerAuthResult> {
  const credential = extractProducerCredential(req.url ?? "/");
  if (!credential) return { authenticated: false, reason: "missing credential" };

  const validated = await validateProducerCredential(db, credential);
  if (!validated) return { authenticated: false, reason: "invalid, revoked, or de-allowlisted credential" };

  return { authenticated: true, broadcasterId: validated.broadcasterId, twitchUserId: validated.twitchUserId };
}
