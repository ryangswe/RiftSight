// Cross-instance live-state fan-out — see docs/scaling-plan.md's "Stage 1"
// for the full problem this solves. server.ts's Session.viewers is a
// Set<WebSocket>, which by definition can't cross processes: a viewer
// connected to instance B has no way to see a producer update that arrived
// on instance A. A StateBus is the seam that lets it anyway, without
// server.ts needing to know whether it's talking to another process or not.
//
// One fixed global channel, not per-session subscribe/unsubscribe:
// sessions are created dynamically by whichever instance a producer or
// viewer first lands on (see server.ts's getSession), so no instance can
// know a session exists in order to subscribe to its own channel in
// advance. Embedding sessionId in every message instead sidesteps that
// entirely, and is trivial load at the scale this is built for (a handful
// of instances, dozens of concurrent sessions).
//
// createLocalStateBus() is the default everywhere — every real caller
// today (index.ts without REDIS_URL set) and every existing test omit
// RelayConfig.stateBus entirely and get a fresh one of these per server
// instance, which never leaves the process. That's what makes the no-Redis
// path provably identical to pre-Stage-1 behavior rather than merely
// "should be" — a message published here is delivered synchronously,
// in-process, to every current subscriber, the same shape of call server.ts
// already made directly before this module existed.

import type { OverlayState } from "@riftsight/protocol";

export type StateBusMessage =
  | { kind: "state"; sessionId: string; originInstanceId: string; state: OverlayState }
  | { kind: "state-expired"; sessionId: string; originInstanceId: string; emptyState: OverlayState }
  | { kind: "producer-claimed"; sessionId: string; originInstanceId: string };

export interface StateBus {
  /** Delivered to every current subscriber, including ones registered by the same instance that published — self-filtering by originInstanceId (if wanted) is the caller's job, not the bus's. This matches real Redis pub/sub semantics (a client subscribed to a channel receives its own PUBLISHes), so Local and Redis implementations behave identically from a caller's perspective. */
  publish(message: StateBusMessage): void;
  /** Returns an unsubscribe function that removes only this one handler — safe to call while other subscribers remain active (needed so closing one simulated "instance" in a test doesn't affect another sharing the same bus). */
  subscribe(handler: (message: StateBusMessage) => void): () => void;
}

export function createLocalStateBus(): StateBus {
  const handlers = new Set<(message: StateBusMessage) => void>();
  return {
    publish(message) {
      for (const handler of handlers) handler(message);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
