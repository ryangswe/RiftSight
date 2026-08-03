// End-to-end integration coverage for the closed-beta flow described in
// README's "Closed beta" section: allowlist -> OAuth account linking ->
// producer credential issuance -> authenticated producer publish -> real
// Twitch-JWT viewer subscribe, all composed together against real WS
// connections and a real database. Complements, doesn't duplicate:
// server.test.ts (legacy unauthenticated path, untouched),
// server.producer-auth.test.ts (producer-auth mechanics in isolation),
// auth-twitch.test.ts / producer-credential.test.ts (route-level unit
// coverage). This file's job is proving the pieces actually compose into
// the one continuous path a real streamer and viewer exercise.

import { Response } from "node-fetch";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createDbClient, type DbClient } from "./db/client.js";
import { loadMigrations, runMigrations } from "./db/migrate.js";
import { addToAllowlist, isAllowed, removeFromAllowlist } from "./db/allowlist.js";
import { getBroadcasterByTwitchUserId, upsertBroadcaster } from "./db/broadcasters.js";
import { issueProducerCredential, validateProducerCredential } from "./db/producer-credentials.js";
import { createStateStore, type StateStore } from "./auth/state-store.js";
import { createLinkHandoffStore, type LinkHandoffStore } from "./auth/link-handoff.js";
import type { FetchLike, TwitchOAuthConfig } from "./auth/twitch-oauth.js";
import { handleAuthCallback } from "./http/routes/auth-twitch.js";
import { handleRotateProducerCredential } from "./http/routes/producer-credential.js";
import { createRelayServer, type RelayServer } from "./server.js";

const BASE64_SECRET = Buffer.from("test-extension-secret-bytes").toString("base64");
const secretBytes = Buffer.from(BASE64_SECRET, "base64");

function signViewerToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, secretBytes, { algorithm: "HS256", expiresIn: "1h" });
}

const oauthConfig: TwitchOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://beta.example.com/auth/twitch/callback",
};

