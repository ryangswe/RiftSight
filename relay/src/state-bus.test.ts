import type { OverlayState } from "@riftsight/protocol";
import { describe, expect, it, vi } from "vitest";
import { createLocalStateBus, type StateBusMessage } from "./state-bus.js";

function sampleState(sessionId: string, sequence: number): OverlayState {
  return {
    protocolVersion: 1,
    sessionId,
    sequence,
    capturedAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    cards: [],
  };
}

function sampleMessage(sessionId: string, sequence = 1): StateBusMessage {
  return { kind: "state", sessionId, originInstanceId: "inst-a", state: sampleState(sessionId, sequence) };
}

describe("createLocalStateBus", () => {
  it("delivers a published message to every current subscriber", () => {
    const bus = createLocalStateBus();
    const receivedByA: StateBusMessage[] = [];
    const receivedByB: StateBusMessage[] = [];
    bus.subscribe((message) => receivedByA.push(message));
    bus.subscribe((message) => receivedByB.push(message));

    const message = sampleMessage("s1");
    bus.publish(message);

    expect(receivedByA).toEqual([message]);
    expect(receivedByB).toEqual([message]);
  });

  it("stops only the unsubscribed handler, leaving other subscribers unaffected", () => {
    const bus = createLocalStateBus();
    const receivedByA: StateBusMessage[] = [];
    const receivedByB: StateBusMessage[] = [];
    const unsubscribeA = bus.subscribe((message) => receivedByA.push(message));
    bus.subscribe((message) => receivedByB.push(message));

    unsubscribeA();
    const message = sampleMessage("s1");
    bus.publish(message);

    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([message]);
  });

  it("round-trips a 'state' message unmutated", () => {
    const bus = createLocalStateBus();
    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    const message = sampleMessage("s1");
    bus.publish(message);

    expect(received).toEqual([message]);
  });

  it("delivers to a subscriber added after an earlier publish, without replaying the earlier message", () => {
    const bus = createLocalStateBus();
    bus.publish(sampleMessage("s1"));

    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    expect(received).toEqual([]);
  });

  it("does not throw when publishing before any subscriber exists", () => {
    const bus = createLocalStateBus();
    expect(() => bus.publish(sampleMessage("s1"))).not.toThrow();
  });

  describe("snapshot store", () => {
    it("loads the last saved snapshot for a session", async () => {
      const bus = createLocalStateBus();
      const state = sampleState("s1", 3);
      bus.saveSnapshot("s1", state, 1000);

      await expect(bus.loadSnapshot("s1")).resolves.toEqual(state);
    });

    it("returns null for a session that never had a snapshot", async () => {
      const bus = createLocalStateBus();
      await expect(bus.loadSnapshot("never-saved")).resolves.toBeNull();
    });

    it("a newer save overwrites the previous snapshot", async () => {
      const bus = createLocalStateBus();
      bus.saveSnapshot("s1", sampleState("s1", 1), 1000);
      const newer = sampleState("s1", 2);
      bus.saveSnapshot("s1", newer, 1000);

      await expect(bus.loadSnapshot("s1")).resolves.toEqual(newer);
    });

    it("keeps sessions' snapshots independent", async () => {
      const bus = createLocalStateBus();
      const stateA = sampleState("session-a", 1);
      bus.saveSnapshot("session-a", stateA, 1000);
      bus.saveSnapshot("session-b", sampleState("session-b", 7), 1000);

      await expect(bus.loadSnapshot("session-a")).resolves.toEqual(stateA);
    });

    it("returns null once the snapshot's TTL has lapsed", async () => {
      vi.useFakeTimers();
      try {
        const bus = createLocalStateBus();
        bus.saveSnapshot("s1", sampleState("s1", 1), 1000);

        vi.advanceTimersByTime(999);
        await expect(bus.loadSnapshot("s1")).resolves.not.toBeNull();

        vi.advanceTimersByTime(2);
        await expect(bus.loadSnapshot("s1")).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a fresh save restarts the TTL window", async () => {
      vi.useFakeTimers();
      try {
        const bus = createLocalStateBus();
        bus.saveSnapshot("s1", sampleState("s1", 1), 1000);
        vi.advanceTimersByTime(900);
        const refreshed = sampleState("s1", 2);
        bus.saveSnapshot("s1", refreshed, 1000);
        vi.advanceTimersByTime(900); // 1800ms after the first save, 900ms after the second

        await expect(bus.loadSnapshot("s1")).resolves.toEqual(refreshed);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
