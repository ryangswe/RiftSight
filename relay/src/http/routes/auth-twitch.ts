// /auth/twitch/start and /auth/twitch/callback — the two routes that
// complete Twitch OAuth account linking (see auth/twitch-oauth.ts for the
// underlying exchange/validate mechanics and why there's no PKCE).
// Rejects closed-beta-ungated accounts here rather than deferring the
// check to producer-credential issuance, so "not part of the beta" is
// reported at the earliest possible point.
//
// If the extension is driving this (the normal closed-beta flow), it
// opens /auth/twitch/start?linkId=<its own generated id> and separately
// polls GET /api/link-status?linkId=... (producer-credential.ts route,
// added alongside this) until a credential is ready. A bare browser visit
// to /auth/twitch/start with no linkId still works for manual/dev linking
// — it just shows a plain success/failure page with no credential handoff.

import type { DbClient } from "../../db/client.js";
import { isAllowed } from "../../db/allowlist.js";
import { upsertBroadcaster } from "../../db/broadcasters.js";
import { issueProducerCredential } from "../../db/producer-credentials.js";
import type { StateStore } from "../../auth/state-store.js";
import type { LinkHandoffStore } from "../../auth/link-handoff.js";
import { buildAuthorizeUrl, exchangeCodeForToken, validateTwitchToken, type FetchLike, type TwitchOAuthConfig } from "../../auth/twitch-oauth.js";
import { htmlResponse, type HttpRequest, type HttpResponse } from "../types.js";

export function handleAuthStart(req: HttpRequest, config: TwitchOAuthConfig, stateStore: StateStore, linkHandoff: LinkHandoffStore): HttpResponse {
  const url = new URL(req.url, "http://placeholder");
  const linkId = url.searchParams.get("linkId") ?? undefined;
  if (linkId) linkHandoff.markPending(linkId);

  const state = stateStore.issue(linkId);
  const location = buildAuthorizeUrl(config, state);
  return { status: 302, headers: { Location: location }, body: "" };
}

export interface AuthCallbackDeps {
  config: TwitchOAuthConfig;
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

export async function handleAuthCallback(req: HttpRequest, deps: AuthCallbackDeps): Promise<HttpResponse> {
  const url = new URL(req.url, "http://placeholder");

  if (url.searchParams.get("error")) {
    return resultPage(400, "Could not connect", "Twitch authorization was denied. You can close this tab and try again from the extension.");
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

  const tokenResult = await exchangeCodeForToken(deps.config, code, deps.fetchFn);
  if ("error" in tokenResult) {
    return resultPage(400, "Could not connect", "Twitch authorization failed. Please try again.");
  }

  const identity = await validateTwitchToken(tokenResult.accessToken, deps.fetchFn);
  if ("error" in identity) {
    return resultPage(400, "Could not connect", "Could not verify your Twitch identity. Please try again.");
  }

  const allowed = await isAllowed(deps.db, identity.userId);
  if (!allowed) {
    return resultPage(403, "Not in the closed beta", "This Twitch account is not part of the RiftSight closed beta yet. Reach out if you'd like access.");
  }

  const broadcaster = await upsertBroadcaster(deps.db, identity.userId, identity.login);

  if (linkId) {
    const credential = await issueProducerCredential(deps.db, broadcaster.id);
    deps.linkHandoff.markReady(linkId, { credential, displayName: identity.login });
  }

  return resultPage(200, "Connected", `Connected as ${identity.login}. You can close this tab and return to the RiftSight extension.`);
}