function successfulFetch(userId: string, login: string): FetchLike {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) {
      return new Response(
        JSON.stringify({ access_token: "access-123", refresh_token: "r", expires_in: 100, scope: [], token_type: "bearer" }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ user_id: userId, login }), { status: 200 });
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<{ type: string; payload: { sessionId: string; sequence: number } }> {
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

async function linkAndRedeem(db: DbClient, stateStore: StateStore, linkHandoff: LinkHandoffStore, linkId: string): Promise<string> {
  const state = stateStore.issue(linkId);
  const response = await handleAuthCallback(
    { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} },
    { config: oauthConfig, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") }
  );
  expect(response.status).toBe(200);
  const redeemed = linkHandoff.redeem(linkId);
  expect(redeemed).toBeDefined();
  return redeemed!.credential;
}

let db: DbClient;
let stateStore: StateStore;
let linkHandoff: LinkHandoffStore;
let server: RelayServer | undefined;

beforeEach(async () => {
  db = createDbClient(":memory:");
  const migrations = await loadMigrations();
  await runMigrations(db, migrations);
  stateStore = createStateStore();
  linkHandoff = createLinkHandoffStore();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
});

describe("closed-beta flow: allowlist -> OAuth link -> producer credential -> authenticated publish -> Twitch-JWT viewer subscribe", () => {
  it("a full happy path works end-to-end, with the viewer's channel resolved from the producer credential, not the client-claimed sessionId", async () => {
    await addToAllowlist(db, "141981764");
    const credential = await linkAndRedeem(db, stateStore, linkHandoff, "e2e-link-1");

    server = await createRelayServer(0, { twitchExtensionSecret: BASE64_SECRET, producerAuth: { db, required: true } });

    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${credential}`);
    await waitForOpen(producer);

    const viewerToken = signViewerToken({ channel_id: "141981764", role: "viewer", opaque_user_id: "U1" });
    const viewer = new WebSocket(`ws://localhost:${server.port}`);
    await waitForOpen(viewer);
    const received = waitForMessage(viewer);
    viewer.send(JSON.stringify({ type: "twitch-subscribe", channelId: "141981764", token: viewerToken }));
    await wait(50);

    // Deliberately claims a bogus sessionId — the server must ignore it.
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("someone-elses-channel", 1) }));
    const message = await received;
    expect(message.payload.sessionId).toBe("141981764");
    expect(message.payload.sequence).toBe(1);

    producer.close();
    viewer.close();
  });

  it("rotating a producer credential invalidates the old one and permits the new one to connect", async () => {
    await addToAllowlist(db, "141981764");
    const oldCredential = await linkAndRedeem(db, stateStore, linkHandoff, "e2e-link-2");

    const rotateResponse = await handleRotateProducerCredential(
      { method: "POST", url: "/api/producer-credential/rotate", headers: { authorization: `Bearer ${oldCredential}` } },
      db
    );
    expect(rotateResponse.status).toBe(200);
    const { credential: newCredential } = JSON.parse(rotateResponse.body) as { credential: string };

    server = await createRelayServer(0, { producerAuth: { db, required: true } });

    const oldAttempt = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${oldCredential}`);
    await expect(waitForOpen(oldAttempt)).rejects.toBeDefined();

    const newAttempt = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${newCredential}`);
    await waitForOpen(newAttempt);
    newAttempt.close();
  });

  it("removing a broadcaster from the allowlist mid-beta blocks their next producer connection attempt, even with a still-unrevoked credential", async () => {
    await addToAllowlist(db, "141981764");
    const credential = await linkAndRedeem(db, stateStore, linkHandoff, "e2e-link-3");

    await removeFromAllowlist(db, "141981764");

    server = await createRelayServer(0, { producerAuth: { db, required: true } });
    const producer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${credential}`);
    await expect(waitForOpen(producer)).rejects.toBeDefined();
  });
});

describe("persistence across a restart", () => {
  it("broadcaster identity, allowlist status, and producer credential validity all survive closing and reopening the same database file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "riftsight-persistence-"));
    const dbPath = `file:${path.join(dir, "test.db")}`;
    try {
      let fileDb = createDbClient(dbPath);
      const migrations = await loadMigrations();
      await runMigrations(fileDb, migrations);
      await addToAllowlist(fileDb, "141981764");
      const broadcaster = await upsertBroadcaster(fileDb, "141981764", "juicykaraage");
      const credential = await issueProducerCredential(fileDb, broadcaster.id);
      fileDb.close();

      // Reopen as a genuinely separate client instance against the same file.
      fileDb = createDbClient(dbPath);
      const reloadedBroadcaster = await getBroadcasterByTwitchUserId(fileDb, "141981764");
      expect(reloadedBroadcaster?.twitchLogin).toBe("juicykaraage");
      expect(await isAllowed(fileDb, "141981764")).toBe(true);
      const validated = await validateProducerCredential(fileDb, credential);
      expect(validated?.twitchUserId).toBe("141981764");

      await removeFromAllowlist(fileDb, "141981764");
      fileDb.close();

      // A third open confirms the removal itself persisted too, not just the original data.
      fileDb = createDbClient(dbPath);
      expect(await isAllowed(fileDb, "141981764")).toBe(false);
      expect(await validateProducerCredential(fileDb, credential)).toBeNull();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session recovery across a relay restart", () => {
  it("a producer and viewer can reconnect and exchange fresh state after the relay process itself restarts, with no leftover in-memory session state from before the restart interfering", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "riftsight-restart-"));
    const dbPath = `file:${path.join(dir, "test.db")}`;
    try {
      const fileDb = createDbClient(dbPath);
      const migrations = await loadMigrations();
      await runMigrations(fileDb, migrations);
      await addToAllowlist(fileDb, "141981764");
      const broadcaster = await upsertBroadcaster(fileDb, "141981764", "juicykaraage");
      const credential = await issueProducerCredential(fileDb, broadcaster.id);

      // First "process": producer connects and publishes, viewer receives it.
      server = await createRelayServer(0, { producerAuth: { db: fileDb, required: true } });
      const port = server.port;

      const firstProducer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${credential}`);
      await waitForOpen(firstProducer);
      const firstViewer = new WebSocket(`ws://localhost:${server.port}`);
      await waitForOpen(firstViewer);
      const firstReceived = waitForMessage(firstViewer);
      firstViewer.send(JSON.stringify({ type: "subscribe", sessionId: "141981764" }));
      await wait(50);
      firstProducer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("whatever-client-claims", 1) }));
      const firstMessage = await firstReceived;
      expect(firstMessage.payload.sessionId).toBe("141981764");

      firstProducer.close();
      firstViewer.close();

      // Simulate a real backend restart: close the relay process entirely
      // (all in-memory session/viewer/producer state is gone — nothing
      // like sessions Map survives this) and start a brand new one bound
      // to the same port, against the same persistent database file so
      // broadcaster identity/allowlist/credential validity carry over
      // exactly as the "persistence across a restart" tests above already
      // prove independently.
      await server.close();
      server = await createRelayServer(port, { producerAuth: { db: fileDb, required: true } });

      // A fresh producer connection with the same (still-valid, unrevoked,
      // unrotated) credential must be accepted — the restart didn't
      // require re-issuing anything.
      const secondProducer = new WebSocket(`ws://localhost:${server.port}/ws/producer?credential=${credential}`);
      await waitForOpen(secondProducer);

      // A fresh viewer subscription after the restart must also work and
      // receive newly-published state — proving the new process's session
      // bookkeeping is fully independent of whatever existed before the
      // restart, not silently broken by some leftover reference.
      const secondViewer = new WebSocket(`ws://localhost:${server.port}`);
      await waitForOpen(secondViewer);
      const secondReceived = waitForMessage(secondViewer);
      secondViewer.send(JSON.stringify({ type: "subscribe", sessionId: "141981764" }));
      await wait(50);
      secondProducer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("whatever-client-claims", 1) }));
      const secondMessage = await secondReceived;
      expect(secondMessage.payload.sessionId).toBe("141981764");
      expect(secondMessage.payload.sequence).toBe(1);

      secondProducer.close();
      secondViewer.close();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
