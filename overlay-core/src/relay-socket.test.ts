import { describe, expect, it, vi } from "vitest";
import type { ViewerServerEvent } from "@riftsight/protocol";
import { FakeSocket } from "./fake-socket.js";
import { RelaySocket } from "./relay-socket.js";

const sampleState = {
  protocolVersion: 1,
  sessionId: "session-1",
  sequence: 1,
  capturedAt: Date.now(),
  sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
  cards: [],
};

describe("RelaySocket onServerEvent (full viewer vocabulary)", () => {
  function createSocket(onServerEvent: (event: ViewerServerEvent) => void) {
    const fake = new FakeSocket();
    const states: unknown[] = [];
    const socket = new RelaySocket("ws://fake", () => ({ type: "youtube-subscribe", channelId: "UC" + "a".repeat(22) }), () => {}, () => fake, onServerEvent);
    socket.subscribe((state) => states.push(state));
    socket.connect();
    fake.triggerOpen();
    return { fake, socket, states };
  }

  it("routes state events to both subscribe() listeners and onServerEvent", () => {
    const events: ViewerServerEvent[] = [];
    const { fake, states } = createSocket((event) => events.push(event));

    fake.triggerMessage(JSON.stringify({ type: "overlay-state", payload: sampleState }));
    expect(states).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("state");
  });

  it("delivers subscribe-rejected and ping only through onServerEvent", () => {
    const events: ViewerServerEvent[] = [];
    const { fake, states } = createSocket((event) => events.push(event));

    fake.triggerMessage(JSON.stringify({ type: "subscribe-rejected", reason: "at-capacity" }));
    fake.triggerMessage(JSON.stringify({ type: "ping" }));
    expect(states).toHaveLength(0);
    expect(events).toEqual([{ kind: "rejected", reason: "at-capacity" }, { kind: "ping" }]);
  });

  it("without onServerEvent, the legacy parser drops the new shapes (Twitch viewer behavior unchanged)", () => {
    const fake = new FakeSocket();
    const states: unknown[] = [];
    const socket = new RelaySocket("ws://fake", () => ({ type: "subscribe", sessionId: "s" }), () => {}, () => fake);
    socket.subscribe((state) => states.push(state));
    socket.connect();
    fake.triggerOpen();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fake.triggerMessage(JSON.stringify({ type: "ping" }));
      fake.triggerMessage(JSON.stringify({ type: "subscribe-rejected", reason: "unknown-channel" }));
      fake.triggerMessage(JSON.stringify({ type: "overlay-state", payload: sampleState }));
    } finally {
      warnSpy.mockRestore();
    }
    expect(states).toHaveLength(1);
  });
});
