// Short-lived, single-use tracking for the OAuth `state` CSRF nonce
// (https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/ —
// "strongly encouraged to pass a state string to help prevent Cross-Site
// Request Forgery attacks"). In-memory only: a beta-scale, single-instance
// deployment doesn't need this surviving a restart, and a nonce is
// meaningless once its issuing process is gone anyway. Clock is injectable
// so expiry is testable without real timers.
//
// Also carries an optional opaque `linkId` payload through the round trip:
// Twitch only ever echoes back `code`/`state` on the callback (a
// registered redirect_uri must exact-match, so it can't itself carry a
// dynamic id) — `state` is the only value that survives the trip
// unmodified, so it's what the extension's own linkId (see
// link-handoff.ts) rides along on. `state` itself is still a fresh,
// backend-generated nonce, not the linkId directly, keeping "prove this
// callback matches a request we issued" and "which extension polling
// session does this belong to" as distinct concepts sharing one lookup.

import { randomUUID } from "node:crypto";

export interface ConsumeResult {
  valid: boolean;
  linkId: string | undefined;
}

export interface StateStore {
  /** Generates, records, and returns a new single-use state value; optionally associates a linkId to be handed back on consume(). */
  issue(linkId?: string): string;
  /** Consumes the value (single-use, regardless of outcome). valid is false for an unknown, already-used, or expired state. */
  consume(state: string): ConsumeResult;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — ample for a user to complete the Twitch consent screen

interface Entry {
  issuedAt: number;
  linkId: string | undefined;
}

export function createStateStore(options: { ttlMs?: number; now?: () => number; randomState?: () => string } = {}): StateStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const randomState = options.randomState ?? (() => randomUUID());

  const entries = new Map<string, Entry>();

  return {
    issue(linkId?: string): string {
      const state = randomState();
      entries.set(state, { issuedAt: now(), linkId });
      return state;
    },
    consume(state: string): ConsumeResult {
      const entry = entries.get(state);
      if (entry === undefined) return { valid: false, linkId: undefined };
      entries.delete(state); // single-use regardless of outcome — a state value is never valid twice
      const valid = now() - entry.issuedAt <= ttlMs;
      return { valid, linkId: valid ? entry.linkId : undefined };
    },
  };
}
