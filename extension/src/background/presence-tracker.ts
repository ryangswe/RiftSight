// Thin chrome.*-touching glue around presence.ts's pure state — owns the
// actual per-tab Map and the one chrome.tabs.onRemoved cleanup hook.
// Deliberately not unit-tested itself (see auth.ts/background.ts for the
// same established convention: chrome.*-touching glue in this codebase is
// thin enough that the pure logic it calls is what's actually tested).

import {
  computeLastActiveAt,
  electActiveTab,
  isPresenceGoneForAutoStop,
  mostRecentPresenceRecord,
  presenceStatus,
  type PresenceRecord,
  type PresenceStatus,
} from "./presence.js";

const recordsByTab = new Map<number, PresenceRecord>();

export function recordHeartbeat(
  tabId: number,
  boardDetected: boolean,
  publicCardCount: number,
  visible: boolean,
  focused: boolean,
  now: number
): void {
  const lastActiveAt = computeLastActiveAt(recordsByTab.get(tabId), visible, focused, now);
  recordsByTab.set(tabId, { boardDetected, publicCardCount, lastHeartbeatAt: now, visible, focused, lastActiveAt });
}

/** The tab whose board state should currently reach the relay — see presence.ts's electActiveTab. `undefined` when no live RiftAtlas tab is known (nothing to publish). */
export function getActivePublisherTabId(now: number): number | undefined {
  return electActiveTab(recordsByTab, now);
}

/** Explicit removal so background.ts owns the single onRemoved handler (it needs to re-run election after a tab closes) — mirrors what the standalone listener below used to do, minus the ordering hazard of two independent onRemoved listeners racing. */
export function forgetTab(tabId: number): void {
  recordsByTab.delete(tabId);
}

export function getCurrentPresenceStatus(now: number): PresenceStatus {
  return presenceStatus(mostRecentPresenceRecord(recordsByTab), now);
}

/** See presence.ts's isPresenceGoneForAutoStop/AUTO_STOP_TIMEOUT_MS doc comments for why this is keyed off record age, not "no record". */
export function isCurrentlyGoneForAutoStop(now: number): boolean {
  return isPresenceGoneForAutoStop(mostRecentPresenceRecord(recordsByTab), now);
}
