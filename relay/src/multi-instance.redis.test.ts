// Real-Redis multi-instance harness — the one place Stage 1 is exercised
// against an actual `redis-server` process rather than a shared
// LocalStateBus or a fake client double. Two things only THIS setup can
// prove: that the ioredis wiring (two connections, SUBSCRIBE routing,
// SET PX/GET) actually speaks Redis, and that a genuinely separate
// instance — its own RedisStateBus, its own connections, started AFTER a
// publish — recovers state via the snapshot key (a shared LocalStateBus
// object can't represent that, because sharing the bus object IS the
// cheat: a real fresh replica shares nothing but Redis itself).
//
// Self-contained: spawns its own redis-server on a high port in
// beforeAll (no daemon, no persistence, dies with the test run) and
// skips cleanly when the binary is absent (CI, other machines) — local
// setup is one `brew install redis`. Run just this file via
// `npm run test:redis`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createRelayServer, type RelayServer } from "./server.js";
import { createRedisStateBus, type RedisStateBus } from "./redis-state-bus.js";

const redisServerAvailable = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;

// Deterministic-ish high port, offset by pid so two concurrent checkouts
// (or a leaked previous run) don't collide.
const REDIS_PORT = 16400 + (process.pid % 100);
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;

function waitForPortOpen(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`redis-server did not accept connections on :${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

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

describe.skipIf(!redisServerAvailable)("multi-instance against a real redis-server", () => {
  let redisProcess: ChildProcess;
  const servers: RelayServer[] = [];
  const buses: RedisStateBus[] = [];

  beforeAll(async () => {
    // No persistence of any kind — this Redis exists only for the lifetime
    // of the test run, and a leftover dump/AOF from a previous run could
    // resurrect stale snapshot keys into a fresh one.
    redisProcess = spawn("redis-server", ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no"], {
      stdio: "ignore",
    });
    await waitForPortOpen(REDIS_PORT, 15_000);
  }, 30_000);

  afterAll(async () => {
    redisProcess?.kill();
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers.length = 0;
    await Promise.all(buses.map((b) => b.close()));
    buses.length = 0;
  });

  /** A genuinely independent relay instance: its own RedisStateBus (its own two Redis connections), sharing nothing with any other instance except the Redis server itself — exactly the production replica topology. */
  async function createInstance(config?: {
    stateTtl?: { ttlMs: number; sweepIntervalMs: number };
    viewerCountFanout?: { heartbeatMs: number; freshnessMs: number };
  }): Promise<RelayServer> {
    const bus = createRedisStateBus(REDIS_URL);
    buses.push(bus);
    const instance = await createRelayServer(0, { stateBus: bus, ...config });
    servers.push(instance);
    return instance;
  }

  it("fans a producer's state out from instance A to a viewer on instance B through real Redis pub/sub", async () => {
    const instanceA = await createInstance();
    const instanceB = await createInstance();

    const viewer = new WebSocket(`ws://localhost:${instanceB.port}`);
    await waitForOpen(viewer);
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "redis-fanout" }));
    await wait(100); // let the subscribe register on B before A publishes

    const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(producer);
    const received = waitForMessageMatching<{ type: string; payload: { sequence: number } }>(
      viewer,
      (m) => m.type === "overlay-state" && m.payload.sequence === 1
    );
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("redis-fanout", 1) }));

    await received;

    viewer.close();
    producer.close();
  });

  it("serves the latest state to a viewer on an instance started AFTER the publish, via the Redis snapshot key", async () => {
    const instanceA = await createInstance();

    const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("redis-late-join", 7) }));
    await wait(100); // let the publish (and its snapshot SET) reach Redis

    // The fresh replica: created only now, with brand-new Redis
    // connections — it has never seen a pub/sub message for this session.
    const instanceC = await createInstance();
    const viewer = new WebSocket(`ws://localhost:${instanceC.port}`);
    await waitForOpen(viewer);
    const received = waitForMessageMatching<{ type: string; payload: { sequence: number } }>(
      viewer,
      (m) => m.type === "overlay-state" && m.payload.sequence === 7
    );
    viewer.send(JSON.stringify({ type: "subscribe", sessionId: "redis-late-join" }));

    await received;

    viewer.close();
    producer.close();
  });

  it("aggregates viewer counts across instances — a producer on A is told about viewers on B", async () => {
    const instanceA = await createInstance();
    const instanceB = await createInstance();

    const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(producer);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("redis-count", 1) }));
    await wait(100);

    const viewerOnA = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(viewerOnA);
    viewerOnA.send(JSON.stringify({ type: "subscribe", sessionId: "redis-count" }));

    const sawSumOfTwo = waitForMessageMatching<{ type: string; count: number }>(
      producer,
      (m) => m.type === "viewer-count" && m.count === 2
    );
    const viewerOnB = new WebSocket(`ws://localhost:${instanceB.port}`);
    await waitForOpen(viewerOnB);
    viewerOnB.send(JSON.stringify({ type: "subscribe", sessionId: "redis-count" }));

    await sawSumOfTwo; // 1 local (A) + 1 remote (B)

    viewerOnA.close();
    viewerOnB.close();
    producer.close();
  });

  it("expires state on BOTH instances' own timers once the producer disconnects — viewers everywhere receive the synthesized clear", async () => {
    const stateTtl = { ttlMs: 150, sweepIntervalMs: 30 };
    const instanceA = await createInstance({ stateTtl });
    const instanceB = await createInstance({ stateTtl });

    const viewerOnA = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(viewerOnA);
    viewerOnA.send(JSON.stringify({ type: "subscribe", sessionId: "redis-ttl" }));
    const viewerOnB = new WebSocket(`ws://localhost:${instanceB.port}`);
    await waitForOpen(viewerOnB);
    viewerOnB.send(JSON.stringify({ type: "subscribe", sessionId: "redis-ttl" }));
    await wait(100);

    const producer = new WebSocket(`ws://localhost:${instanceA.port}`);
    await waitForOpen(producer);
    const firstOnA = waitForMessageMatching<{ payload: { sequence: number } }>(viewerOnA, (m) => m.payload.sequence === 1);
    const firstOnB = waitForMessageMatching<{ payload: { sequence: number } }>(viewerOnB, (m) => m.payload.sequence === 1);
    producer.send(JSON.stringify({ type: "overlay-state", payload: sampleState("redis-ttl", 1) }));
    await Promise.all([firstOnA, firstOnB]);

    // Each instance sweeps its own copy on its own timer — A because its
    // local producer socket is gone, B because the bus has gone silent
    // past the TTL. No expiry coordination crosses Redis (see
    // sweepStaleSessions); the clears are locally synthesized sequence-2
    // empty states on both sides.
    const clearOnA = waitForMessageMatching<{ payload: { cards: unknown[]; sequence: number } }>(
      viewerOnA,
      (m) => m.payload.sequence === 2 && m.payload.cards.length === 0
    );
    const clearOnB = waitForMessageMatching<{ payload: { cards: unknown[]; sequence: number } }>(
      viewerOnB,
      (m) => m.payload.sequence === 2 && m.payload.cards.length === 0
    );
    producer.close();
    await Promise.all([clearOnA, clearOnB]);

    viewerOnA.close();
    viewerOnB.close();
  });
});
