// /auth/google/start and /auth/google/callback — verified YouTube channel
// linking, the ownership-checked counterpart of the manual beta claim
// (/api/youtube-channel). Structurally a mirror of auth-twitch.ts: same
// state store, same linkId handoff for the extension's credential poll,
// same earliest-possible beta gate — except the gate is youtube_allowlist
// and the identity is the authenticated user's own YouTube channel,
// fetched from the YouTube Data API rather than pasted. A YouTube-only
// streamer completes this with NO Twitch anything: the flow creates (or
// resolves) an internal RiftSight broadcaster and links the channel as a
// platform identity.

import type { DbClient } from "../../db/client.js";
import { isYouTubeAllowed } from "../../db/allowlist.js";
import { linkOrCreateBroadcasterWithIdentity } from "../../db/identities.js";
import { issueProducerCredential } from "../../db/producer-credentials.js";
import type { StateStore } from "../../auth/state-store.js";
import type { LinkHandoffStore } from "../../auth/link-handoff.js";
import type { FetchLike } from "../../auth/twitch-oauth.js";
import { buildGoogleAuthorizeUrl, exchangeGoogleCodeForToken, fetchOwnYouTubeChannel, type GoogleOAuthConfig } from "../../auth/google-oauth.js";
import { htmlResponse, type HttpRequest, type HttpResponse } from "../types.js";

export function handleGoogleAuthStart(
  req: HttpRequest,
  config: GoogleOAuthConfig,
  stateStore: StateStore,
  linkHandoff: LinkHandoffStore
): HttpResponse {
  const url = new URL(req.url, "http://placeholder");
  const linkId = url.searchParams.get("linkId") ?? undefined;
  if (linkId) linkHandoff.markPending(linkId);

  const state = stateStore.issue(linkId);
  return { status: 302, headers: { Location: buildGoogleAuthorizeUrl(config, state) }, body: "" };
}

export interface GoogleAuthCallbackDeps {
  config: GoogleOAuthConfig;
  stateStore: StateStore;
  linkHandoff: LinkHandoffStore;
  db: DbClient;
  fetchFn?: FetchLike;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function resultPage(status: number, title: string, message: string): HttpResponse {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RiftSight — ${escapeHtml(title)}</title>
  <style>body{font:16px/1.5 -apple-system,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#222}</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
  return htmlResponse(status, html);
}

export async function handleGoogleAuthCallback(req: HttpRequest, deps: GoogleAuthCallbackDeps): Promise<HttpResponse> {
  const url = new URL(req.url, "http://placeholder");

  if (url.searchParams.get("error")) {
    return resultPage(400, "Could not connect", "Google authorization was denied. You can close this tab and try again from the extension.");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return resultPage(400, "Could not connect", "Missing authorization code or state.");
  }

  const consumed = deps.stateStore.consume(state);
  if (!consumed.valid) {
    return resultPage(400, "Could not connect", "This authorization link is invalid or has expired — please try connecting again from the extension.");
  }
  const linkId = consumed.linkId;

  const tokenResult = await exchangeGoogleCodeForToken(deps.config, code, deps.fetchFn);
  if ("error" in tokenResult) {
    return resultPage(400, "Could not connect", "Google authorization failed. Please try again.");
  }

  const channel = await fetchOwnYouTubeChannel(tokenResult.accessToken, deps.fetchFn);
  if ("error" in channel) {
    return resultPage(400, "Could not connect", "Could not look up your YouTube channel. Please try again.");
  }
  if ("noChannel" in channel) {
    if (linkId) deps.linkHandoff.markRejected(linkId);
    return resultPage(
      400,
      "No YouTube channel",
      "This Google account doesn't have a YouTube channel. Sign in with the Google account that owns your streaming channel and try again."
    );
  }

  const allowed = await isYouTubeAllowed(deps.db, channel.channelId);
  if (!allowed) {
    if (linkId) deps.linkHandoff.markRejected(linkId);
    return resultPage(403, "Not in the beta yet", "This YouTube channel isn't part of the RiftSight beta yet. Reach out if you'd like access.");
  }

  const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(deps.db, "youtube", channel.channelId, channel.title);

  if (linkId) {
    const credential = await issueProducerCredential(deps.db, broadcasterId);
    deps.linkHandoff.markReady(linkId, { credential, displayName: channel.title });
  }

  return resultPage(200, "Connected", `Connected as ${channel.title}. You can close this tab and return to the RiftSight extension.`);
}
