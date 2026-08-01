import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundsFingerprint, runSettleLoop, type FingerprintEntry } from "./settle.js";

function entry(overrides: Partial<FingerprintEntry> = {}): FingerprintEntry {
  return { id: "card_1", x: 10, y: 20, width: 100, height: 140, ...overrides };
}

describe("boundsFingerprint", () => {
  it("returns an empty string for no entries", () => {
    expect(boundsFingerprint([])).toBe("");
  });

  it("is stable for the same single entry", () => {
    expect(boundsFingerprint([entry()])).toBe(boundsFingerprint([entry()]));
  });

  it("is independent of input order", () => {
    const a = entry({ id: "card_a", x: 1 });
    const b = entry({ id: "card_b", x: 2 });
    expect(boundsFingerprint([a, b])).toBe(boundsFingerprint([b, a]));
  });

  it("changes when an entry moves", () => {
    const before = boundsFingerprint([entry({ x: 10 })]);
    const after = boundsFingerprint([entry({ x: 11 })]);
    expect(after).not.toBe(before);
  });

  it("changes when an entry resizes", () => {
    const before = boundsFingerprint([entry({ width: 100 })]);
    const after = boundsFingerprint([entry({ width: 101 })]);
    expect(after).not.toBe(before);
  });

  it("changes when the set of entries changes (card added or removed)", () => {
    const before = boundsFingerprint([entry({ id: "card_a" })]);
    const after = boundsFingerprint([entry({ id: "card_a" }), entry({ id: "card_b" })]);
    expect(after).not.toBe(before);
  });

  it("does not change for subpixel differences that round to the same whole pixel", () => {
    const before = boundsFingerprint([entry({ x: 10.1, y: 20.2, width: 100.4, height: 140.3 })]);
    const after = boundsFingerprint([entry({ x: 9.6, y: 19.6, width: 99.6, height: 140.1 })]);
    expect(after).toBe(before);
  });

  it("distinguishes two different card ids at the same position", () => {
    const a = boundsFingerprint([entry({ id: "card_a" })]);
    const b = boundsFingerprint([entry({ id: "card_b" })]);
    expect(a).not.toBe(b);
  });
});

describe("runSettleLoop", () => {
  const INTERVAL_MS = 60;
  const MAX_ATTEMPTS = 3;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles after one check when two consecutive samples already agree", () => {
    const sample = vi.fn(() => "stable");
    const onSettled = vi.fn();
    runSettleLoop({ sample, onSettled, intervalMs: INTERVAL_MS, maxAttempts: MAX_ATTEMPTS });

    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps sampling while values differ, then settles once they agree", () => {
    const values = ["a", "b", "b", "b"]; // changes once, then stabilizes
    const sample = vi.fn(() => values.shift() as string);
    const onSettled = vi.fn();
    runSettleLoop({ sample, onSettled, intervalMs: INTERVAL_MS, maxAttempts: MAX_ATTEMPTS });

    vi.advanceTimersByTime(INTERVAL_MS); // "a" vs "b" — still moving
    expect(onSettled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INTERVAL_MS); // "b" vs "b" — settled
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and calls onSettled anyway if it never stabilizes", () => {
    let counter = 0;
    const sample = vi.fn(() => String(counter++)); // always different — never settles on its own
    const onSettled = vi.fn();
    runSettleLoop({ sample, onSettled, intervalMs: INTERVAL_MS, maxAttempts: MAX_ATTEMPTS });

    for (let round = 0; round <= MAX_ATTEMPTS; round++) {
      if (round < MAX_ATTEMPTS) expect(onSettled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(INTERVAL_MS);
    }
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("never calls onSettled once cancelled, even if a check was already scheduled", () => {
    const sample = vi.fn(() => "stable");
    const onSettled = vi.fn();
    const handle = runSettleLoop({ sample, onSettled, intervalMs: INTERVAL_MS, maxAttempts: MAX_ATTEMPTS });

    handle.cancel();
    vi.advanceTimersByTime(INTERVAL_MS * (MAX_ATTEMPTS + 2));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("only ever calls onSettled once, not once per remaining scheduled check", () => {
    const sample = vi.fn(() => "stable");
    const onSettled = vi.fn();
    runSettleLoop({ sample, onSettled, intervalMs: INTERVAL_MS, maxAttempts: MAX_ATTEMPTS });

    vi.advanceTimersByTime(INTERVAL_MS * (MAX_ATTEMPTS + 5));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
