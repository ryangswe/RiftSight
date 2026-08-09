import type { OverlayState } from "@riftsight/protocol";
import { describe, expect, it } from "vitest";
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

describe("createLocalStateBus", () => {
  it("delivers a published message to every current subscriber", () => {
    const bus = createLocalStateBus();
    const receivedByA: StateBusMessage[] = [];
    const receivedByB: StateBusMessage[] = [];
    bus.subscribe((message) => receivedByA.push(message));
    bus.subscribe((message) => receivedByB.push(message));

    const message: StateBusMessage = { kind: "producer-claimed", sessionId: "s1", originInstanceId: "inst-a" };
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
    const message: StateBusMessage = { kind: "producer-claimed", sessionId: "s1", originInstanceId: "inst-a" };
    bus.publish(message);

    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([message]);
  });

  it("round-trips a 'state' message unmutated", () => {
    const bus = createLocalStateBus();
    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    const message: StateBusMessage = { kind: "state", sessionId: "s1", originInstanceId: "inst-a", state: sampleState("s1", 1) };
    bus.publish(message);

    expect(received).toEqual([message]);
  });

  it("round-trips a 'state-expired' message unmutated", () => {
    const bus = createLocalStateBus();
    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    const message: StateBusMessage = { kind: "state-expired", sessionId: "s1", originInstanceId: "inst-a", emptyState: sampleState("s1", 2) };
    bus.publish(message);

    expect(received).toEqual([message]);
  });

  it("delivers to a subscriber added after an earlier publish, without replaying the earlier message", () => {
    const bus = createLocalStateBus();
    bus.publish({ kind: "producer-claimed", sessionId: "s1", originInstanceId: "inst-a" });

    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    expect(received).toEqual([]);
  });

  it("does not throw when publishing before any subscriber exists", () => {
    const bus = createLocalStateBus();
    expect(() => bus.publish({ kind: "producer-claimed", sessionId: "s1", originInstanceId: "inst-a" })).not.toThrow();
  });
});
