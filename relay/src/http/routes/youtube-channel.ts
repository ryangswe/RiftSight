// /api/youtube-channel — the streamer-side half of YouTube support: a
// broadcaster claims (or clears) the public YouTube channel id their
// overlay session should be reachable under. All three methods are
// bearer-authed with the producer credential, mirroring
// producer-credential.ts exactly — the same token that authorizes
// publishing state authorizes pointing a channel at that state's session.
//
// The channel id travels as a query parameter, not a JSON body — this
// codebase's HTTP adapter (http/server.ts's toHttpRequest) deliberately
// never reads request bodies, and the linkId flow already established the
// query-param convention. The id is public information (printed on every
// YouTube watch page), so a URL is a fine place for it.
//
// Ownership verification (proving the caller actually controls the
// YouTube channel, e.g. via YouTube OAuth) is deliberately out of scope
// for the beta: producers are already allowlist-gated, claims are logged,
// and the UNIQUE mapping means a bogus claim is visible/fixable rather
// than silent. See the milestone's out-of-scope list.

import { YOUTUBE_CHANNEL_ID_PATTERN } from "@riftsight/protocol";
import type { DbClient } from "../../db/client.js";
import { validateProducerCredential } from "../../db/producer-credentials.js";
import { clearYouTubeChannel, getBroadcasterById, setYouTubeChannel } from "../../db/broadcasters.js";
import { jsonResponse, type HttpRequest, type HttpResponse } from "../types.js";

function extractBearerToken(req: HttpRequest): string | undefined {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

async function authenticate(req: HttpRequest, db: DbClient): Promise<{ broadcasterId: number } | HttpResponse> {
  const token = extractBearerToken(req);
  if (!token) return jsonResponse(401, { error: "missing bearer credential" });
  const validated = await validateProducerCredential(db, token);
  if (!validated) return jsonResponse(401, { error: "invalid, revoked, or no-longer-permitted credential" });
  return { broadcasterId: validated.broadcasterId };
}

export async function handleGetYouTubeChannel(req: HttpRequest, db: DbClient): Promise<HttpResponse> {
  const auth = await authenticate(req, db);
  if ("status" in auth) return auth;
  const broadcaster = await getBroadcasterById(db, auth.broadcasterId);
  return jsonResponse(200, { channelId: broadcaster?.youtubeChannelId ?? null });
}

export async function handleSetYouTubeChannel(req: HttpRequest, db: DbClient): Promise<HttpResponse> {
  const auth = await authenticate(req, db);
  if ("status" in auth) return auth;

  const channelId = new URL(req.url, "http://placeholder").searchParams.get("channelId") ?? "";
  if (!YOUTUBE_CHANNEL_ID_PATTERN.test(channelId)) {
    return jsonResponse(400, { error: "channelId must be a canonical YouTube channel id (UC + 22 characters)" });
  }

  const outcome = await setYouTubeChannel(db, auth.broadcasterId, channelId);
  if (outcome === "conflict") {
    return jsonResponse(409, { error: "that YouTube channel is already claimed by another broadcaster" });
  }
  return jsonResponse(200, { channelId });
}

export async function handleClearYouTubeChannel(req: HttpRequest, db: DbClient): Promise<HttpResponse> {
  const auth = await authenticate(req, db);
  if ("status" in auth) return auth;
  await clearYouTubeChannel(db, auth.broadcasterId);
  return jsonResponse(200, { channelId: null });
}
