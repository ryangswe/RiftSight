import { describe, expect, it } from "vitest";
import {
  AUTO_STOP_TIMEOUT_MS,
  computeLastActiveAt,
  electActiveTab,
  isPresenceGoneForAutoStop,
  mostRecentPresenceRecord,
  presenceStatus,
  STALE_TIMEOUT_MS,
  type PresenceRecord,
} from "./presence.js";

/** Builds a PresenceRecord with sane defaults, so each test only spells out the fields it cares about. */
function rec(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    boardDetected: true,
    publicCardCount: 1,
    lastHeartbeatAt: 1_000,
    visible: true,
    focused: true,
    lastActiveAt: 1_000,
    ...overrides,
  };
}

describe("presenceStatus", () => {
  it("is no-riftatlas when no record has ever been seen", () => {
    expect(presenceStatus(undefined, 1_000)).toBe("no-riftatlas");
  });

  it("is active when a board is detected and the heartbeat is fresh", () => {
    expect(presenceStatus(rec({ boardDetected: true, publicCardCount: 3 }), 1_000)).toBe("active");
  });

  it("is present-no-board when no board is detected but the heartbeat is fresh", () => {
    expect(presenceStatus(rec({ boardDetected: false, publicCardCount: 0 }), 1_000)).toBe("present-no-board");
  });

  it("is still active/present-no-board exactly at the stale boundary (not yet stale)", () => {
    expect(presenceStatus(rec({ boardDetected: true }), 1_000 + STALE_TIMEOUT_MS)).toBe("active");
  });

  it("becomes stale the instant it exceeds the timeout, regardless of board/card state", () => {
    const withBoard = rec({ boardDetected: true, publicCardCount: 5 });
    const withoutBoard = rec({ boardDetected: false, publicCardCount: 0 });
    expect(presenceStatus(withBoard, 1_000 + STALE_TIMEOUT_MS + 1)).toBe("stale");
    expect(presenceStatus(withoutBoard, 1_000 + STALE_TIMEOUT_MS + 1)).toBe("stale");
  });
});

describe("isPresenceGoneForAutoStop", () => {
  it("is false when no record exists — must not look identical to a genuinely-gone tab right after a service-worker wake", () => {
    expect(isPresenceGoneForAutoStop(undefined, 1_000)).toBe(false);
  });

  it("is false for a record aged exactly at the timeout (not yet gone)", () => {
    expect(isPresenceGoneForAutoStop(rec(), 1_000 + AUTO_STOP_TIMEOUT_MS)).toBe(false);
  });

  it("is false for a record well within the timeout, regardless of board state", () => {
    expect(isPresenceGoneForAutoStop(rec({ boardDetected: false, publicCardCount: 0 }), 1_000 + AUTO_STOP_TIMEOUT_MS - 1)).toBe(false);
  });

  it("is true the instant a record ages past the timeout", () => {
    expect(isPresenceGoneForAutoStop(rec({ boardDetected: true, publicCardCount: 5 }), 1_000 + AUTO_STOP_TIMEOUT_MS + 1)).toBe(true);
  });

  it("uses a materially longer threshold than STALE_TIMEOUT_MS — a record that's merely 'stale' for the popup UI must not be 'gone' for auto-stop purposes", () => {
    expect(isPresenceGoneForAutoStop(rec(), 1_000 + STALE_TIMEOUT_MS + 1)).toBe(false);
  });
});

describe("mostRecentPresenceRecord", () => {
  it("returns undefined for an empty map", () => {
    expect(mostRecentPresenceRecord(new Map())).toBeUndefined();
  });

  it("returns the only record when there's one tab", () => {
    const record = rec();
    expect(mostRecentPresenceRecord(new Map([[1, record]]))).toBe(record);
  });

  it("picks whichever tab heartbeated most recently", () => {
    const older = rec({ lastHeartbeatAt: 1_000 });
    const newer = rec({ boardDetected: false, publicCardCount: 0, lastHeartbeatAt: 5_000 });
    const map = new Map([
      [1, older],
      [2, newer],
    ]);
    expect(mostRecentPresenceRecord(map)).toBe(newer);
  });
});

