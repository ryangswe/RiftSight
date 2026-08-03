// GET /api/link-status?linkId=... — polled by the extension after opening
// /auth/twitch/start?linkId=... until it reports "ready", then fetches the
// raw credential exactly once (redeem is single-use — see link-handoff.ts).
//
// POST /api/producer-credential/rotate — bearer-authed with the CURRENT
// credential; atomically revokes it and issues a fresh one. Lets a
// streamer (or the extension, on suspected compromise) force a new
// credential without going through OAuth again.
//
// GET /api/producer-credential/status — bearer-authed diagnostic-only
// lookup, called by the extension after a producer WebSocket connection
// fails for a reason it can't otherwise tell apart (see background.ts):
// the browser's WebSocket API never exposes the HTTP status of a failed
// upgrade, so "backend unreachable," "invalid credential," and "revoked
// credential" would otherwise all look identical. Uses
// inspectProducerCredential — a separate, read-only query from
// validateProducerCredential above, which remains the ONLY function that
// actually decides whether a producer connection is admitted; this route
// can never grant a connection, only describe one.

import type { DbClient } from "../../db/client.js";
import { inspectProducerCredential, rotateProducerCredential, validateProducerCredential } from "../../db/producer-credentials.js";
import type { LinkHandoffStore } from "../../auth/link-handoff.js";
import { jsonResponse, type HttpRequest, type HttpResponse } from "../types.js";

export function handleLinkStatus(req: HttpRequest, linkHandoff: LinkHandoffStore): HttpResponse {
  const url = new URL(req.url, "http://placeholder");
  const linkId = url.searchParams.get("linkId");
  if (!linkId) {
    return jsonResponse(400, { error: "missing linkId" });
  }

  const status = linkHandoff.status(linkId);
  if (status === "ready") {
    const result = linkHandoff.redeem(linkId);
    // redeem() can only fail here on a race with a concurrent poll already
    // having consumed it a moment earlier — report it the same as any
    // other no-longer-available link rather than a special case.
    if (result === undefined) {
      return jsonResponse(200, { status: "not-found" });
    }
    return jsonResponse(200, { status: "ready", credential: result.credential, displayName: result.displayName });
  }

  return jsonResponse(200, { status });
}

function extractBearerToken(req: HttpRequest): string | undefined {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

export async function handleRotateProducerCredential(req: HttpRequest, db: DbClient): Promise<HttpResponse> {
  const token = extractBearerToken(req);
  if (!token) {
    return jsonResponse(401, { error: "missing bearer credential" });
  }

  const validated = await validateProducerCredential(db, token);
  if (!validated) {
    return jsonResponse(401, { error: "invalid, revoked, or no-longer-permitted credential" });
  }

  const newCredential = await rotateProducerCredential(db, validated.broadcasterId);
  return jsonResponse(200, { credential: newCredential });
}

/** A missing bearer header is a malformed request (401) — a token that IS present but doesn't resolve to anything is a genuine diagnostic outcome, reported as `{status: "invalid_or_malformed"}` in a normal 200, not a second kind of 401. That split mirrors "did you even try to authenticate" vs. "here's what we found" once you did. */
export async function handleProducerCredentialStatus(req: HttpRequest, db: DbClient): Promise<HttpResponse> {
  const token = extractBearerToken(req);
  if (!token) {
    return jsonResponse(401, { error: "missing bearer credential" });
  }

  const status = await inspectProducerCredential(db, token);
  return jsonResponse(200, { status });
}
