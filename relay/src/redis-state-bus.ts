// Redis-backed StateBus for real multi-instance deployment — see
// state-bus.ts for the interface this implements and docs/scaling-plan.md
// for the broader problem. Requires TWO separate client connections: once a
// Redis connection issues SUBSCRIBE it can no longer issue other commands
// (PUBLISH included), so one connection is dedicated to publishing and a
// second, separate one to subscribing.
//
// Internally composes a LocalStateBus for in-process fan-out: the
// subscriber connection issues exactly one Redis SUBSCRIBE at construction
// time, and every incoming message is handed to the local bus, which is
// what lets N local `.subscribe()` calls share that one Redis subscription
// rather than each opening its own. publish() only calls PUBLISH on the
// dedicated publisher connection — it deliberately does NOT also feed the
// local bus directly. Real Redis pub/sub delivers a published message back
// to every client subscribed to that channel, including the same process's
// own subscriber connection, so relying on that round trip (rather than a
// local shortcut) keeps this implementation's actual behavior identical to
// what a genuinely different instance would see, matching StateBus's own
// documented "self-filtering is the caller's job" contract.

import type { OverlayState } from "@riftsight/protocol";
import type { Redis } from "ioredis";
import IORedis from "ioredis";
import { logEvent } from "./logging.js";
import { createLocalStateBus, type StateBus, type StateBusMessage } from "./state-bus.js";

/** Only the ioredis surface this module actually touches — lets tests inject a fake double without a real Redis (none available in this sandbox), mirroring twitch-extension/src/platform/relay-socket.ts's WebSocketLike precedent. */
export type RedisPubSubClient = Pick<Redis, "publish" | "subscribe" | "on" | "quit" | "set" | "get">;

/** One fixed channel for every session's traffic — see state-bus.ts's own header comment for why a per-session channel isn't viable (no instance can know a session exists in order to subscribe to its own channel in advance). */
const CHANNEL = "riftsight:state-bus";

/** Key prefix for the per-session latest-state snapshot (see StateBus.saveSnapshot) — one plain string key per session, expiry delegated to Redis itself via SET PX. */
const SNAPSHOT_KEY_PREFIX = "riftsight:state:";

export interface RedisStateBus extends StateBus {
  close(): Promise<void>;
}

export function createRedisStateBus(
  redisUrl: string,
  options: { createClient?: (url: string) => RedisPubSubClient } = {}
): RedisStateBus {
  const createClient = options.createClient ?? ((url: string) => new IORedis(url));
  const publisherClient = createClient(redisUrl);
  const subscriberClient = createClient(redisUrl);
  const local = createLocalStateBus();

  // Degradation contract (see docs/scaling-plan.md Stage 1): Redis being
  // down must never take the relay with it — an instance keeps serving its
  // local viewers from local state and simply stops hearing about the rest
  // of the fleet until Redis returns. Structurally that's already true
  // (every bus operation is fire-and-forget or null-on-failure); these
  // handlers make it true under error conditions too. Without an "error"
  // listener, ioredis's EventEmitter "error" events are UNCAUGHT exceptions
  // that terminate the process — a Redis blip would kill the relay, the
  // exact opposite of degrading. Log-only, deliberately: ioredis reconnects
  // (and re-issues the SUBSCRIBE) on its own; there is nothing else to do.
  for (const [role, client] of [
    ["publisher", publisherClient],
    ["subscriber", subscriberClient],
  ] as const) {
    client.on("error", (err: unknown) => {
      logEvent("redis_error", { reason: `${role}: ${err instanceof Error ? err.message : String(err)}` });
    });
    client.on("reconnecting", () => {
      logEvent("redis_reconnecting", { reason: role });
    });
  }

  // The initial SUBSCRIBE can itself fail (Redis unreachable at boot) —
  // logged, not fatal, and not left as a floating rejected promise. ioredis
  // queues the command until the connection is up and re-subscribes after
  // any reconnect, so a failure here is transient by construction.
  subscriberClient.subscribe(CHANNEL).catch((err: unknown) => {
    logEvent("redis_error", { reason: `subscribe-failed: ${err instanceof Error ? err.message : String(err)}` });
  });
  subscriberClient.on("message", (channel, message) => {
    if (channel !== CHANNEL) return;
    let parsed: StateBusMessage;
    try {
      parsed = JSON.parse(message) as StateBusMessage;
    } catch {
      return; // malformed payload on the channel — dropped, not thrown, mirroring server.ts's own malformed-JSON resilience
    }
    local.publish(parsed);
  });

  return {
    publish(message) {
      // Logged and dropped, never thrown/unhandled: StateBus.publish is a
      // synchronous fire-and-forget contract, and the callers (producer
      // message path, viewer-count reporting) must keep serving local
      // viewers even when the fleet can't hear them.
      publisherClient.publish(CHANNEL, JSON.stringify(message)).catch((err: unknown) => {
        logEvent("redis_error", { reason: `publish-failed: ${err instanceof Error ? err.message : String(err)}` });
      });
    },
    subscribe(handler) {
      return local.subscribe(handler);
    },
    // Both snapshot commands go through the publisher-role client — the
    // subscriber connection is in subscribe mode and Redis refuses every
    // other command on it (the same constraint that forces two clients in
    // the first place; see the module header).
    saveSnapshot(sessionId, state, ttlMs) {
      // Logged and dropped — a rejected SET on a Redis blip must not
      // become an unhandledRejection (fatal on the production Node image).
      publisherClient.set(SNAPSHOT_KEY_PREFIX + sessionId, JSON.stringify(state), "PX", ttlMs).catch((err: unknown) => {
        logEvent("redis_error", { reason: `snapshot-save-failed: ${err instanceof Error ? err.message : String(err)}` });
      });
    },
    async loadSnapshot(sessionId) {
      let raw: string | null;
      try {
        raw = await publisherClient.get(SNAPSHOT_KEY_PREFIX + sessionId);
      } catch (err: unknown) {
        // Redis unreachable — per the StateBus contract a snapshot is best-effort, so degrade to "none" rather than rejecting into admitViewer
        logEvent("redis_error", { reason: `snapshot-load-failed: ${err instanceof Error ? err.message : String(err)}` });
        return null;
      }
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as OverlayState;
      } catch {
        return null; // corrupt value under the key — same dropped-not-thrown posture as the pub/sub channel's malformed-payload handling above
      }
    },
    async close() {
      await Promise.all([publisherClient.quit(), subscriberClient.quit()]);
    },
  };
}
