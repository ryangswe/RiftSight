// Centralizes every closed-beta rate/size limit as a named constant rather
// than scattering magic numbers across server.ts/http/server.ts — the
// milestone spec calls this out explicitly. Every limit here is set
// generously (see each comment) so normal RiftAtlas use is never affected;
// they exist to bound worst-case behavior (a runaway or malicious
// producer, a slow viewer, a hammered OAuth endpoint), not to throttle
// legitimate traffic.

/** A single overlay-state message's serialized JSON size, in bytes. RiftAtlas states are pure text (urls/ids/numbers, no embedded images) — even a maximal board easily fits in a few KB; this generously allows well beyond that. */
export const MAX_MESSAGE_BYTES = 262_144; // 256 KiB

/** Cards in a single OverlayState snapshot. A Card One/RiftAtlas board realistically never has more than a few dozen cards across every zone combined. */
export const MAX_CARDS_PER_SNAPSHOT = 200;

/** Accepted overlay-state messages per producer connection, per second. The extension's own settle-loop/dedup already publishes far below this in normal use (see card-observer.ts / publisher.ts's fingerprint dedup) — this is a hard backstop against a runaway or misbehaving producer, not a normal-use throttle. */
export const MAX_PRODUCER_UPDATES_PER_SECOND = 20;

/** Consecutive messages from one socket that fail validation (malformed JSON, schema mismatch, oversized, too many cards) before the relay disconnects it outright. Not triggered by a single isolated bad message — only a sustained run, which existing tests exercise (a malformed message followed by a valid one must still succeed). */
export const MAX_CONSECUTIVE_INVALID_MESSAGES = 20;

/** subscribe/twitch-subscribe attempts a single viewer socket may make before being disconnected. A legitimate viewer subscribes once (occasionally a handful of times, e.g. retrying after a token refresh) — this bounds a socket hammering the relay with bad channel/token guesses. */
export const MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET = 20;

/** Outbound send-buffer size (ws's own `bufferedAmount`), in bytes, at which a viewer is treated as a chronically slow consumer and disconnected rather than left to accumulate unbounded backpressure. */
export const MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024; // 4 MiB

/** GET /auth/twitch/start attempts per source IP, per window. Generous — a real streamer clicks "Connect Twitch" at most a handful of times per session. */
export const OAUTH_START_LIMIT = { maxEvents: 20, windowMs: 60_000 };

/** POST /api/producer-credential/rotate attempts per source IP, per window. */
export const CREDENTIAL_ROTATE_LIMIT = { maxEvents: 10, windowMs: 60_000 };

/** GET /api/producer-credential/status attempts per source IP, per window. The extension only calls this after a WS connection failure it can't otherwise diagnose (see background.ts), never continuously — generous, but real, to bound a client stuck in a fast reconnect loop. */
export const PRODUCER_STATUS_LIMIT = { maxEvents: 20, windowMs: 60_000 };

/** GET/POST/DELETE /api/youtube-channel attempts per source IP, per window. A streamer sets or clears their claimed channel a handful of times ever; the popup reads it once per open. */
export const YOUTUBE_CHANNEL_LIMIT = { maxEvents: 20, windowMs: 60_000 };

/**
 * WebSocket upgrade acceptances per client IP, per window — the first
 * connection-level limit in this codebase (every earlier limit was
 * per-socket or per-HTTP-route), added alongside the public
 * youtube-subscribe path since that's the first surface where arbitrary
 * anonymous browsers open sockets. Generous: a legitimate viewer opens one
 * socket (plus occasional backoff reconnects, capped at ~6/min by
 * RelaySocket's 10s max backoff), and a streamer's producer adds one more —
 * 60/min bounds a connection-storming client without ever touching real
 * use. Keyed on the first X-Forwarded-For hop when present (Railway's
 * proxy sets it; keying on the raw socket address there would lump every
 * viewer behind the LB into one bucket), falling back to the socket
 * address for direct/local connections.
 */
export const WS_CONNECTION_LIMIT = { maxEvents: 60, windowMs: 60_000 };

export interface RateLimiter {
  /** Records one event for `key` and returns whether it's within the limit (true = allowed, false = over limit — caller should reject/drop/disconnect). */
  tryConsume(key: string): boolean;
}

interface Window {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window counter, keyed by an arbitrary string (a source IP, or a
 * constant key for a limiter already scoped to one connection). Not a
 * sliding-window/token-bucket — simpler, and adequate at this scale
 * (3-10 streamers); a burst right at a window boundary can allow up to 2x
 * maxEvents in the worst case, an acceptable tradeoff here for the added
 * complexity a true sliding window would need.
 */
export function createRateLimiter(options: { maxEvents: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, Window>();

  return {
    tryConsume(key: string): boolean {
      const current = now();
      const existing = windows.get(key);
      if (!existing || current - existing.windowStart >= options.windowMs) {
        windows.set(key, { count: 1, windowStart: current });
        return true;
      }
      if (existing.count >= options.maxEvents) return false;
      existing.count += 1;
      return true;
    },
  };
}

/** Byte length of a message as UTF-8 — matches what actually crosses the wire, not JS string .length (which undercounts multi-byte characters). */
export function messageByteLength(raw: string): number {
  return Buffer.byteLength(raw, "utf8");
}

/** Split out as a pure, directly-testable predicate — server.ts calls this with a real WebSocket's own `bufferedAmount`, which isn't practical to drive deterministically in a fast unit test. */
export function isSlowConsumer(bufferedAmount: number): boolean {
  return bufferedAmount > MAX_OUTBOUND_QUEUE_BYTES;
}
