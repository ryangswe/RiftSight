import { describe, expect, it, vi } from "vitest";
import { findStateAtOrBefore, TimeWindowBuffer, type TimestampedState } from "./history.js";

function states(times: number[]): TimestampedState<string>[] {
  return times.map((time) => ({ time, value: `v${time}` }));
}

describe("findStateAtOrBefore", () => {
  it("returns undefined for an empty array", () => {
    expect(findStateAtOrBefore([], 100)).toBeUndefined();
  });

  it("returns undefined when the target is before the first state", () => {
    expect(findStateAtOrBefore(states([100, 200, 300]), 50)).toBeUndefined();
  });

  it("returns the exact match when the target equals a state's time", () => {
    expect(findStateAtOrBefore(states([100, 200, 300]), 200)?.value).toBe("v200");
  });

  it("returns the earlier state when the target falls between two states", () => {
    expect(findStateAtOrBefore(states([100, 200, 300]), 250)?.value).toBe("v200");
  });

  it("returns the last state when the target is after the final state", () => {
    expect(findStateAtOrBefore(states([100, 200, 300]), 9999)?.value).toBe("v300");
  });

  it("returns the last matching entry among duplicate timestamps", () => {
    const dup: TimestampedState<string>[] = [
      { time: 100, value: "first" },
      { time: 100, value: "second" },
      { time: 100, value: "third" },
      { time: 200, value: "later" },
    ];
    expect(findStateAtOrBefore(dup, 100)?.value).toBe("third");
  });

  it("works on a single-element array", () => {
    expect(findStateAtOrBefore(states([500]), 500)?.value).toBe("v500");
    expect(findStateAtOrBefore(states([500]), 499)).toBeUndefined();
  });
});

describe("TimeWindowBuffer", () => {
  it("finds the state at or before a target time", () => {
    const buffer = new TimeWindowBuffer<string>();
    buffer.push(100, "a");
    buffer.push(200, "b");
    buffer.push(300, "c");
    expect(buffer.findAtOrBefore(250)?.value).toBe("b");
  });

  it("prunes entries older than the retention window relative to the newest push", () => {
    const buffer = new TimeWindowBuffer<string>(1000); // 1s retention
    buffer.push(0, "old");
    buffer.push(500, "mid");
    buffer.push(1500, "newest"); // now 1500 - 1000 = 500 is the cutoff; "old" (0) should be dropped
    expect(buffer.size).toBe(2);
    expect(buffer.earliestTime).toBe(500);
    expect(buffer.findAtOrBefore(0)).toBeUndefined(); // "old" is gone
  });

  it("caps total entries at maxEntries even within the retention window", () => {
    const buffer = new TimeWindowBuffer<string>(1_000_000, 3); // huge retention, tiny cap
    buffer.push(1, "a");
    buffer.push(2, "b");
    buffer.push(3, "c");
    buffer.push(4, "d");
    expect(buffer.size).toBe(3);
    expect(buffer.earliestTime).toBe(2); // "a" got dropped for the count cap, not retention
  });

  it("rejects a push that moves strictly backward in time", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const buffer = new TimeWindowBuffer<string>();
    buffer.push(200, "b");
    buffer.push(100, "a-out-of-order");
    expect(buffer.size).toBe(1);
    expect(buffer.latestTime).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("accepts a duplicate (equal, not backward) timestamp", () => {
    const buffer = new TimeWindowBuffer<string>();
    buffer.push(100, "first");
    buffer.push(100, "second");
    expect(buffer.size).toBe(2);
    expect(buffer.findAtOrBefore(100)?.value).toBe("second");
  });

  it("reports earliest/latest/size on an empty buffer", () => {
    const buffer = new TimeWindowBuffer<string>();
    expect(buffer.size).toBe(0);
    expect(buffer.earliestTime).toBeUndefined();
    expect(buffer.latestTime).toBeUndefined();
    expect(buffer.findAtOrBefore(Date.now())).toBeUndefined();
  });

  it("clear() empties the buffer", () => {
    const buffer = new TimeWindowBuffer<string>();
    buffer.push(100, "a");
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.findAtOrBefore(100)).toBeUndefined();
  });
});
