import { describe, expect, it } from "vitest";
import { OverlayStatePublisher } from "./publisher.js";
import type { OverlayCard } from "./types.js";

const viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };

function cards(instanceIds: string[]): OverlayCard[] {
  return instanceIds.map((id) => ({
    instanceId: id,
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
    rotation: 0,
    landscape: false,
    localWidth: 0.1,
    localHeight: 0.1,
  }));
}

describe("OverlayStatePublisher", () => {
  it("publishes a state with sequence 1 on the first call", () => {
    const publisher = new OverlayStatePublisher("local-debug");
    const state = publisher.next(cards(["a"]), viewport, 1000);
    expect(state).not.toBeNull();
    expect(state!.sequence).toBe(1);
    expect(state!.sessionId).toBe("local-debug");
    expect(state!.capturedAt).toBe(1000);
    expect(state!.protocolVersion).toBe(1);
  });

  it("suppresses an identical subsequent state", () => {
    const publisher = new OverlayStatePublisher("local-debug");
    publisher.next(cards(["a"]), viewport, 1000);
    expect(publisher.next(cards(["a"]), viewport, 2000)).toBeNull();
  });

  it("increments sequence on a meaningful change and never resets it", () => {
    const publisher = new OverlayStatePublisher("local-debug");
    publisher.next(cards(["a"]), viewport, 1000);
    publisher.next(cards(["a"]), viewport, 1100); // suppressed, no sequence bump
    const changed = publisher.next(cards(["a", "b"]), viewport, 1200);
    expect(changed!.sequence).toBe(2);
    const changedAgain = publisher.next(cards(["a"]), viewport, 1300);
    expect(changedAgain!.sequence).toBe(3);
  });

  it("never lets capturedAt affect duplicate detection", () => {
    const publisher = new OverlayStatePublisher("local-debug");
    publisher.next(cards(["a"]), viewport, 1000);
    expect(publisher.next(cards(["a"]), viewport, 999_999_999)).toBeNull();
  });

  it("reset() clears sequence and dedup state", () => {
    const publisher = new OverlayStatePublisher("local-debug");
    publisher.next(cards(["a"]), viewport, 1000);
    publisher.reset();
    const state = publisher.next(cards(["a"]), viewport, 2000);
    expect(state).not.toBeNull(); // no longer treated as a duplicate
    expect(state!.sequence).toBe(1); // sequence restarted
  });
});
