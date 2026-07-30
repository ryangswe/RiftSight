// Relay-only. Never imported by any frontend (extension, debug-viewer,
// twitch-extension) — TWITCH_EXTENSION_SECRET must never ship to a
// browser, and this module is the only place that ever touches it.

import jwt from "jsonwebtoken";

export interface TwitchJwtClaims {
  channel_id: string;
  role: string;
  opaque_user_id: string;
  user_id: string | undefined;
  exp: number;
}

export type VerifyTwitchJwtResult = { claims: TwitchJwtClaims } | { error: string };

/**
 * Verifies a Twitch Extension JWT against the extension's shared secret.
 * Twitch issues the secret base64-encoded (from the Developer Console) —
 * it must be base64-decoded into raw bytes before use as the HMAC key.
 * Passing the base64 *string* straight to jsonwebtoken silently verifies
 * against the wrong key and every token fails; this is a well-documented
 * gotcha, confirmed against Twitch's own EBS tutorial code before writing
 * this (see https://dev.twitch.tv/docs/tutorials/extension-101-tutorial-series/jwt/).
 * `algorithms: ["HS256"]` is pinned explicitly rather than trusting
 * whatever `alg` the token's own header claims — standard hardening
 * against algorithm-confusion attacks, not something Twitch's docs call
 * out but a jsonwebtoken best practice regardless.
 */
export function verifyTwitchJwt(token: string, base64Secret: string): VerifyTwitchJwtResult {
  const secretBytes = Buffer.from(base64Secret, "base64");

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secretBytes, { algorithms: ["HS256"] });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "invalid token" };
  }

  if (typeof decoded !== "object" || decoded === null) {
    return { error: "unexpected JWT payload shape" };
  }

  const claims = decoded as Record<string, unknown>;
  if (
    typeof claims["channel_id"] !== "string" ||
    typeof claims["role"] !== "string" ||
    typeof claims["opaque_user_id"] !== "string"
  ) {
    return { error: "JWT missing required claims (channel_id/role/opaque_user_id)" };
  }

  return {
    claims: {
      channel_id: claims["channel_id"],
      role: claims["role"],
      opaque_user_id: claims["opaque_user_id"],
      user_id: typeof claims["user_id"] === "string" ? claims["user_id"] : undefined,
      exp: typeof claims["exp"] === "number" ? claims["exp"] : 0,
    },
  };
}
