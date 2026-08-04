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

/**
 * How long a heartbeat can go missing before the relay connection is
 * proactively told to stop publishing to viewers (see background.ts's
 * maybeAutoStopOnGoneReceived) — distinct from, and deliberately much
 * longer than, STALE_TIMEOUT_MS above. STALE_TIMEOUT_MS only ever drives a
 * cheap, local popup-UI label; a false trigger here is visible to every
 * viewer of the stream (a flash of the overlay clearing then needing to
 * recover), so this stays conservative — long enough to ride out a
 * routine service-worker suspend/wake or a brief heartbeat hiccup, short
 * enough that viewers aren't staring at a stale board for many minutes
 * after the streamer actually left. The manual Stop-publishing path
 * already covers "the streamer knows they're leaving" instantly; this is
 * only a fallback for "forgot to stop" — see isCurrentlyGoneForAutoStop's
 * onRemoved counterpart in background.ts for the tab-closed case, which
 * doesn't wait out this timeout at all.
 */
export const AUTO_STOP_TIMEOUT_MS = 120_000;

/**
 * Distinct from checking `presenceStatus(record, now) === "stale"` at a
 * longer threshold: `record` being `undefined` means "no record has ever
 * been recorded, or the tracked tab was removed" — which can briefly and
 * legitimately happen right after an MV3 service-worker wakes from
 * suspension, before the very next heartbeat lands (usually within
 * HEARTBEAT_INTERVAL_MS). Treating "no record" the same as "record aged
 * past the timeout" would make a routine worker wake look identical to a
 * genuinely-gone tab and risk a false auto-stop. This only ever fires for
 * a record that actually exists and has visibly aged past the timeout.
 */
export function isPresenceGoneForAutoStop(record: PresenceRecord | undefined, now: number): boolean {
  if (!record) return false;
  return now - record.lastHeartbeatAt > AUTO_STOP_TIMEOUT_MS;
}

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
