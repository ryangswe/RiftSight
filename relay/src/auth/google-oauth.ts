// "Connect YouTube" — Google's authorization-code OAuth flow, used to
// VERIFY ownership of a YouTube channel while linking it (unlike the
// manual beta claim, which trusts a pasted UC... id). Mirrors
// twitch-oauth.ts deliberately: same injectable-fetch seam, same
// use-once-never-persist token handling, same "identity is all we need"
// posture. The one scope requested is youtube.readonly — enough for
// channels?mine=true (whose channel is this token?), nothing else.
//
// This module is code-complete but INERT until GOOGLE_CLIENT_ID/SECRET/
// GOOGLE_OAUTH_REDIRECT_URI are provisioned (a Google Cloud project with
// the YouTube Data API v3 enabled + OAuth consent screen) — the routes
// respond 503 without them, exactly like the Twitch OAuth trio.

import nodeFetch, { Response as NodeFetchResponse } from "node-fetch";
import type { FetchLike } from "./twitch-oauth.js";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const defaultFetch: FetchLike = nodeFetch as unknown as FetchLike;

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export function buildGoogleAuthorizeUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", YOUTUBE_READONLY_SCOPE);
  url.searchParams.set("state", state);
  // One-shot identity check: no refresh token wanted (access_type online),
  // and no incremental-consent complexity.
  url.searchParams.set("access_type", "online");
  return url.toString();
}

export async function exchangeGoogleCodeForToken(
  config: GoogleOAuthConfig,
  code: string,
  fetchFn: FetchLike = defaultFetch
): Promise<{ accessToken: string } | { error: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });

  let response: NodeFetchResponse;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return { error: `token exchange request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { error: `token exchange failed with status ${response.status}` };
  }

  const data = (await response.json()) as { access_token?: string };
  if (typeof data.access_token !== "string") {
    return { error: "token exchange response missing access_token" };
  }
  return { accessToken: data.access_token };
}

export interface YouTubeChannelIdentity {
  channelId: string;
  title: string;
}

/**
 * Whose channel is behind this token — GET channels?part=snippet&mine=true.
 * "no-channel" is a real outcome, not an error: a Google account with no
 * YouTube channel returns an empty items list, and the linking flow shows
 * a specific message for it.
 */
export async function fetchOwnYouTubeChannel(
  accessToken: string,
  fetchFn: FetchLike = defaultFetch
): Promise<YouTubeChannelIdentity | { noChannel: true } | { error: string }> {
  let response: NodeFetchResponse;
  try {
    response = await fetchFn(`${CHANNELS_URL}?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return { error: `channel lookup request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { error: `channel lookup failed with status ${response.status}` };
  }

  const data = (await response.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
  const first = data.items?.[0];
  if (!first || typeof first.id !== "string") return { noChannel: true };
  return { channelId: first.id, title: typeof first.snippet?.title === "string" ? first.snippet.title : first.id };
}
