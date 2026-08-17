// Thin client for the relay's /api/youtube-channel routes (see
// relay/src/http/routes/youtube-channel.ts) — how the streamer's claimed
// channel mapping is written/read. Bearer-authed with the same stored
// producer credential auth.ts manages; callable from any extension
// context (the popup uses it directly — extension pages share
// chrome.storage and are exempt from CORS for hosts in
// host_permissions, exactly like the background's own fetches in
// auth.ts).

import { getStoredCredential } from "./auth.js";

export type YouTubeChannelFailure = "not-linked" | "backend-not-configured" | "conflict" | "invalid" | "network";

export type YouTubeChannelResult = { ok: true; channelId: string | null; displayName: string | null } | { ok: false; error: YouTubeChannelFailure };

function backendUrl(): string {
  return __RIFTSIGHT_BACKEND_URL__;
}

async function callYouTubeChannelRoute(method: "GET" | "POST" | "DELETE", channelId?: string): Promise<YouTubeChannelResult> {
  const credential = await getStoredCredential();
  if (!credential) return { ok: false, error: "not-linked" };
  if (!backendUrl()) return { ok: false, error: "backend-not-configured" };

  const url = new URL("/api/youtube-channel", backendUrl());
  if (channelId !== undefined) url.searchParams.set("channelId", channelId);

  let response: Response;
  try {
    response = await fetch(url.toString(), { method, headers: { Authorization: `Bearer ${credential}` } });
  } catch {
    return { ok: false, error: "network" };
  }

  if (response.status === 409) return { ok: false, error: "conflict" };
  if (response.status === 400) return { ok: false, error: "invalid" };
  if (!response.ok) return { ok: false, error: "network" };

  try {
    const body = (await response.json()) as { channelId?: string | null; displayName?: string | null };
    return { ok: true, channelId: body.channelId ?? null, displayName: body.displayName ?? null };
  } catch {
    return { ok: false, error: "network" };
  }
}

/** Reads the currently-claimed channel (null = none claimed). */
export function fetchClaimedYouTubeChannel(): Promise<YouTubeChannelResult> {
  return callYouTubeChannelRoute("GET");
}

/** Claims `channelId` for this broadcaster — "conflict" means someone else already holds it. */
export function saveYouTubeChannelClaim(channelId: string): Promise<YouTubeChannelResult> {
  return callYouTubeChannelRoute("POST", channelId);
}

export function clearYouTubeChannelClaim(): Promise<YouTubeChannelResult> {
  return callYouTubeChannelRoute("DELETE");
}
