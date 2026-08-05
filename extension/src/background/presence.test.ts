import { describe, expect, it } from "vitest";
import {
  AUTO_STOP_TIMEOUT_MS,
  isPresenceGoneForAutoStop,
  mostRecentPresenceRecord,
  presenceStatus,
  STALE_TIMEOUT_MS,
  type PresenceRecord,
} from "./presence.js";

describe("presenceStatus", () => {
  it("is no-riftatlas when no record has ever been seen", () => {
    expect(presenceStatus(undefined, 1_000)).toBe("no-riftatlas");
  });

  it("is active when a board is detected and the heartbeat is fresh", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 3, lastHeartbeatAt: 1_000 };
    expect(presenceStatus(record, 1_000)).toBe("active");
  });

  it("is present-no-board when no board is detected but the heartbeat is fresh", () => {
    const record: PresenceRecord = { boardDetected: false, publicCardCount: 0, lastHeartbeatAt: 1_000 };
    expect(presenceStatus(record, 1_000)).toBe("present-no-board");
  });

  it("is still active/present-no-board exactly at the stale boundary (not yet stale)", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 1, lastHeartbeatAt: 1_000 };
    expect(presenceStatus(record, 1_000 + STALE_TIMEOUT_MS)).toBe("active");
  });

  it("becomes stale the instant it exceeds the timeout, regardless of board/card state", () => {
    const withBoard: PresenceRecord = { boardDetected: true, publicCardCount: 5, lastHeartbeatAt: 1_000 };
    const withoutBoard: PresenceRecord = { boardDetected: false, publicCardCount: 0, lastHeartbeatAt: 1_000 };
    expect(presenceStatus(withBoard, 1_000 + STALE_TIMEOUT_MS + 1)).toBe("stale");
    expect(presenceStatus(withoutBoard, 1_000 + STALE_TIMEOUT_MS + 1)).toBe("stale");
  });
});

describe("isPresenceGoneForAutoStop", () => {
  it("is false when no record exists — must not look identical to a genuinely-gone tab right after a service-worker wake", () => {
    expect(isPresenceGoneForAutoStop(undefined, 1_000)).toBe(false);
  });

  it("is false for a record aged exactly at the timeout (not yet gone)", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 1, lastHeartbeatAt: 1_000 };
    expect(isPresenceGoneForAutoStop(record, 1_000 + AUTO_STOP_TIMEOUT_MS)).toBe(false);
  });

  it("is false for a record well within the timeout, regardless of board state", () => {
    const record: PresenceRecord = { boardDetected: false, publicCardCount: 0, lastHeartbeatAt: 1_000 };
    expect(isPresenceGoneForAutoStop(record, 1_000 + AUTO_STOP_TIMEOUT_MS - 1)).toBe(false);
  });

  it("is true the instant a record ages past the timeout", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 5, lastHeartbeatAt: 1_000 };
    expect(isPresenceGoneForAutoStop(record, 1_000 + AUTO_STOP_TIMEOUT_MS + 1)).toBe(true);
  });

  it("uses a materially longer threshold than STALE_TIMEOUT_MS — a record that's merely 'stale' for the popup UI must not be 'gone' for auto-stop purposes", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 1, lastHeartbeatAt: 1_000 };
    expect(isPresenceGoneForAutoStop(record, 1_000 + STALE_TIMEOUT_MS + 1)).toBe(false);
  });
});

describe("mostRecentPresenceRecord", () => {
  it("returns undefined for an empty map", () => {
    expect(mostRecentPresenceRecord(new Map())).toBeUndefined();
  });

  it("returns the only record when there's one tab", () => {
    const record: PresenceRecord = { boardDetected: true, publicCardCount: 1, lastHeartbeatAt: 1_000 };
    expect(mostRecentPresenceRecord(new Map([[1, record]]))).toBe(record);
  });

  it("picks whichever tab heartbeated most recently", () => {
    const older: PresenceRecord = { boardDetected: true, publicCardCount: 1, lastHeartbeatAt: 1_000 };
    const newer: PresenceRecord = { boardDetected: false, publicCardCount: 0, lastHeartbeatAt: 5_000 };
    const map = new Map([
      [1, older],
      [2, newer],
    ]);
    expect(mostRecentPresenceRecord(map)).toBe(newer);
  });
});