describe("computeLastActiveAt", () => {
  it("stamps `now` when a tab has never been seen and is active", () => {
    expect(computeLastActiveAt(undefined, true, false, 5_000)).toBe(5_000);
  });

  it("is 0 when a tab has never been seen and is not active", () => {
    expect(computeLastActiveAt(undefined, false, false, 5_000)).toBe(0);
  });

  it("stamps `now` on the transition from inactive to active", () => {
    const prev = rec({ visible: false, focused: false, lastActiveAt: 0 });
    expect(computeLastActiveAt(prev, true, false, 9_000)).toBe(9_000);
  });

  it("keeps the original transition time while a tab stays active (does not bump every heartbeat)", () => {
    const prev = rec({ visible: true, focused: true, lastActiveAt: 2_000 });
    expect(computeLastActiveAt(prev, true, true, 9_000)).toBe(2_000);
  });

  it("focus alone (not visible) still counts as active and stamps the transition", () => {
    const prev = rec({ visible: false, focused: false, lastActiveAt: 0 });
    expect(computeLastActiveAt(prev, false, true, 7_000)).toBe(7_000);
  });

  it("remembers the last-active time after a tab goes inactive (for the no-visible-tab fallback)", () => {
    const prev = rec({ visible: true, focused: true, lastActiveAt: 3_000 });
    expect(computeLastActiveAt(prev, false, false, 9_000)).toBe(3_000);
  });
});

describe("electActiveTab", () => {
  it("returns undefined when no tab is known", () => {
    expect(electActiveTab(new Map(), 1_000)).toBeUndefined();
  });

  it("returns the only live tab regardless of visibility (preserves single-tab / OBS-captures-a-backgrounded-tab behavior)", () => {
    const map = new Map([[7, rec({ visible: false, focused: false, lastHeartbeatAt: 1_000, lastActiveAt: 0 })]]);
    expect(electActiveTab(map, 1_000)).toBe(7);
  });

  it("ignores stale tabs, falling back to the only remaining live one", () => {
    const map = new Map([
      [1, rec({ lastHeartbeatAt: 1_000, visible: true })],
      [2, rec({ lastHeartbeatAt: 100_000, visible: false, focused: false })],
    ]);
    // Tab 1 is well past STALE_TIMEOUT_MS at now=100_000, so only tab 2 is live.
    expect(electActiveTab(map, 100_000)).toBe(2);
  });

  it("returns undefined when every tab is stale", () => {
    const map = new Map([[1, rec({ lastHeartbeatAt: 1_000 })]]);
    expect(electActiveTab(map, 1_000 + STALE_TIMEOUT_MS + 1)).toBeUndefined();
  });

  it("prefers the visible tab over a hidden one when several are live", () => {
    const now = 10_000;
    const map = new Map([
      [1, rec({ lastHeartbeatAt: now, visible: false, focused: false, lastActiveAt: 9_999 })],
      [2, rec({ lastHeartbeatAt: now, visible: true, focused: true, lastActiveAt: 5_000 })],
    ]);
    expect(electActiveTab(map, now)).toBe(2);
  });

  it("among multiple visible tabs, picks the most recently activated (the one just switched to)", () => {
    const now = 10_000;
    const map = new Map([
      [1, rec({ lastHeartbeatAt: now, visible: true, lastActiveAt: 4_000 })],
      [2, rec({ lastHeartbeatAt: now, visible: true, lastActiveAt: 8_000 })],
    ]);
    expect(electActiveTab(map, now)).toBe(2);
  });

  it("when no tab is visible, falls back to the most recently active hidden tab", () => {
    const now = 10_000;
    const map = new Map([
      [1, rec({ lastHeartbeatAt: now, visible: false, focused: false, lastActiveAt: 4_000 })],
      [2, rec({ lastHeartbeatAt: now, visible: false, focused: false, lastActiveAt: 8_000 })],
    ]);
    expect(electActiveTab(map, now)).toBe(2);
  });

  it("breaks an exact lastActiveAt tie deterministically by lowest tabId", () => {
    const now = 10_000;
    const map = new Map([
      [5, rec({ lastHeartbeatAt: now, visible: true, lastActiveAt: 8_000 })],
      [3, rec({ lastHeartbeatAt: now, visible: true, lastActiveAt: 8_000 })],
    ]);
    expect(electActiveTab(map, now)).toBe(3);
  });
});
