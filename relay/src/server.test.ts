import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "./server.js";

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
        },
      ],
    };
    producer.send(JSON.stringify({ type: "overlay-state", payload: leaky }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    viewer.close();
    producer.close();
  });
});
