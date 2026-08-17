// Integration tests for the authenticated /ws/producer endpoint added in
// Stage 7. Deliberately a separate file from server.test.ts, which the
// milestone plan requires to keep passing completely unmodified — every
// test there constructs a RelayServer with no producerAuth config at all,
// so none of this is reachable from that file's coverage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createDbClient, type DbClient } from "./db/client.js";
import { loadMigrations, runMigrations } from "./db/migrate.js";
import { addToAllowlist } from "./db/allowlist.js";
import { linkOrCreateBroadcasterWithIdentity } from "./db/identities.js";
import { issueProducerCredential } from "./db/producer-credentials.js";
import { createRelayServer, type RelayServer } from "./server.js";

let db: DbClient;
let server: RelayServer | undefined;
let broadcasterId: number;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, await loadMigrations());
  await addToAllowlist(db, "141981764");
  const broadcaster = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "141981764", "juicykaraage");
  broadcasterId = broadcaster.broadcasterId;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
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

function sampleState(sessionId: string, sequence: number) {
  return {
    protocolVersion: 1,
    sessionId,
    sequence,
    capturedAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    cards: [],
  };
}

describe("authenticated producer WebSocket (/ws/producer)", () => {
  it("accepts a valid credential and routes its state to the credential's own channel, ignoring a different client-claimed sessionId", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const token = await issueProducerCredential(db, broadcasterId);

    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${token}`);
    await waitForOpen(producer);

    const viewer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(viewer);
    const received = waitForMessage(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: String(broadcasterId) }));
    await wait(50);

    // Client claims a bogus sessionId — the server must ignore it and use
    // the credential-resolved internal broadcaster session key instead
    // (see sessionKeyForBroadcaster; platform channel ids resolve to this
    // same key on the viewer paths).
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("someone-elses-channel", 1) }));

    const message = (await received) as { payload: { sessionId: string; sequence: number } };
    expect(message.payload.sessionId).toBe(String(broadcasterId));
    expect(message.payload.sequence).toBe(1);

    producer.close();
    viewer.close();
  });

  it("rejects the upgrade for a missing credential", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer`);
    await expect(waitForOpen(producer)).rejects.toBeDefined();
  });

  it("rejects the upgrade for an unknown/invalid credential", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=not-a-real-token`);
    await expect(waitForOpen(producer)).rejects.toBeDefined();
  });

  it("rejects the upgrade once the broadcaster is removed from the allowlist, even with a previously-valid credential", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const token = await issueProducerCredential(db, broadcasterId);
    await db.execute({ sql: "DELETE FROM twitch_allowlist WHERE twitch_user_id = ?", args: ["141981764"] });

    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${token}`);
    await expect(waitForOpen(producer)).rejects.toBeDefined();
  });

  it("replaces an existing authenticated producer connection for the same channel rather than rejecting the new one", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const token = await issueProducerCredential(db, broadcasterId);

    const firstProducer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${token}`);
    await waitForOpen(firstProducer);
    const firstClosed = waitForClose(firstProducer);

    const secondProducer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${token}`);
    await waitForOpen(secondProducer);

    const { code, reason } = await firstClosed;
    expect(code).toBe(4409);
    expect(reason).toBe("replaced-by-new-producer-connection");

    // The surviving connection is the new one — it can still publish.
    const viewer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(viewer);
    const received = waitForMessage(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: String(broadcasterId) }));
    await wait(50);
    secondProducer.send(JSON.stringify({ type: "overlay-state", payload: sampleState(String(broadcasterId), 1) }));
    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);

    secondProducer.close();
    viewer.close();
  });

  it("rejects an overlay-state message from an unauthenticated (legacy bare-socket) producer when producerAuth.required is true", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: true } });

    const viewer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "141981764" }));
    await wait(50);
    let receivedAnything = false;
    viewer.on("message", () => {
      receivedAnything = true;
    });

    const unauthenticatedProducer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(unauthenticatedProducer);
    unauthenticatedProducer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("141981764", 1) }));
    await wait(100);

    expect(receivedAnything).toBe(false);

    unauthenticatedProducer.close();
    viewer.close();
  });

  it("still accepts an unauthenticated bare-socket producer when producerAuth is configured but required is false", async () => {
    server = await createRelayServer(0, { producerAuth: { db, required: false } });

    const viewer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "dev-session" }));
    await wait(50);

    const producer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(producer);
    const received = waitForMessage(viewer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("dev-session", 1) }));

    const message = (await received) as { payload: { sequence: number } };
    expect(message.payload.sequence).toBe(1);

    producer.close();
    viewer.close();
  });
});
