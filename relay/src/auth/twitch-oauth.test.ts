import { Response } from "node-fetch";
import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getAppAccessToken,
  resolveTwitchUserIdByLogin,
  validateTwitchToken,
  type FetchLike,
} from "./twitch-oauth.js";

const config = { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "https://beta.example.com/auth/twitch/callback" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("buildAuthorizeUrl", () => {
  it("points at Twitch's real authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl(config, "some-state"));
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
  });

  it("includes response_type=code, client_id, redirect_uri, and state", () => {
    const url = new URL(buildAuthorizeUrl(config, "csrf-nonce-123"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("csrf-nonce-123");
  });

  it("requests zero scopes — identity only, via /oauth2/validate", () => {
    const url = new URL(buildAuthorizeUrl(config, "state"));
    expect(url.searchParams.get("scope")).toBe("");
  });

  it("never includes PKCE parameters — Twitch doesn't support them", () => {
    const url = new URL(buildAuthorizeUrl(config, "state"));
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  it("posts to Twitch's real token endpoint with the expected form body", async () => {
    const fetchFn: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe("https://id.twitch.tv/oauth2/token");
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("code")).toBe("auth-code-abc");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(config.redirectUri);
      return jsonResponse(200, {
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_in: 14124,
        scope: [],
        token_type: "bearer",
      });
    });

    const result = await exchangeCodeForToken(config, "auth-code-abc", fetchFn);
    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresIn: 14124,
      scope: [],
      tokenType: "bearer",
    });
  });

  it("returns an error for a non-ok response (e.g. an invalid/reused code)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(400, { error: "Bad Request" }));
    const result = await exchangeCodeForToken(config, "bad-code", fetchFn);
    expect("error" in result).toBe(true);
  });

  it("returns an error when the network request itself fails", async () => {
    const fetchFn: FetchLike = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await exchangeCodeForToken(config, "code", fetchFn);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("network down");
  });

  it("returns an error when the response is missing access_token", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(200, { token_type: "bearer" }));
    const result = await exchangeCodeForToken(config, "code", fetchFn);
    expect("error" in result).toBe(true);
  });
});

describe("validateTwitchToken", () => {
  it("gets Twitch's real validate endpoint with an OAuth-scheme Authorization header", async () => {
    const fetchFn: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe("https://id.twitch.tv/oauth2/validate");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("OAuth access-123");
      return jsonResponse(200, {
        client_id: "test-client-id",
        login: "juicykaraage",
        scopes: [],
        user_id: "141981764",
        expires_in: 5000000,
      });
    });

    const result = await validateTwitchToken("access-123", fetchFn);
    expect(result).toEqual({ userId: "141981764", login: "juicykaraage" });
  });

  it("returns an error for an invalid/expired token (401)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(401, { status: 401, message: "invalid access token" }));
    const result = await validateTwitchToken("expired", fetchFn);
    expect("error" in result).toBe(true);
  });

  it("returns an error when the response is missing user_id/login", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(200, { client_id: "x" }));
    const result = await validateTwitchToken("token", fetchFn);
    expect("error" in result).toBe(true);
  });
});

describe("getAppAccessToken", () => {
  it("posts a client_credentials grant to Twitch's real token endpoint", async () => {
    const fetchFn: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe("https://id.twitch.tv/oauth2/token");
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("grant_type")).toBe("client_credentials");
      return jsonResponse(200, { access_token: "app-token-abc", expires_in: 5000, token_type: "bearer" });
    });

    const result = await getAppAccessToken(config, fetchFn);
    expect(result).toEqual({ accessToken: "app-token-abc" });
  });

  it("returns an error for a non-ok response", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(401, { message: "invalid client" }));
    const result = await getAppAccessToken(config, fetchFn);
    expect("error" in result).toBe(true);
  });

  it("returns an error when the network request itself fails", async () => {
    const fetchFn: FetchLike = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await getAppAccessToken(config, fetchFn);
    expect("error" in result).toBe(true);
  });

  it("returns an error when the response is missing access_token", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(200, { token_type: "bearer" }));
    const result = await getAppAccessToken(config, fetchFn);
    expect("error" in result).toBe(true);
  });
});

