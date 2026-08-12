import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "./server.js";

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

    const received = waitForMessage(producer);
    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "viewer-count-session" }));

    const message = (await received) as { type: string; count: number };
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

    const received = waitForMessage(producer);
    viewer.close();

    const message = (await received) as { type: string; count: number };
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
      let viewerReceivedAnything = false;
      viewer.on("message", () => {
        viewerReceivedAnything = true;
      });
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: "quiet-but-connected" }));
      await wait(50); // the initial admit-time send of the existing state

      viewerReceivedAnything = false; // only care about anything AFTER this point — no synthesized clear should ever arrive
      await wait(250); // comfortably past ttlMs and several sweep ticks, producer still open, still silent
      expect(viewerReceivedAnything).toBe(false);

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
});
