// Pure RiftAtlas presence state — deliberately DOM/chrome.*-free so it's
// directly unit-testable, matching this repo's established "pure logic
// tested, browser/chrome.*-touching glue thin" split (see link-state.ts
// for the same pattern applied to account linking). presence-tracker.ts
// is the thin glue that actually records heartbeats and answers queries;
// this module only owns what "stale" means and how to derive a status
// from a record.
//
// Staleness is deliberately NOT driven by an active timer in the
// background worker — an MV3 service worker's own timers can't be
// trusted to keep running (the worker itself can be suspended), so
// "stale" is instead a pure function of "how long ago was the last
// heartbeat," evaluated lazily whenever presence is actually queried.
// There is nothing to resume or re-arm across a suspend/wake cycle
// because nothing was ever running in the first place.

export type PresenceStatus = "no-riftatlas" | "present-no-board" | "active" | "stale";

/** How often the content script sends a heartbeat while it's alive — see content/inventory.ts. Also referenced here (not just there) so this module's own doc comments/tests can reason about the relationship between the two constants below. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** No heartbeat for longer than this and a previously-known tab is considered stale — roughly 3x HEARTBEAT_INTERVAL_MS, tolerating a couple of missed beats (a suspended/waking service worker, a slow tab) before concluding the content script is actually gone, not just running a little behind. */
export const STALE_TIMEOUT_MS = 15_000;

export interface PresenceRecord {
  boardDetected: boolean;
  publicCardCount: number;
  lastHeartbeatAt: number;
}

/** Derives the current four-way status from the last known record and the current time — pure, so a test can pass any `now` without needing real timers. `record` is `undefined` exactly when no heartbeat has ever been recorded (or the tracked tab was explicitly removed — see presence-tracker.ts). */
export function presenceStatus(record: PresenceRecord | undefined, now: number): PresenceStatus {
  if (!record) return "no-riftatlas";
  if (now - record.lastHeartbeatAt > STALE_TIMEOUT_MS) return "stale";
  return record.boardDetected ? "active" : "present-no-board";
}

/** Picks whichever tracked tab most recently heartbeated. A streamer realistically has one relevant RiftAtlas tab open at a time; if more than one somehow exists (multiple tabs, or a leftover record briefly overlapping a new one), "most recently heard from" is the only sane tie-break — this deliberately does not attempt to merge or reconcile multiple tabs' presence. */
export function mostRecentPresenceRecord(recordsByTab: ReadonlyMap<number, PresenceRecord>): PresenceRecord | undefined {
  let mostRecent: PresenceRecord | undefined;
  for (const record of recordsByTab.values()) {
    if (!mostRecent || record.lastHeartbeatAt > mostRecent.lastHeartbeatAt) mostRecent = record;
  }
  return mostRecent;
}

export const PRESENCE_STATUS_LABEL: Record<PresenceStatus, string> = {
  "no-riftatlas": "Open RiftAtlas to begin",
  "present-no-board": "RiftAtlas is open, but no active game is detected",
  active: "RiftAtlas detected",
  stale: "Lost contact with RiftAtlas — reconnecting",
};