describe("resolveTwitchUserIdByLogin", () => {
  function appTokenThenUsersFetch(usersHandler: (url: string) => Response): FetchLike {
    let call = 0;
    return async (url) => {
      call++;
      if (call === 1) {
        expect(url).toBe("https://id.twitch.tv/oauth2/token");
        return jsonResponse(200, { access_token: "app-token-abc", expires_in: 5000, token_type: "bearer" });
      }
      return usersHandler(url as string);
    };
  }

  it("gets an app token, then Helix's /users?login= with a Bearer token and Client-Id header", async () => {
    let usersUrl: string | undefined;
    let usersHeaders: Record<string, string> | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      if (url === "https://id.twitch.tv/oauth2/token") {
        return jsonResponse(200, { access_token: "app-token-abc", expires_in: 5000, token_type: "bearer" });
      }
      usersUrl = url;
      usersHeaders = init?.headers as Record<string, string>;
      return jsonResponse(200, { data: [{ id: "141981764", login: "juicykaraage", display_name: "JuicyKaraage" }] });
    };

    const result = await resolveTwitchUserIdByLogin(config, "juicykaraage", fetchFn);

    expect(result).toEqual({ status: "found", userId: "141981764", displayName: "JuicyKaraage" });
    expect(usersUrl).toBe("https://api.twitch.tv/helix/users?login=juicykaraage");
    expect(usersHeaders?.["Authorization"]).toBe("Bearer app-token-abc");
    expect(usersHeaders?.["Client-Id"]).toBe("test-client-id");
  });

  it("falls back to the numeric ID as displayName if the response is missing display_name", async () => {
    const fetchFn = appTokenThenUsersFetch(() => jsonResponse(200, { data: [{ id: "141981764", login: "juicykaraage" }] }));
    const result = await resolveTwitchUserIdByLogin(config, "juicykaraage", fetchFn);
    expect(result).toEqual({ status: "found", userId: "141981764", displayName: "141981764" });
  });

  it("URL-encodes the login", async () => {
    let usersUrl: string | undefined;
    const fetchFn: FetchLike = async (url) => {
      if (url === "https://id.twitch.tv/oauth2/token") {
        return jsonResponse(200, { access_token: "app-token-abc", expires_in: 5000, token_type: "bearer" });
      }
      usersUrl = url;
      return jsonResponse(200, { data: [] });
    };

    await resolveTwitchUserIdByLogin(config, "weird name", fetchFn);
    expect(usersUrl).toBe("https://api.twitch.tv/helix/users?login=weird%20name");
  });

  it("reports not-found for a login with no matching account, distinct from a request error", async () => {
    const fetchFn = appTokenThenUsersFetch(() => jsonResponse(200, { data: [] }));
    const result = await resolveTwitchUserIdByLogin(config, "no_such_user", fetchFn);
    expect(result).toEqual({ status: "not-found" });
  });

  it("propagates a failed app-token request as an error, without ever attempting the users lookup", async () => {
    const fetchFn: FetchLike = vi.fn(async () => jsonResponse(401, { message: "invalid client" }));
    const result = await resolveTwitchUserIdByLogin(config, "juicykaraage", fetchFn);
    expect(result.status).toBe("error");
    expect(fetchFn).toHaveBeenCalledTimes(1); // never reached the users endpoint
  });

  it("returns an error for a non-ok users response", async () => {
    const fetchFn = appTokenThenUsersFetch(() => jsonResponse(500, { message: "server error" }));
    const result = await resolveTwitchUserIdByLogin(config, "juicykaraage", fetchFn);
    expect(result.status).toBe("error");
  });
});
