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

import type { Redis } from "ioredis";
import IORedis from "ioredis";
import { createLocalStateBus, type StateBus, type StateBusMessage } from "./state-bus.js";

/** Only the ioredis surface this module actually touches — lets tests inject a fake double without a real Redis (none available in this sandbox), mirroring twitch-extension/src/platform/relay-socket.ts's WebSocketLike precedent. */
export type RedisPubSubClient = Pick<Redis, "publish" | "subscribe" | "on" | "quit">;

/** One fixed channel for every session's traffic — see state-bus.ts's own header comment for why a per-session channel isn't viable (no instance can know a session exists in order to subscribe to its own channel in advance). */
const CHANNEL = "riftsight:state-bus";

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

  subscriberClient.subscribe(CHANNEL);
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
      publisherClient.publish(CHANNEL, JSON.stringify(message));
    },
    subscribe(handler) {
      return local.subscribe(handler);
    },
    async close() {
      await Promise.all([publisherClient.quit(), subscriberClient.quit()]);
    },
  };
}
