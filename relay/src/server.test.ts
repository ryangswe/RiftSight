import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createRelayServer, type RelayServer } from "./server.js";
import { createLocalStateBus } from "./state-bus.js";

const BASE64_SECRET = Buffer.from("test-extension-secret-bytes").toString("base64");
const secretBytes = Buffer.from(BASE64_SECRET, "base64");

function signToken(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(claims, secretBytes, { algorithm: "HS256", expiresIn: "1h", ...options });
}

let server: RelayServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

/**
 * Resolves with the first incoming message the predicate accepts, ignoring
 * anything before it. For asserting on one specific expected message (e.g.
 * a viewer-count with a particular value) when an earlier message could
 * still be in flight — under parallel-suite CPU load, a fixed pre-listen
 * wait() is not enough to guarantee earlier traffic has fully flushed, and
 * waitForMessage would then resolve with the late straggler instead
 * (observed as real flakes in the two viewer-count tests below).
 */
function waitForMessageMatching<T>(ws: WebSocket, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const listener = (raw: RawData): void => {
      const parsed = JSON.parse(raw.toString()) as T;
      if (!predicate(parsed)) return;
      ws.off("message", listener);
      resolve(parsed);
    };
    ws.on("message", listener);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleState(sessionId: string, sequence: number, protocolVersion = 1) {
  return {
    protocolVersion,
    sessionId,
    sequence,
    capturedAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    cards: [],
  };
}

describe("relay server", () => {
  it("broadcasts a producer's state to a subscribed viewer", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "test-session" }));
    await wait(50); // let the subscribe register before the producer sends

    const producer = new WebSocket(url);
    await waitForOpen(producer);

    const received = waitForMessage(viewer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("test-session", 1) }));

    const message = (await received) as { type: string; payload: { sequence: number } };
    expect(message.type).toBe("overlay-state");
    expect(message.payload.sequence).toBe(1);

    viewer.close();
    producer.close();
  });

  it("immediately sends the latest known state to a viewer that subscribes after the fact", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("late-session", 5) }));
    await wait(50);

    const lateViewer = new WebSocket(url);
    await waitForOpen(lateViewer);
    const received = waitForMessage(lateViewer);
    lateViewer.send(JSON.stringify({ type: "subscribe", sessionId: "late-session" }));

    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(5);

    producer.close();
    lateViewer.close();
  });

  it("sends the producer a viewer-count message when a viewer subscribes", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("viewer-count-session", 1) }));
    await wait(50); // let the initial publish (and its own count:0 message) settle before listening

    const received = waitForMessageMatching<{ type: string; count: number }>(
      producer,
      (m) => m.type === "viewer-count" && m.count === 1 // ignore the initial count:0 from the producer's own binding, which can still be in flight — see waitForMessageMatching
    );
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "viewer-count-session" }));

    const message = await received;
    expect(message).toEqual({ type: "viewer-count", count: 1 });

    viewer.close();
    producer.close();
  });

  it("sends the producer an updated viewer-count message when a viewer disconnects", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("viewer-count-disconnect", 1) }));
    await wait(50);

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "viewer-count-disconnect" }));
    await wait(50);

    const received = waitForMessageMatching<{ type: string; count: number }>(
      producer,
      (m) => m.type === "viewer-count" && m.count === 0 // ignore a still-in-flight count:1 from the viewer's own admit — see waitForMessageMatching
    );
    viewer.close();

    const message = await received;
    expect(message).toEqual({ type: "viewer-count", count: 0 });

    producer.close();
  });

  it("does not broadcast a message with an unsupported protocol version", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "bad-session" }));
    await wait(50);

    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(
      JSON.stringify({ type: "overlay-state", payload: sampleState("bad-session", 1, 2 /* unsupported */) })
    );
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
    producer.close();
  });

  it("keeps sessions independent — a viewer only receives its own session's state", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewerA = new WebSocket(url);
    await waitForOpen(viewerA);
    viewerA.send(JSON.stringify({ type: "subscribe", sessionId: "session-a" }));
    await wait(50);

    let receivedByA = false;
    viewerA.on("message", () => {
      receivedByA = true;
    });

    const producerB = new WebSocket(url);
    await waitForOpen(producerB);
    producerB.send(JSON.stringify({ type: "overlay-state", payload: sampleState("session-b", 1) }));
    await wait(100);

    expect(receivedByA).toBe(false);

    viewerA.close();
    producerB.close();
  });

  it("survives malformed JSON from a producer and still processes a later valid message", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "resilience-session" }));
    await wait(50);

    const producer = new WebSocket(url);
    await waitForOpen(producer);

    // Raw, deliberately non-JSON payload — the server must not crash or
    // otherwise let this corrupt handling of the next, valid message.
    producer.send("{not valid json at all");
    await wait(50);

    const received = waitForMessage(viewer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("resilience-session", 1) }));

    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);
    expect(server.port).toBeGreaterThan(0); // server is still alive/listening, not crashed

    viewer.close();
    producer.close();
  });

  it("rejects a hidden card carrying identity fields and does not broadcast it", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "leak-session" }));
    await wait(50);

    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    const leaky = {
      ...sampleState("leak-session", 1),
      cards: [
        {
          instanceId: "card_1",
          zone: "hand",
          owner: "self",
          visibility: "hidden",
          cardId: "OGN-213",
          bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
          rotation: 0,
          landscape: false,
          localWidth: 0.1,
          localHeight: 0.1,
          fromDialog: false,
        },
      ],
    };
    producer.send(JSON.stringify({ type: "overlay-state", payload: leaky }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
    producer.close();
  });

  it("accepts a valid twitch-subscribe and delivers that channel's state", async () => {
    server = await createRelayServer(0, { twitchExtensionSecret: BASE64_SECRET });
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("789", 1) }));
    await wait(50);

    const token = signToken({ channel_id: "789", role: "viewer", opaque_user_id: "U1" });
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    const received = waitForMessage(viewer);
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "789", token }));

    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);

    viewer.close();
    producer.close();
  });

  it("rejects a twitch-subscribe when the JWT's channel_id does not match the requested channel", async () => {
    server = await createRelayServer(0, { twitchExtensionSecret: BASE64_SECRET });
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("channel-a", 1) }));
    await wait(50);

    // Token is valid and well-formed, but scoped to a different channel
    // than the one this viewer is trying to subscribe to.
    const token = signToken({ channel_id: "channel-b", role: "viewer", opaque_user_id: "U1" });
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "channel-a", token }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
    producer.close();
  });

  it("rejects a twitch-subscribe with an expired token", async () => {
    server = await createRelayServer(0, { twitchExtensionSecret: BASE64_SECRET });
    const url = `ws://localhost:${server.port}`;

    const token = signToken({ channel_id: "expired-channel", role: "viewer", opaque_user_id: "U1" }, { expiresIn: "-1h" });
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "expired-channel", token }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
  });

  it("rejects a malformed twitch-subscribe token", async () => {
    server = await createRelayServer(0, { twitchExtensionSecret: BASE64_SECRET });
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "some-channel", token: "not-a-real-jwt" }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
  });

  it("rejects any twitch-subscribe when TWITCH_EXTENSION_SECRET is not configured", async () => {
    server = await createRelayServer(0); // no twitchExtensionSecret
    const url = `ws://localhost:${server.port}`;

    const token = signToken({ channel_id: "unconfigured-channel", role: "viewer", opaque_user_id: "U1" });
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "unconfigured-channel", token }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
  });

  it("rejects a plain unauthenticated subscribe when allowLocalDebug is false", async () => {
    server = await createRelayServer(0, { allowLocalDebug: false });
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "local-debug" }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
  });

  it("still accepts a plain subscribe by default (allowLocalDebug unset)", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("default-session", 1) }));
    await wait(50);

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    const received = waitForMessage(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "default-session" }));

    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);

    viewer.close();
    producer.close();
  });

  describe("stale-state TTL", () => {
    it("broadcasts a synthesized empty-cards state to already-connected viewers once a session goes stale (producer actually gone, not just quiet)", async () => {
      server = await createRelayServer(0, { stateTtl: { ttlMs: 100, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;

      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "ttl-session" }));
      await wait(50);

      const producer = new WebSocket(url);
      await waitForOpen(producer);
      const firstReceived = waitForMessage(viewer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("ttl-session", 1) }));
      await firstReceived;

      // The producer's own connection has to actually be gone for staleness
      // to mean anything — see isProducerConnectionOpen's doc comment. A
      // still-open producer that simply has nothing new to say must never
      // trigger this (that's the "does not expire a session with a
      // connected-but-quiet producer" test below).
      producer.close();
      await wait(30);

      const staleReceived = waitForMessage(viewer);
      const message = (await staleReceived) as { type: string; payload: { cards: unknown[]; sequence: number } };
      expect(message.type).toBe("overlay-state");
      expect(message.payload.cards).toEqual([]);
      expect(message.payload.sequence).toBe(2); // one more than the real state it supersedes

      viewer.close();
    });

    it("never hands a newly-connecting viewer a state older than the TTL once the producer that sent it is actually gone", async () => {
      server = await createRelayServer(0, { stateTtl: { ttlMs: 50, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;

      const producer = new WebSocket(url);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("ttl-late-join", 1) }));
      await wait(30);
      producer.close(); // gone, not just quiet — see the test above
      await wait(200); // well past both the TTL and a sweep tick

      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      let receivedAnything = false;
      viewer.on("message", () => {
        receivedAnything = true;
      });
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "ttl-late-join" }));
      await wait(100);

      expect(receivedAnything).toBe(false);

      viewer.close();
    });

    it("does not expire a session whose producer is still connected, even with a quiet/unchanged board well past the TTL", async () => {
      // Regression test for a real bug found via live testing: a healthy,
      // still-connected producer that simply has nothing new to report
      // (the board hasn't changed — completely normal during a slow turn
      // or a paused test) was having its accurate overlay state wiped
      // purely because no message had arrived in stateTtlMs, even though
      // the producer never disconnected. Connection liveness, not time
      // since the last *content* change, is what staleness should mean.
      server = await createRelayServer(0, { stateTtl: { ttlMs: 80, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;

      const producer = new WebSocket(url);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("quiet-but-connected", 1) }));
      await wait(30);

      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      // Assert on message CONTENT, not arrival: the only message this
      // viewer may legitimately receive is the admit-time send of the real
      // state (sequence 1) — which under parallel-suite CPU load can be
      // delivered later than any fixed settle wait (an observed flake). A
      // spurious TTL clear is unambiguous regardless of timing: it's
      // synthesized with the NEXT sequence (2).
      const receivedSequences: number[] = [];
      viewer.on("message", (raw) => {
        receivedSequences.push((JSON.parse(raw.toString()) as { payload: { sequence: number } }).payload.sequence);
      });
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "quiet-but-connected" }));

      await wait(300); // comfortably past ttlMs and several sweep ticks, producer still open, still silent
      expect(receivedSequences).toEqual([1]); // the admit-time state and nothing else — no sequence-2 synthesized clear

      // A brand-new viewer joining during this same quiet-but-connected
      // window must still receive the accurate (just old) state — not be
      // treated as if nothing were there.
      const lateViewer = new WebSocket(url);
      await waitForOpen(lateViewer);
      const lateReceived = waitForMessage(lateViewer);
      lateViewer.send(JSON.stringify({ type: "subscribe", sessionId: "quiet-but-connected" }));
      const lateMessage = (await lateReceived) as { payload: { cards: unknown[]; sequence: number } };
      expect(lateMessage.payload.sequence).toBe(1);

      producer.close();
      viewer.close();
      lateViewer.close();
    });

    it("does not expire a session that keeps receiving fresh producer updates", async () => {
      // Wide margins deliberately: this is a real-wall-clock test running
      // alongside other test files (CPU contention can stretch a
      // nominally-30ms gap well past it under load), so ttlMs needs
      // generous headroom over the actual send spacing, not just the
      // nominal one, to avoid a flaky false expiry.
      server = await createRelayServer(0, { stateTtl: { ttlMs: 400, sweepIntervalMs: 40 } });
      const url = `ws://localhost:${server.port}`;

      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "kept-fresh" }));
      await wait(50);

      const producer = new WebSocket(url);
      await waitForOpen(producer);

      const receivedSequences: number[] = [];
      viewer.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString()) as { payload: { sequence: number } };
        receivedSequences.push(parsed.payload.sequence);
      });

      // Sends well inside ttlMs apart, for longer than ttlMs total — the
      // session should never be judged stale, so the viewer should see
      // exactly the 6 real sequence numbers sent and nothing else (a
      // synthesized TTL-expiry broadcast would insert an extra message
      // with a sequence one past whichever real one it superseded).
      for (let i = 1; i <= 6; i++) {
        producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("kept-fresh", i) }));
        await wait(40);
      }
      await wait(100);

      expect(receivedSequences).toEqual([1, 2, 3, 4, 5, 6]);

      viewer.close();
      producer.close();
    });
  });

  describe("session reaping (bounded memory)", () => {
    // Directly proves the sweep shrinks the in-memory sessions map back to
    // baseline once a session has no local stake — the fix for the map
    // otherwise growing one permanent entry per distinct channel id the
    // process ever saw. debugSessionCount() is the seam (the map is
    // closure-private) — see RelayServer.debugSessionCount.
    async function waitForSessionCount(s: RelayServer, expected: number, timeoutMs = 1000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (s.debugSessionCount() !== expected) {
        if (Date.now() > deadline) break;
        await wait(20);
      }
    }

    it("reaps a session once its producer and all its viewers are gone", async () => {
      server = await createRelayServer(0, { stateTtl: { ttlMs: 40, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;
      expect(server.debugSessionCount()).toBe(0);

      const producer = new WebSocket(url);
      await waitForOpen(producer);
      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      const received = waitForMessage(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "reap-me" }));
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("reap-me", 1) }));
      await received;
      expect(server.debugSessionCount()).toBe(1);

      producer.close();
      viewer.close();

      // No local producer and no local viewers → the next sweep drops it,
      // and (crucially) it does NOT come back on subsequent sweeps.
      await waitForSessionCount(server, 0);
      expect(server.debugSessionCount()).toBe(0);
      await wait(60); // a couple more sweep ticks
      expect(server.debugSessionCount()).toBe(0);
    });

    it("does NOT reap a session whose producer is still connected, even with zero viewers", async () => {
      server = await createRelayServer(0, { stateTtl: { ttlMs: 40, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;

      const producer = new WebSocket(url);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("held-by-producer", 1) }));
      await wait(50);
      expect(server.debugSessionCount()).toBe(1);

      await wait(120); // several sweep ticks, producer still connected, no viewers ever
      expect(server.debugSessionCount()).toBe(1);

      producer.close();
      await waitForSessionCount(server, 0);
      expect(server.debugSessionCount()).toBe(0);
    });

    it("does NOT reap a session that still has a viewer, even with no producer", async () => {
      server = await createRelayServer(0, { stateTtl: { ttlMs: 10_000, sweepIntervalMs: 20 } });
      const url = `ws://localhost:${server.port}`;

      const viewer = new WebSocket(url);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "held-by-viewer" }));
      await wait(50);
      expect(server.debugSessionCount()).toBe(1);

      await wait(120); // several sweep ticks, viewer still subscribed, no producer
      expect(server.debugSessionCount()).toBe(1);

      viewer.close();
      await waitForSessionCount(server, 0);
      expect(server.debugSessionCount()).toBe(0);
    });
  });

  describe("capacity snapshot", () => {
    /** Captures every capacity_snapshot log line while active, restoring console.log after. */
    function captureCapacitySnapshots(): { snapshots: Record<string, unknown>[]; restore: () => void } {
      const snapshots: Record<string, unknown>[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
        if (typeof line !== "string") return;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["event"] === "capacity_snapshot") snapshots.push(parsed);
        } catch {
          // non-JSON console.log (e.g. "[relay] listening ...") — ignore
        }
      });
      return { snapshots, restore: () => spy.mockRestore() };
    }

    it("periodically logs this instance's session/viewer/producer counts, tagged with the instanceId", async () => {
      const { snapshots, restore } = captureCapacitySnapshots();
      try {
        server = await createRelayServer(0, { capacitySnapshot: { intervalMs: 30 } });
        const url = `ws://localhost:${server.port}`;

        const producer = new WebSocket(url);
        await waitForOpen(producer);
        producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("capacity", 1) }));

        const viewerA = new WebSocket(url);
        await waitForOpen(viewerA);
        viewerA.send(JSON.stringify({ type: "subscribe", sessionId: "capacity" }));
        const viewerB = new WebSocket(url);
        await waitForOpen(viewerB);
        viewerB.send(JSON.stringify({ type: "subscribe", sessionId: "capacity" }));

        await wait(150); // several snapshot intervals — assert on the steady-state last one
        const last = snapshots[snapshots.length - 1];
        expect(last).toMatchObject({ event: "capacity_snapshot", sessions: 1, viewers: 2, producers: 1 });
        expect(typeof last!["instanceId"]).toBe("string"); // the replica-distinguishing field rides along on every line

        viewerA.close();
        viewerB.close();
        producer.close();
      } finally {
        restore();
      }
    });

    it("counts a session with viewers but no producer as zero producers", async () => {
      const { snapshots, restore } = captureCapacitySnapshots();
      try {
        server = await createRelayServer(0, { capacitySnapshot: { intervalMs: 30 } });
        const url = `ws://localhost:${server.port}`;

        const viewer = new WebSocket(url);
        await waitForOpen(viewer);
        viewer.send(JSON.stringify({ type: "subscribe", sessionId: "viewer-only" }));

        await wait(120);
        const last = snapshots[snapshots.length - 1];
        expect(last).toMatchObject({ event: "capacity_snapshot", sessions: 1, viewers: 1, producers: 0 });

        viewer.close();
      } finally {
        restore();
      }
    });
  });

  describe("cross-instance fan-out (shared StateBus)", () => {
    // These simulate two horizontally-scaled relay instances by giving two
    // separate createRelayServer calls the same LocalStateBus — proving the
    // StateBus abstraction's own fan-out is correct without needing real
    // Redis (none available in this sandbox; RedisStateBus gets its own
    // narrower tests against a fake client double instead).
    let servers: RelayServer[] = [];

    afterEach(async () => {
      await Promise.all(servers.map((s) => s.close()));
      servers = [];
    });

    async function createInstance(
      config?: {
        stateTtl?: { ttlMs: number; sweepIntervalMs: number };
        viewerCountFanout?: { heartbeatMs: number; freshnessMs: number };
      },
      stateBus = createLocalStateBus()
    ) {
      const instance = await createRelayServer(0, { stateBus, ...config });
      servers.push(instance);
      return { instance, stateBus };
    }

    it("a producer connected to instance A reaches a viewer connected to instance B", async () => {
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(undefined, bus);
      const { instance: instanceB } = await createInstance(undefined, bus);

      const viewer = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "cross-instance" }));
      await wait(50);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      const received = waitForMessage(viewer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("cross-instance", 1) }));

      const message = (await received) as { payload: { sequence: number } };
      expect(message.payload.sequence).toBe(1);

      viewer.close();
      producer.close();
    });

    it("a viewer newly joining instance B after a producer already sent state on instance A receives it immediately", async () => {
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(undefined, bus);
      const { instance: instanceB } = await createInstance(undefined, bus);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("cross-instance-late-join", 1) }));
      await wait(50);

      const viewer = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewer);
      const received = waitForMessage(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "cross-instance-late-join" }));

      const message = (await received) as { payload: { sequence: number } };
      expect(message.payload.sequence).toBe(1);

      viewer.close();
      producer.close();
    });

    it("a viewer joining an instance started AFTER the producer published (fresh replica) receives the state via the snapshot store", async () => {
      // Pub/sub alone can't cover this: instance C didn't exist when the
      // state message crossed the bus, so its only path to the current
      // board is StateBus.loadSnapshot — the rolling-deploy case where a
      // viewer routed to a just-started replica must not see a blank
      // overlay until the producer's next update.
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(undefined, bus);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("fresh-replica", 9) }));
      await wait(50);

      // Only NOW does instance C come up, sharing the same bus (= same
      // Redis in a real deployment) — it has never seen any message for
      // this session.
      const { instance: instanceC } = await createInstance(undefined, bus);
      const viewer = new WebSocket(`ws://localhost:${instanceC.port}`);
      await waitForOpen(viewer);
      const received = waitForMessage(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "fresh-replica" }));

      const message = (await received) as { payload: { sequence: number } };
      expect(message.payload.sequence).toBe(9);

      viewer.close();
      producer.close();
    });

    it("tells a producer on instance A the fleet-wide viewer count, tracking remote joins and leaves", async () => {
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(undefined, bus);
      const { instance: instanceB } = await createInstance(undefined, bus);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("count-sum", 1) }));
      await wait(50);

      const viewerOnA = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(viewerOnA);
      viewerOnA.send(JSON.stringify({ type: "subscribe", sessionId: "count-sum" }));

      const viewerB1 = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewerB1);
      viewerB1.send(JSON.stringify({ type: "subscribe", sessionId: "count-sum" }));
      const viewerB2 = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewerB2);
      const sawSumOfThree = waitForMessageMatching<{ type: string; count: number }>(
        producer,
        (m) => m.type === "viewer-count" && m.count === 3
      );
      viewerB2.send(JSON.stringify({ type: "subscribe", sessionId: "count-sum" }));

      // 1 local (instance A) + 2 remote (instance B) — the whole point of
      // the fan-out: without it the streamer's popup would show only the
      // local ~1/N slice (here, 1).
      await sawSumOfThree;

      // A remote leave propagates the same way: B publishes its new local
      // count on the disconnect, A recomputes 1 local + 1 remote.
      const sawSumOfTwo = waitForMessageMatching<{ type: string; count: number }>(
        producer,
        (m) => m.type === "viewer-count" && m.count === 2
      );
      viewerB1.close();
      await sawSumOfTwo;

      viewerOnA.close();
      viewerB2.close();
      producer.close();
    });

    it("prunes a silent instance's viewer count after the freshness window (crashed replica ages out instead of counting forever)", async () => {
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(
        // Heartbeat deliberately huge: this test is about what happens when
        // heartbeats STOP, and instance A ignores its own publishes anyway.
        { stateTtl: { ttlMs: 10_000, sweepIntervalMs: 30 }, viewerCountFanout: { heartbeatMs: 60_000, freshnessMs: 150 } },
        bus
      );

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("count-prune", 1) }));
      await wait(50);

      const localViewer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(localViewer);
      localViewer.send(JSON.stringify({ type: "subscribe", sessionId: "count-prune" }));

      // A "remote instance" that reports 7 viewers once and then goes
      // silent — exactly what a crashed/partitioned replica looks like on
      // the bus (its socket-close handlers never got to publish a zero).
      const sawEight = waitForMessageMatching<{ type: string; count: number }>(
        producer,
        (m) => m.type === "viewer-count" && m.count === 8
      );
      bus.publish({ kind: "viewer-count", sessionId: "count-prune", originInstanceId: "dead-instance", count: 7 });
      await sawEight;

      // No further reports from "dead-instance": once its last report ages
      // past freshnessMs, the sweep prunes it and re-tells the producer —
      // back to the 1 genuinely-connected local viewer.
      const sawPrunedCount = waitForMessageMatching<{ type: string; count: number }>(
        producer,
        (m) => m.type === "viewer-count" && m.count === 1
      );
      await sawPrunedCount;

      localViewer.close();
      producer.close();
    });

    it("re-publishes its local viewer count as a heartbeat while nonzero, and reports the zero when the last viewer leaves", async () => {
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance(
        { viewerCountFanout: { heartbeatMs: 40, freshnessMs: 10_000 } },
        bus
      );

      const received: { sessionId: string; count: number }[] = [];
      bus.subscribe((message) => {
        if (message.kind === "viewer-count" && message.sessionId === "heartbeat-session") {
          received.push({ sessionId: message.sessionId, count: message.count });
        }
      });

      const viewer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "heartbeat-session" }));

      // Several heartbeat periods: expect the admit-time publish plus at
      // least one periodic re-publish (generous margin — timers stretch
      // under parallel-suite load).
      await wait(300);
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every((m) => m.count === 1)).toBe(true);

      viewer.close();
      await wait(150);
      // The leave publishes a zero; with zero local viewers the heartbeat
      // then goes quiet, so the zero stays the final word.
      expect(received[received.length - 1]).toEqual({ sessionId: "heartbeat-session", count: 0 });
    });

    it("does not materialize sessions from bus traffic it has no local stake in (a later viewer is served by the snapshot, or nothing once it expired)", async () => {
      // Instance A publishes with a tiny TTL; instance B (large TTL) has no
      // viewer or producer for the session when the state crosses the bus.
      // If B had materialized a local copy from that message, a viewer
      // joining B inside B's OWN generous TTL window would be handed that
      // copy. Correct behavior: B kept nothing, and by join time the
      // snapshot has expired too (its TTL is A's, the publisher's), so the
      // viewer receives no state at all.
      const bus = createLocalStateBus();
      const { instance: instanceA } = await createInstance({ stateTtl: { ttlMs: 100, sweepIntervalMs: 10_000 } }, bus);
      const { instance: instanceB } = await createInstance({ stateTtl: { ttlMs: 60_000, sweepIntervalMs: 10_000 } }, bus);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("no-materialize", 1) }));
      await wait(200); // well past A's 100ms TTL — the snapshot is expired by now

      const viewer = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewer);
      let receivedAnything = false;
      viewer.on("message", () => {
        receivedAnything = true;
      });
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "no-materialize" }));
      await wait(100);

      expect(receivedAnything).toBe(false);

      viewer.close();
      producer.close();
    });

    it("a viewer on instance B receives the TTL-expiry clear when the producer (on instance A) disconnects", async () => {
      const bus = createLocalStateBus();
      const stateTtl = { ttlMs: 80, sweepIntervalMs: 20 };
      const { instance: instanceA } = await createInstance({ stateTtl }, bus);
      const { instance: instanceB } = await createInstance({ stateTtl }, bus);

      const viewer = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewer);
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "cross-instance-ttl" }));
      await wait(50);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      const firstReceived = waitForMessage(viewer);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("cross-instance-ttl", 1) }));
      await firstReceived;

      producer.close(); // gone, not just quiet — see the single-instance TTL tests above
      // Listener must be registered before the sweep can fire, not after —
      // the await below is what does the waiting (however long the sweep
      // actually takes), not a separate fixed delay beforehand.
      const staleReceived = waitForMessage(viewer);
      const message = (await staleReceived) as { payload: { cards: unknown[]; sequence: number } };
      expect(message.payload.cards).toEqual([]);
      expect(message.payload.sequence).toBe(2);

      viewer.close();
    });

    it("expires purely per-instance: bus silence past the TTL clears a remote instance's viewers while the producer's own instance keeps serving", async () => {
      // Direct proof of the local-expiry design (which replaced the earlier
      // cross-instance "authority" coordination): each instance judges
      // staleness only for its own copy, from its own lastUpdatedAt and its
      // own view of the producer connection. Instance A holds the (quiet
      // but open) producer, so A must keep its state and never clear its
      // viewers. Instance B only ever saw the state via the bus — with no
      // producer socket of its own, bus silence past the TTL is all B has,
      // so B's sweep clears B's viewers locally. Nothing crosses the bus
      // for expiry, so B's clear must never leak to A's viewers either.
      const bus = createLocalStateBus();
      const stateTtl = { ttlMs: 120, sweepIntervalMs: 20 };
      const { instance: instanceA } = await createInstance({ stateTtl }, bus);
      const { instance: instanceB } = await createInstance({ stateTtl }, bus);

      const viewerA = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(viewerA);
      viewerA.send(JSON.stringify({ type: "subscribe", sessionId: "local-expiry" }));
      const viewerB = new WebSocket(`ws://localhost:${instanceB.port}`);
      await waitForOpen(viewerB);
      viewerB.send(JSON.stringify({ type: "subscribe", sessionId: "local-expiry" }));
      await wait(50);

      const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
      await waitForOpen(producer);
      const firstOnA = waitForMessage(viewerA);
      const firstOnB = waitForMessage(viewerB);
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("local-expiry", 1) }));
      await Promise.all([firstOnA, firstOnB]);

      const messagesOnA: { cards: unknown[]; sequence: number }[] = [];
      const messagesOnB: { cards: unknown[]; sequence: number }[] = [];
      viewerA.on("message", (raw) => {
        messagesOnA.push((JSON.parse(raw.toString()) as { payload: { cards: unknown[]; sequence: number } }).payload);
      });
      viewerB.on("message", (raw) => {
        messagesOnB.push((JSON.parse(raw.toString()) as { payload: { cards: unknown[]; sequence: number } }).payload);
      });

      // The producer stays open and silent (a static board) well past the
      // TTL — long enough for several sweep ticks on both instances.
      await wait(350);

      // B cleared its own viewers exactly once (latestState nulled, so its
      // sweep can't re-fire) ...
      expect(messagesOnB).toHaveLength(1);
      expect(messagesOnB[0]!.cards).toEqual([]);
      expect(messagesOnB[0]!.sequence).toBe(2);
      // ... while A, still holding the open producer socket, never cleared.
      expect(messagesOnA).toEqual([]);

      viewerA.close();
      viewerB.close();
      producer.close();
    });
  });
});
