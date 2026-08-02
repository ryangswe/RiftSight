// "Log in with Twitch" — the authorization-code OAuth flow used ONLY to
// identify a broadcaster (their Twitch user_id/login) during account
// linking. This is a DIFFERENT Twitch Developer Console app registration
// (a Twitch API app, with its own Client ID + Client Secret) than the
// Twitch Extension's own Client ID + shared secret verified in
// twitch-jwt.ts — never confuse or reuse one for the other. See env.ts's
// RelayEnvConfig doc comment for all four distinct credential concepts in
// this codebase.
//
// Deliberately no PKCE: Twitch's documented authorize/token endpoints
// (https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/) do not
// accept or verify code_challenge/code_verifier at all — sending them
// would be inert, not defense in depth. `state` (CSRF protection) IS
// documented and used here; see state-store.ts.
//
// Zero scopes are requested — /oauth2/validate returns the token owner's
// user_id/login for ANY valid token regardless of granted scopes, and
// identity is all this flow needs (see validateTwitchToken below).
//
// The access/refresh token from a successful exchange is used once, right
// here, to resolve an identity, and is never persisted anywhere — this
// flow doesn't maintain an ongoing Twitch API session, so there is nothing
// to keep it for.

// Node 16 (this repo's pinned runtime) has no global fetch/Response —
// those only became built into Node around v18. node-fetch fills that gap;
// callers/tests can inject any function matching FetchLike instead of the
// real thing (e.g. a fake returning a real node-fetch Response).
import nodeFetch, { Response as NodeFetchResponse } from "node-fetch";

export interface TwitchOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TwitchTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string[];
  tokenType: string;
}

export interface TwitchIdentity {
  userId: string;
  login: string;
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<NodeFetchResponse>;

const defaultFetch: FetchLike = nodeFetch as unknown as FetchLike;

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

export function buildAuthorizeUrl(config: TwitchOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(
  config: TwitchOAuthConfig,
  code: string,
  fetchFn: FetchLike = defaultFetch
): Promise<TwitchTokenResponse | { error: string }> {
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

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string[];
    token_type?: string;
  };

  if (typeof data.access_token !== "string") {
    return { error: "token exchange response missing access_token" };
  }

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 0,
    scope: Array.isArray(data.scope) ? data.scope : [],
    tokenType: typeof data.token_type === "string" ? data.token_type : "bearer",
  };
}

/** Resolves the identity behind a just-issued access token. Per Twitch's docs, works for any valid token regardless of granted scopes — this is the only Twitch API call this flow needs. */
export async function validateTwitchToken(
  accessToken: string,
  fetchFn: FetchLike = defaultFetch
): Promise<TwitchIdentity | { error: string }> {
  let response: NodeFetchResponse;
  try {
    response = await fetchFn(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
  } catch (err) {
    return { error: `token validation request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { error: `token validation failed with status ${response.status}` };
  }

  const data = (await response.json()) as { user_id?: string; login?: string };
  if (typeof data.user_id !== "string" || typeof data.login !== "string") {
    return { error: "token validation response missing user_id/login" };
  }

  return { userId: data.user_id, login: data.login };
}
