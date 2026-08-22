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
  /** Whether this tab was visible (its window's active tab) as of the last heartbeat — see content/inventory.ts's sendHeartbeat. Drives active-tab election when more than one RiftAtlas tab is open. */
  visible: boolean;
  /** Whether this tab's window had OS focus as of the last heartbeat. Only used to bump `lastActiveAt` (a tab gaining focus counts as "just switched to"); election itself keys off `visible` + `lastActiveAt`. */
  focused: boolean;
  /** When this tab most recently *became* active (visible-or-focused) — the "just switched to" moment, not merely the last heartbeat time. This is the tie-break for "most recently active" in electActiveTab: a tab focused long ago keeps an old value, so a tab the streamer just switched to wins. See computeLastActiveAt. */
  lastActiveAt: number;
}

/**
 * Next value for a record's `lastActiveAt`, given the previous record (if
 * any) and the tab's freshly-reported visible/focused state. Pure so the
 * transition rules are unit-testable.
 *
 * "Active" means visible-or-focused. The value is the moment the tab last
 * *transitioned into* active (so "most recently switched to" is meaningful
 * as a tie-break), not the moment of every heartbeat while it stays active:
 * - became active this heartbeat (wasn't before) → `now`
 * - still active, already was → keep the prior transition time
 * - not active now → keep whatever it last was (so the fallback "no visible
 *   tab" branch of election can still pick the most-recently-active hidden
 *   tab); 0 if it has never been active.
 */
export function computeLastActiveAt(prev: PresenceRecord | undefined, visible: boolean, focused: boolean, now: number): number {
  const active = visible || focused;
  const wasActive = prev ? prev.visible || prev.focused : false;
  if (active) return wasActive ? (prev?.lastActiveAt ?? now) : now;
  return prev?.lastActiveAt ?? 0;
}

/**
 * Picks the single RiftAtlas tab whose board state should actually reach the
 * relay when several tabs are open — the fix for streamers seeing a
 * background tab's board leak onto their stream (multiple tabs all published
 * over the one shared producer socket, last-writer-wins). Pure so it's
 * unit-testable with an injected `now`.
 *
 * Rules, in order:
 * - Ignore stale records (same STALE_TIMEOUT_MS threshold presenceStatus
 *   uses) — a closed/navigated-away tab must not keep winning.
 * - Exactly one live tab → it wins regardless of visibility. This preserves
 *   today's single-tab behavior, including the legitimate "OBS is capturing
 *   a backgrounded RiftAtlas tab while the streamer works elsewhere" case:
 *   with only one tab there's nothing to disambiguate.
 * - Otherwise prefer visible tabs; among the candidate pool, the greatest
 *   `lastActiveAt` (most recently switched to) wins, tie-broken by lowest
 *   tabId purely for determinism.
 */
export function electActiveTab(recordsByTab: ReadonlyMap<number, PresenceRecord>, now: number): number | undefined {
  const live: Array<[number, PresenceRecord]> = [];
  for (const entry of recordsByTab) {
    if (now - entry[1].lastHeartbeatAt <= STALE_TIMEOUT_MS) live.push(entry);
  }

  // A lone live tab falls into `pool = live` below and wins regardless of its
  // visibility, so the single-tab case (including OBS capturing a backgrounded
  // sole tab) needs no special-casing here.
  const visible = live.filter(([, record]) => record.visible);
  const pool = visible.length > 0 ? visible : live;

  let bestId: number | undefined;
  let bestActiveAt = -Infinity;
  for (const [tabId, record] of pool) {
    if (bestId === undefined || record.lastActiveAt > bestActiveAt || (record.lastActiveAt === bestActiveAt && tabId < bestId)) {
      bestId = tabId;
      bestActiveAt = record.lastActiveAt;
    }
  }
  return bestId;
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

/** What to show when the streamer's publishing intent is on but nothing is actually running yet — picks between the two reasons based on the most recently observed presence status. Shared by the popup and the content-script debug panel, which each track their own presence poll independently. */
export function idlePublishingMessage(status: PresenceStatus): string {
  return status === "no-riftatlas"
    ? "Publishing enabled — open RiftAtlas to continue"
    : "Publishing enabled — waiting for an active RiftAtlas game";
}
