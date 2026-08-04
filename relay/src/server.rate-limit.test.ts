// Integration tests for the Stage 9 limits added on top of the base relay
// (message/card size caps, per-connection update-rate cap, consecutive-
// invalid-message disconnect, subscribe-attempt disconnect). Kept separate
// from server.test.ts, which must keep passing completely unmodified.

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "./server.js";
import { MAX_CARDS_PER_SNAPSHOT, MAX_CONSECUTIVE_INVALID_MESSAGES, MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET } from "./rate-limit.js";

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

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
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

function sampleState(sessionId: string, sequence: number, cardCount = 0) {
  return {
    protocolVersion: 1,
    sessionId,
    sequence,
    capturedAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    cards: Array.from({ length: cardCount }, (_, i) => ({
      instanceId: `card_${i}`,
      zone: "hand",
      owner: "self",
      visibility: "public",
      cardId: "OGN-213",
      bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      rotation: 0,
      landscape: false,
      localWidth: 0.1,
      localHeight: 0.1,
    })),
  };
}

describe("relay server rate/size limits", () => {
  it("rejects a snapshot with more than MAX_CARDS_PER_SNAPSHOT cards without broadcasting it", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "too-many-cards" }));
    await wait(50);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send(
      JSON.stringify({ type: "overlay-state", payload: sampleState("too-many-cards", 1, MAX_CARDS_PER_SNAPSHOT + 1) })
    );
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
    producer.close();
  });

  it("rejects an oversized message without broadcasting it or crashing the connection", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "oversized" }));
    await wait(50);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    const huge = "x".repeat(300_000); // over MAX_MESSAGE_BYTES (256 KiB)
    producer.send(JSON.stringify({ type: "overlay-state", payload: { ...sampleState("oversized", 1), padding: huge } }));
    await wait(100);

    expect(receivedAnything).toBe(false);
    expect(producer.readyState).toBe(WebSocket.OPEN); // a single oversized message doesn't disconnect the socket

    viewer.close();
    producer.close();
  });

  it("disconnects a producer after MAX_CONSECUTIVE_INVALID_MESSAGES consecutive validation failures", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    const closed = waitForClose(producer);

    for (let i = 0; i < MAX_CONSECUTIVE_INVALID_MESSAGES; i++) {
      producer.send("not valid json");
    }

    const { code, reason } = await closed;
    expect(code).toBe(4400);
    expect(reason).toBe("too-many-invalid-messages");
  });

  it("a single invalid message does not disconnect the socket, and a later valid message still succeeds", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "resilient" }));
    await wait(50);

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    producer.send("garbage");
    await wait(50);

    const received = waitForMessage(viewer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("resilient", 1) }));
    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);
    expect(producer.readyState).toBe(WebSocket.OPEN);

    viewer.close();
    producer.close();
  });

  it("disconnects a viewer socket after too many subscribe attempts", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    const closed = waitForClose(viewer);

    for (let i = 0; i <= MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET; i++) {
      viewer.send(JSON.stringify({ type: "subscribe", sessionId: `session-${i}` }));
    }

    const { code, reason } = await closed;
    expect(code).toBe(4401);
    expect(reason).toBe("too-many-subscribe-attempts");
  });

  it("drops overlay-state messages beyond the per-second producer update rate without disconnecting", async () => {
    server = await createRelayServer(0);
    const url = `ws://localhost:${server.port}`;

    const viewer = new WebSocket(url);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "rate-limited" }));
    await wait(50);

    let receivedCount = 0;
    viewer.on("message", () => {
      receivedCount += 1;
    });

    const producer = new WebSocket(url);
    await waitForOpen(producer);
    // Far more than MAX_PRODUCER_UPDATES_PER_SECOND (20) within well under a second.
    for (let i = 1; i <= 40; i++) {
      producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("rate-limited", i) }));
    }
    await wait(150);

    expect(receivedCount).toBeGreaterThan(0);
    expect(receivedCount).toBeLessThan(40);
    expect(producer.readyState).toBe(WebSocket.OPEN); // rate-limited, not treated as invalid/malicious

    viewer.close();
    producer.close();
  });
});
