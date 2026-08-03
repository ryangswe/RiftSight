import { Response } from "node-fetch";
import { describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForToken, validateTwitchToken, type FetchLike } from "./twitch-oauth.js";

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
