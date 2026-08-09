import { describe, expect, it } from "vitest";
import { requireHttpsUrl, validateEnv } from "./env.js";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...overrides };
}

/** The full set of vars closed-beta mode requires — spread this into a test and override only what it's actually testing, so unrelated required-var checks don't make an unrelated test fail. */
function closedBetaRequiredVars(): Record<string, string> {
  return {
    TWITCH_EXTENSION_SECRET: "secret",
    TWITCH_API_CLIENT_ID: "id",
    TWITCH_API_CLIENT_SECRET: "secret",
    TWITCH_OAUTH_REDIRECT_URI: "https://beta.example.com/auth/twitch/callback",
    RIFTSIGHT_DB_PATH: "file:./data/test.db",
  };
}

describe("validateEnv", () => {
  it("defaults to development mode when RIFTSIGHT_MODE is unset", () => {
    const result = validateEnv(env());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.mode).toBe("development");
  });

  it("rejects an invalid RIFTSIGHT_MODE value", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("RIFTSIGHT_MODE");
  });

  it("development: missing TWITCH_EXTENSION_SECRET only warns, still starts", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "development" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes("TWITCH_EXTENSION_SECRET"))).toBe(true);
  });

  it("twitch-local-test: missing TWITCH_EXTENSION_SECRET only warns, still starts (same as development)", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "twitch-local-test" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes("TWITCH_EXTENSION_SECRET"))).toBe(true);
  });

  it("closed-beta: missing TWITCH_EXTENSION_SECRET refuses to start", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "closed-beta" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("TWITCH_EXTENSION_SECRET"))).toBe(true);
  });

  it("closed-beta: present TWITCH_EXTENSION_SECRET starts cleanly with no warning about it", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "closed-beta", ...closedBetaRequiredVars() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes("TWITCH_EXTENSION_SECRET"))).toBe(false);
  });

  it("closed-beta: ALLOW_LOCAL_DEBUG unset is silently forced false, no warning needed", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "closed-beta", ...closedBetaRequiredVars() }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.allowLocalDebug).toBe(false);
      expect(result.warnings.some((w) => w.includes("ALLOW_LOCAL_DEBUG"))).toBe(false);
    }
  });

  it("closed-beta: ALLOW_LOCAL_DEBUG=true is force-overridden to false, with a warning", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "closed-beta", ...closedBetaRequiredVars(), ALLOW_LOCAL_DEBUG: "true" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.allowLocalDebug).toBe(false);
      expect(result.warnings.some((w) => w.includes("ALLOW_LOCAL_DEBUG"))).toBe(true);
    }
  });

  it("development: ALLOW_LOCAL_DEBUG=false disables it (existing behavior preserved)", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "development", ALLOW_LOCAL_DEBUG: "false" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.allowLocalDebug).toBe(false);
  });

  it("development: ALLOW_LOCAL_DEBUG unset defaults to true (existing behavior preserved)", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "development" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.allowLocalDebug).toBe(true);
  });

  it("defaults RELAY_PORT to 8787 when unset or non-numeric", () => {
    expect((validateEnv(env()) as { ok: true; config: { port: number } }).config.port).toBe(8787);
    const result = validateEnv(env({ RELAY_PORT: "not-a-number" }));
    if (result.ok) expect(result.config.port).toBe(8787);
  });

  it("respects a valid custom RELAY_PORT", () => {
    const result = validateEnv(env({ RELAY_PORT: "9000" }));
    if (result.ok) expect(result.config.port).toBe(9000);
  });

  it("passes through TWITCH_EXTENSION_CLIENT_ID as-is", () => {
    const result = validateEnv(env({ TWITCH_EXTENSION_CLIENT_ID: "abc123" }));
    if (result.ok) expect(result.config.twitchExtensionClientId).toBe("abc123");
  });

  it("leaves redisUrl undefined when REDIS_URL is unset — single-instance behavior stays the default in every mode", () => {
    const result = validateEnv(env());
    if (result.ok) expect(result.config.redisUrl).toBeUndefined();
  });

  it("passes through REDIS_URL as-is when set", () => {
    const result = validateEnv(env({ REDIS_URL: "redis://localhost:6379" }));
    if (result.ok) expect(result.config.redisUrl).toBe("redis://localhost:6379");
  });

  it("defaults dbUrl to a local file path when unset", () => {
    const result = validateEnv(env());
    if (result.ok) expect(result.config.dbUrl).toBe("file:./data/riftsight.db");
  });

  it("respects a custom RIFTSIGHT_DB_PATH", () => {
    const result = validateEnv(env({ RIFTSIGHT_DB_PATH: ":memory:" }));
    if (result.ok) expect(result.config.dbUrl).toBe(":memory:");
  });

  it("development: missing OAuth vars only leaves them undefined, no error", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "development" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.twitchApiClientId).toBeUndefined();
      expect(result.config.twitchApiClientSecret).toBeUndefined();
      expect(result.config.twitchOAuthRedirectUri).toBeUndefined();
    }
  });

  it("closed-beta: missing TWITCH_API_CLIENT_ID/SECRET/TWITCH_OAUTH_REDIRECT_URI refuses to start", () => {
    const result = validateEnv(
      env({ RIFTSIGHT_MODE: "closed-beta", TWITCH_EXTENSION_SECRET: "secret", RIFTSIGHT_DB_PATH: "file:./data/test.db" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("TWITCH_API_CLIENT_ID"))).toBe(true);
      expect(result.errors.some((e) => e.includes("TWITCH_API_CLIENT_SECRET"))).toBe(true);
      expect(result.errors.some((e) => e.includes("TWITCH_OAUTH_REDIRECT_URI"))).toBe(true);
    }
  });

  it("closed-beta: a non-https TWITCH_OAUTH_REDIRECT_URI is rejected even when present", () => {
    const result = validateEnv(
      env({
        RIFTSIGHT_MODE: "closed-beta",
        TWITCH_EXTENSION_SECRET: "secret",
        TWITCH_API_CLIENT_ID: "id",
        TWITCH_API_CLIENT_SECRET: "secret",
        TWITCH_OAUTH_REDIRECT_URI: "http://beta.example.com/auth/twitch/callback",
        RIFTSIGHT_DB_PATH: "file:./data/test.db",
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("TWITCH_OAUTH_REDIRECT_URI"))).toBe(true);
  });

  it("closed-beta: a valid https TWITCH_OAUTH_REDIRECT_URI with all OAuth vars set boots cleanly", () => {
    const result = validateEnv(
      env({
        RIFTSIGHT_MODE: "closed-beta",
        TWITCH_EXTENSION_SECRET: "secret",
        TWITCH_API_CLIENT_ID: "id",
        TWITCH_API_CLIENT_SECRET: "secret",
        TWITCH_OAUTH_REDIRECT_URI: "https://beta.example.com/auth/twitch/callback",
        RIFTSIGHT_DB_PATH: "file:./data/test.db",
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.twitchOAuthRedirectUri).toBe("https://beta.example.com/auth/twitch/callback");
  });

  it("closed-beta: missing RIFTSIGHT_DB_PATH refuses to start", () => {
    const result = validateEnv(
      env({
        RIFTSIGHT_MODE: "closed-beta",
        TWITCH_EXTENSION_SECRET: "secret",
        TWITCH_API_CLIENT_ID: "id",
        TWITCH_API_CLIENT_SECRET: "secret",
        TWITCH_OAUTH_REDIRECT_URI: "https://beta.example.com/auth/twitch/callback",
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("RIFTSIGHT_DB_PATH"))).toBe(true);
  });

  it("closed-beta: RIFTSIGHT_DB_PATH=:memory: is rejected even though it's a non-empty, \"set\" value", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "closed-beta", ...closedBetaRequiredVars(), RIFTSIGHT_DB_PATH: ":memory:" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes(":memory:"))).toBe(true);
  });

  it("development: RIFTSIGHT_DB_PATH=:memory: is still fine — the rejection is closed-beta only", () => {
    const result = validateEnv(env({ RIFTSIGHT_MODE: "development", RIFTSIGHT_DB_PATH: ":memory:" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.dbUrl).toBe(":memory:");
  });

  it("PORT takes precedence over RELAY_PORT when both are set", () => {
    const result = validateEnv(env({ PORT: "3000", RELAY_PORT: "9000" }));
    if (result.ok) expect(result.config.port).toBe(3000);
  });

  it("development: an http TWITCH_OAUTH_REDIRECT_URI (e.g. localhost) is fine, not rejected", () => {
    const result = validateEnv(
      env({ RIFTSIGHT_MODE: "development", TWITCH_OAUTH_REDIRECT_URI: "http://localhost:8788/auth/twitch/callback" })
    );
    expect(result.ok).toBe(true);
  });
});

describe("requireHttpsUrl", () => {
  it("accepts a valid https URL", () => {
    expect(requireHttpsUrl("https://beta.example.com", "TEST_VAR")).toBe("https://beta.example.com");
  });

  it("rejects a plain http URL", () => {
    const result = requireHttpsUrl("http://beta.example.com", "TEST_VAR");
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") expect(result.error).toContain("TEST_VAR");
  });

  it("rejects a ws:// URL", () => {
    const result = requireHttpsUrl("ws://beta.example.com", "TEST_VAR");
    expect(typeof result).not.toBe("string");
  });

  it("rejects a malformed URL", () => {
    const result = requireHttpsUrl("not a url", "TEST_VAR");
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") expect(result.error).toContain("valid URL");
  });
});
