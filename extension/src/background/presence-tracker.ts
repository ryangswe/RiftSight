// Thin chrome.*-touching glue around presence.ts's pure state — owns the
// actual per-tab Map and the one chrome.tabs.onRemoved cleanup hook.
// Deliberately not unit-tested itself (see auth.ts/background.ts for the
// same established convention: chrome.*-touching glue in this codebase is
// thin enough that the pure logic it calls is what's actually tested).

import {
  isPresenceGoneForAutoStop,
  mostRecentPresenceRecord,
  presenceStatus,
  type PresenceRecord,
  type PresenceStatus,
} from "./presence.js";

const recordsByTab = new Map<number, PresenceRecord>();

export function recordHeartbeat(tabId: number, boardDetected: boolean, publicCardCount: number, now: number): void {
  recordsByTab.set(tabId, { boardDetected, publicCardCount, lastHeartbeatAt: now });
}

export function getCurrentPresenceStatus(now: number): PresenceStatus {
  return presenceStatus(mostRecentPresenceRecord(recordsByTab), now);
}

/** See presence.ts's isPresenceGoneForAutoStop/AUTO_STOP_TIMEOUT_MS doc comments for why this is keyed off record age, not "no record". */
export function isCurrentlyGoneForAutoStop(now: number): boolean {
  return isPresenceGoneForAutoStop(mostRecentPresenceRecord(recordsByTab), now);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  recordsByTab.delete(tabId);
});
