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

// Two kinds of traffic, both fire-and-forget observations (not commands):
// producer state fan-out and per-instance viewer-count reports. Earlier
// drafts of Stage 1 also carried "state-expired" and "producer-claimed"
// kinds for cross-instance expiry coordination, which turned out to be
// pure liability — an instance crash lost the authority flag forever
// (stale state on every other instance), and the claim message had no
// fencing (split-brain under producer reconnect races). Expiry is now
// purely local: every instance tracks lastUpdatedAt for its own copy (set
// by local producer writes and bus-received state alike) and expires that
// copy on its own timer — no coordination messages needed.
//
// "viewer-count" reports how many viewer sockets originInstanceId itself
// holds for the session — published on every local change and as a
// periodic heartbeat while nonzero, so receivers can treat silence as
// death: an instance that stops heartbeating (crash, network partition)
// simply ages out of everyone's remote-count table instead of leaving a
// count frozen in place forever (see server.ts's remoteViewerCounts).
export type StateBusMessage =
  | { kind: "state"; sessionId: string; originInstanceId: string; state: OverlayState }
  | { kind: "viewer-count"; sessionId: string; originInstanceId: string; count: number };

export interface StateBus {
  /** Delivered to every current subscriber, including ones registered by the same instance that published — self-filtering by originInstanceId (if wanted) is the caller's job, not the bus's. This matches real Redis pub/sub semantics (a client subscribed to a channel receives its own PUBLISHes), so Local and Redis implementations behave identically from a caller's perspective. */
  publish(message: StateBusMessage): void;
  /** Returns an unsubscribe function that removes only this one handler — safe to call while other subscribers remain active (needed so closing one simulated "instance" in a test doesn't affect another sharing the same bus). */
  subscribe(handler: (message: StateBusMessage) => void): () => void;
  /**
   * Persists the latest state for a session so an instance that wasn't
   * subscribed when it was published (freshly started/restarted — routine
   * during rolling deploys) can still serve it to a newly-admitted viewer
   * instead of a blank overlay. Pub/sub alone can't cover that case: a
   * message published before an instance existed is simply gone. Called on
   * every accepted producer update, overwriting the previous snapshot;
   * fire-and-forget by design (never throws/rejects into the producer
   * path — an implementation logs and drops on storage failure).
   * ttlMs bounds how long a snapshot outlives its last write, mirroring
   * the sweep's own STATE_TTL_MS so a dead producer's final board can't
   * be handed to viewers indefinitely.
   */
  saveSnapshot(sessionId: string, state: OverlayState, ttlMs: number): void;
  /** Returns the last saveSnapshot state for the session, or null if none was ever saved, the last one's TTL has lapsed, or the store is unreachable (never rejects — a snapshot is best-effort recovery, not critical path). */
  loadSnapshot(sessionId: string): Promise<OverlayState | null>;
}

export function createLocalStateBus(): StateBus {
  const handlers = new Set<(message: StateBusMessage) => void>();
  // Lives on the bus (not the server instance) deliberately: two simulated
  // "instances" sharing one LocalStateBus in a test then also share the
  // snapshot store, exactly as two real instances share one Redis — which
  // is what makes the shared-bus tests a faithful model of the Redis
  // topology. For the real single-instance no-REDIS_URL deployment (a
  // private bus per server) it's redundant with Session.latestState but
  // harmless: a few kilobytes per active session, expired on read.
  const snapshots = new Map<string, { state: OverlayState; savedAt: number; ttlMs: number }>();
  return {
    publish(message) {
      for (const handler of handlers) handler(message);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    saveSnapshot(sessionId, state, ttlMs) {
      snapshots.set(sessionId, { state, savedAt: Date.now(), ttlMs });
    },
    loadSnapshot(sessionId) {
      const entry = snapshots.get(sessionId);
      if (!entry) return Promise.resolve(null);
      if (Date.now() - entry.savedAt > entry.ttlMs) {
        snapshots.delete(sessionId); // expired — drop it so the map can't grow unbounded on dead sessions
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.state);
    },
  };
}
