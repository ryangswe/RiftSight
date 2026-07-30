import { describe, expect, it } from "vitest";
import { delayedLiveTarget, isWaitingForHistory, playbackTarget, recordingPlaybackStatus } from "./mode.js";

describe("delayedLiveTarget", () => {
  it("subtracts the configured delay from now", () => {
    expect(delayedLiveTarget(12_005_000, 5000)).toBe(12_000_000);
  });

  it("matches the milestone's worked example", () => {
    // captured at 12:00:00.000, delay 5000ms -> should display at 12:00:05.000,
    // i.e. at that render moment the target capture time is 12:00:00.000
    const capturedAt = new Date("2026-01-01T12:00:00.000Z").getTime();
    const renderMoment = new Date("2026-01-01T12:00:05.000Z").getTime();
    expect(delayedLiveTarget(renderMoment, 5000)).toBe(capturedAt);
  });

  it("a zero delay targets the present moment", () => {
    expect(delayedLiveTarget(1000, 0)).toBe(1000);
  });
});

describe("isWaitingForHistory", () => {
  it("is waiting immediately after collection starts", () => {
    expect(isWaitingForHistory(1_000_000, 5000, 1_000_100)).toBe(true); // only 100ms elapsed
  });

  it("stops waiting once delayMs of collection time has elapsed", () => {
    expect(isWaitingForHistory(1_000_000, 5000, 1_005_000)).toBe(false); // exactly delayMs elapsed
    expect(isWaitingForHistory(1_000_000, 5000, 1_010_000)).toBe(false); // well past delayMs
  });

  it("a zero delay is never waiting", () => {
    expect(isWaitingForHistory(1_000_000, 0, 1_000_000)).toBe(false);
  });

  it("is not fooled by a single stale sample far older than the delay window", () => {
    // Regression case: right after (re)connecting, the relay replays its one
    // retained latest state, which can be arbitrarily old with a gap before
    // it — that must not read as "synchronized" just because that one
    // sample happens to be older than delayMs. isWaitingForHistory doesn't
    // even see sample ages, only elapsed collection time, so this is really
    // a documentation-via-test that the function's inputs can't leak that
    // failure mode back in.
    const bufferingSinceTime = 2_000_000; // collection (re)started here
    const now = 2_000_100; // only 100ms of real collection time has passed
    expect(isWaitingForHistory(bufferingSinceTime, 5000, now)).toBe(true);
  });
});

describe("playbackTarget", () => {
  it("converts video seconds to ms with no offset", () => {
    expect(playbackTarget(3.5, 0)).toBe(3500);
  });

  it("a positive syncOffsetMs advances the target ahead of the video", () => {
    expect(playbackTarget(10, 500)).toBe(10_500); // later in the recording timeline than raw video time alone
  });

  it("a negative syncOffsetMs delays the target behind the video", () => {
    expect(playbackTarget(10, -500)).toBe(9500);
  });

  it("rate changes don't need special handling — only currentTime matters", () => {
    // A rate change doesn't alter currentTime directly; whatever currentTime
    // the video reports after any amount of playback at any rate feeds the
    // exact same formula. This documents that the calculator is rate-agnostic.
    expect(playbackTarget(4.2, 100)).toBe(4300);
  });
});

describe("recordingPlaybackStatus", () => {
  it("is 'no-recording' when there's nothing loaded", () => {
    expect(recordingPlaybackStatus(1000, undefined, undefined)).toBe("no-recording");
  });

  it("is 'before-start' when the target precedes the first recorded state", () => {
    expect(recordingPlaybackStatus(-100, 0, 5000)).toBe("before-start");
  });

  it("is 'synchronized' when the target falls within the recording's range", () => {
    expect(recordingPlaybackStatus(0, 0, 5000)).toBe("synchronized"); // exact start
    expect(recordingPlaybackStatus(5000, 0, 5000)).toBe("synchronized"); // exact end
    expect(recordingPlaybackStatus(2500, 0, 5000)).toBe("synchronized"); // middle
  });

  it("is 'past-end' when the target is beyond the last recorded state", () => {
    expect(recordingPlaybackStatus(5001, 0, 5000)).toBe("past-end");
  });
});
