// Environment-mode configuration: parses and validates process.env into a
// single typed, mode-aware config object. Pure (takes a plain env-like
// record, returns a result) so it's directly unit-testable without
// process.env side effects — index.ts is the only caller that reads the
// real process.env and exits the process on failure.
//
// Three modes:
// - "development": today's localhost workflow, unchanged — unauthenticated
//   local-debug viewer path stays available, missing secrets only warn.
// - "twitch-local-test": the existing manual-tunnel workflow — real Twitch
//   JWT auth is exercised, but local-debug diagnostics remain available
//   too (same as development for every check in this file).
// - "closed-beta": stable-deployment mode — local-debug is always
//   disabled regardless of ALLOW_LOCAL_DEBUG, and any secret registered in
//   REQUIRED_IN_CLOSED_BETA must be present or the process refuses to
//   start, rather than booting into a half-secure state.
//
// Later stages (OAuth linking, producer credentials, stable asset hosting)
// register their own required-in-closed-beta secrets in
// REQUIRED_IN_CLOSED_BETA as those subsystems are built, rather than each
// inventing its own separate "did I forget a secret" check.

export type RiftSightMode = "development" | "twitch-local-test" | "closed-beta";

const MODES: readonly RiftSightMode[] = ["development", "twitch-local-test", "closed-beta"];

export interface RelayEnvConfig {
  mode: RiftSightMode;
  port: number;
  twitchExtensionClientId: string | undefined;
  twitchExtensionSecret: string | undefined;
  allowLocalDebug: boolean;
  /** A libsql client URL — "file:./data/riftsight.db", ":memory:" (tests), or a remote "libsql://..."/"https://..." URL for a hosted DB later. */
  dbUrl: string;
  /**
   * Twitch API app credentials for the "Log in with Twitch" OAuth flow
   * used to identify a broadcaster during account linking. Deliberately a
   * DIFFERENT Developer Console app registration than the Twitch
   * Extension's own Client ID/shared secret (twitchExtensionClientId /
   * twitchExtensionSecret above) — four distinct credential concepts in
   * this codebase: the Twitch API Client Secret (this), the Twitch
   * Extension shared secret (twitch-jwt.ts), the Twitch Extension JWT
   * (viewer auth), and RiftSight's own producer credential (a later
   * stage). Never confuse or reuse one for another.
   */
  twitchApiClientId: string | undefined;
  twitchApiClientSecret: string | undefined;
  /** Must exactly match a redirect URI registered for the Twitch API app in the Developer Console. */
  twitchOAuthRedirectUri: string | undefined;
}

export interface EnvValidationSuccess {
  ok: true;
  config: RelayEnvConfig;
  warnings: string[];
}

export interface EnvValidationFailure {
  ok: false;
  errors: string[];
}

export type EnvValidationResult = EnvValidationSuccess | EnvValidationFailure;

/**
 * Env var names that must be non-empty in closed-beta mode or the process
 * refuses to start. Append to this list as each subsystem stage adds its
 * own required secret(s) — do not scatter separate missing-secret checks
 * elsewhere.
 */
export const REQUIRED_IN_CLOSED_BETA: readonly string[] = [
  "TWITCH_EXTENSION_SECRET",
  "TWITCH_API_CLIENT_ID",
  "TWITCH_API_CLIENT_SECRET",
  "TWITCH_OAUTH_REDIRECT_URI",
  // Every other mode is fine defaulting dbUrl to a relative ./data path —
  // that default is almost certainly wrong (ephemeral, wiped on every
  // container restart) for a real deployment, so closed-beta requires an
  // operator to consciously set it rather than silently inheriting the
  // dev-friendly default. See the dedicated :memory: rejection below too —
  // this required-var check alone wouldn't catch that specific case, since
  // ":memory:" is itself a non-empty, "set" value.
  "RIFTSIGHT_DB_PATH",
];

/**
 * A minimal, dependency-free https: URL check, for any env var that must
 * be a stable public origin — no localhost, no plain http:, no ws:/wss:.
 * Not yet wired to a specific env var in this stage (no origin-shaped var
 * exists here yet); later stages (OAuth redirect URI, stable asset/backend
 * origins) reuse this instead of re-implementing the check.
 */
