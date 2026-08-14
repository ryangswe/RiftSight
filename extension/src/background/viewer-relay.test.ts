import { describe, expect, it, vi } from "vitest";
import { FakeSocket } from "@riftsight/overlay-core";
import type { OverlayState, SubscribeRejectedReason } from "@riftsight/protocol";
import { ViewerRelayManager, type ViewerChannelEvents } from "./viewer-relay.js";

const CHANNEL = "UC" + "a".repeat(22);
const OTHER_CHANNEL = "UC" + "b".repeat(22);

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

function serverState(state: OverlayState): unknown {
  return { data: JSON.stringify({ type: "overlay-state", payload: state }) };
}

interface Harness {
  manager: ViewerRelayManager;
  sockets: FakeSocket[];
  events: { states: Array<[string, OverlayState]>; rejections: Array<[string, SubscribeRejectedReason]> };
}

function createHarness(): Harness {
  const sockets: FakeSocket[] = [];
  const events: Harness["events"] = { states: [], rejections: [] };
  const callbacks: ViewerChannelEvents = {
    onState: (channelId, state) => events.states.push([channelId, state]),
    onRejected: (channelId, reason) => events.rejections.push([channelId, reason]),
    onStatusChange: () => {},
  };
  const manager = new ViewerRelayManager(
    "ws://fake",
    (channelId) => ({ type: "youtube-subscribe", channelId }),
    callbacks,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  );
  return { manager, sockets, events };
}

describe("ViewerRelayManager", () => {
  it("opens one socket per channel and subscribes with that channel's message", () => {
    const { manager, sockets } = createHarness();
    manager.acquire(CHANNEL);
    manager.acquire(OTHER_CHANNEL);
    expect(sockets).toHaveLength(2);

    sockets[0]!.emit("open", {});
    expect(JSON.parse(sockets[0]!.sentMessages[0]!)).toEqual({ type: "youtube-subscribe", channelId: CHANNEL });
  });

  it("refcounts: a second tab reuses the socket, and the channel closes only when the last tab leaves", () => {
    const { manager, sockets } = createHarness();
    manager.acquire(CHANNEL);
    manager.acquire(CHANNEL);
    expect(sockets).toHaveLength(1);
    expect(manager.debugChannelCount()).toBe(1);

    manager.release(CHANNEL);
    expect(sockets[0]!.closed).toBe(false);
    expect(manager.debugChannelCount()).toBe(1);

    manager.release(CHANNEL);
    expect(sockets[0]!.closed).toBe(true);
    expect(manager.debugChannelCount()).toBe(0);
  });

  it("fans states out per channel and hands a late-joining tab the cached last state", () => {
    const { manager, sockets, events } = createHarness();
    manager.acquire(CHANNEL);
    sockets[0]!.emit("open", {});
    sockets[0]!.emit("message", serverState(sampleState("session-1", 7)));

    expect(events.states).toHaveLength(1);
    expect(events.states[0]![0]).toBe(CHANNEL);
    expect(events.states[0]![1].sequence).toBe(7);

    const { lastState } = manager.acquire(CHANNEL);
    expect(lastState?.sequence).toBe(7);
    expect(manager.lastStateFor(CHANNEL)?.sequence).toBe(7);
  });

  it("a rejection stands the socket down and reconcile() retries it once", () => {
    const { manager, sockets, events } = createHarness();
    manager.acquire(CHANNEL);
    sockets[0]!.emit("open", {});
    sockets[0]!.emit("message", { data: JSON.stringify({ type: "subscribe-rejected", reason: "unknown-channel" }) });

    expect(events.rejections).toEqual([[CHANNEL, "unknown-channel"]]);
    expect(sockets[0]!.closed).toBe(true);

    manager.reconcile();
    // reconnect = a fresh socket from the factory
    expect(sockets).toHaveLength(2);

    // A second reconcile with no new rejection must NOT open yet another
    // socket — the retry is once per rejection, not per tick.
    manager.reconcile();
    expect(sockets).toHaveLength(2);
  });

  it("pings are swallowed without side effects", () => {
    const { manager, sockets, events } = createHarness();
    manager.acquire(CHANNEL);
    sockets[0]!.emit("open", {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      sockets[0]!.emit("message", { data: JSON.stringify({ type: "ping" }) });
    } finally {
      warnSpy.mockRestore();
    }
    expect(events.states).toHaveLength(0);
    expect(events.rejections).toHaveLength(0);
    expect(sockets[0]!.closed).toBe(false);
  });

  it("releasing an unknown channel is a harmless no-op", () => {
    const { manager } = createHarness();
    expect(() => manager.release(CHANNEL)).not.toThrow();
  });
});
