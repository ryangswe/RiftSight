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
});