export function requireHttpsUrl(value: string, varName: string): string | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: `${varName} must be a valid URL (got "${value}")` };
  }
  if (parsed.protocol !== "https:") {
    return { error: `${varName} must use https: (got "${parsed.protocol}")` };
  }
  return value;
}

function parseMode(raw: string | undefined): RiftSightMode | { error: string } {
  if (raw === undefined || raw === "") return "development";
  if ((MODES as readonly string[]).includes(raw)) return raw as RiftSightMode;
  return { error: `RIFTSIGHT_MODE must be one of ${MODES.join(", ")} (got "${raw}")` };
}

/**
 * Pure validation over a plain env-like record — never reads process.env
 * itself, so call sites can pass a synthetic record in tests.
 */
export function validateEnv(env: Record<string, string | undefined>): EnvValidationResult {
  const modeResult = parseMode(env["RIFTSIGHT_MODE"]);
  if (typeof modeResult !== "string") {
    return { ok: false, errors: [modeResult.error] };
  }
  const mode = modeResult;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Most hosting platforms (Fly.io, Railway, Render, Heroku-likes) inject a
  // PORT env var the process is expected to bind — checked first so a
  // deployed process listens where the platform's own proxy/load balancer
  // actually expects it. RELAY_PORT remains the local-dev-friendly override
  // (used throughout this README/scripts) when PORT isn't present.
  const port = Number(env["PORT"]) || Number(env["RELAY_PORT"]) || 8787;
  const twitchExtensionClientId = env["TWITCH_EXTENSION_CLIENT_ID"] || undefined;
  const twitchExtensionSecret = env["TWITCH_EXTENSION_SECRET"] || undefined;
  const dbUrl = env["RIFTSIGHT_DB_PATH"] || "file:./data/riftsight.db";
  const twitchApiClientId = env["TWITCH_API_CLIENT_ID"] || undefined;
  const twitchApiClientSecret = env["TWITCH_API_CLIENT_SECRET"] || undefined;
  const twitchOAuthRedirectUri = env["TWITCH_OAUTH_REDIRECT_URI"] || undefined;

  // Closed-beta hard-fails on any missing required secret instead of the
  // warn-only behavior every other mode keeps — booting with a feature
  // silently disabled is fine for local dev, not for a real deployment.
  if (mode === "closed-beta") {
    for (const name of REQUIRED_IN_CLOSED_BETA) {
      if (!env[name]) {
        errors.push(`${name} is required in closed-beta mode but is not set`);
      }
    }
    if (twitchOAuthRedirectUri) {
      const checked = requireHttpsUrl(twitchOAuthRedirectUri, "TWITCH_OAUTH_REDIRECT_URI");
      if (typeof checked !== "string") errors.push(checked.error);
    }
    // ":memory:" is a "set" value (passes the REQUIRED_IN_CLOSED_BETA loop
    // above) but is always ephemeral by definition — the one ephemeral-
    // storage case this code can actually detect and reject outright,
    // versus "is this file path on a mounted persistent volume," which it
    // can't know from here.
    if (dbUrl === ":memory:") {
      errors.push("RIFTSIGHT_DB_PATH must not be \":memory:\" in closed-beta mode — that data is lost on every restart.");
    }
  } else if (!twitchExtensionSecret) {
    warnings.push(
      "TWITCH_EXTENSION_SECRET is not set — every twitch-subscribe will be rejected until it is configured."
    );
  }

  // local-debug is a real security exposure once the relay is reachable
  // beyond localhost — closed-beta always disables it regardless of what
  // ALLOW_LOCAL_DEBUG says, so a stale dev-mode env var can't silently
  // leave it on in a real deployment. Only warn (not error) on an explicit
  // conflicting value — an unset var is expected and needs no comment.
  const rawAllowLocalDebug = env["ALLOW_LOCAL_DEBUG"];
  let allowLocalDebug = rawAllowLocalDebug !== "false";
  if (mode === "closed-beta" && allowLocalDebug) {
    if (rawAllowLocalDebug === "true") {
      warnings.push("ALLOW_LOCAL_DEBUG=true is ignored in closed-beta mode — local-debug is always disabled.");
    }
    allowLocalDebug = false;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      mode,
      port,
      twitchExtensionClientId,
      twitchExtensionSecret,
      allowLocalDebug,
      dbUrl,
      twitchApiClientId,
      twitchApiClientSecret,
      twitchOAuthRedirectUri,
    },
    warnings,
  };
}
