// GET /api/link-status?linkId=... — polled by the extension after opening
// /auth/twitch/start?linkId=... until it reports "ready", then fetches the
// raw credential exactly once (redeem is single-use — see link-handoff.ts).
//
// POST /api/producer-credential/rotate — bearer-authed with the CURRENT
// credential; atomically revokes it and issues a fresh one. Lets a
// streamer (or the extension, on suspected compromise) force a new
// credential without going through OAuth again.

import type { DbClient } from "../../db/client.js";
import { rotateProducerCredential, validateProducerCredential } from "../../db/producer-credentials.js";
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
