// Load / soak harness for the multi-instance relay — the thing that turns
// "the fan-out code is correct" (proven by the test suite) into "the
// fan-out code performs and stays bounded under sustained load" (which
// nothing else measures). Runs entirely locally: spawns its own
// redis-server and TWO real relay processes (separate processes, so their
// RSS is measured in isolation from this load driver), then drives real
// producer/viewer WebSocket traffic through them and reports latency,
// throughput, per-instance memory/CPU trend, and delivery integrity.
//
// It is deliberately NOT a vitest test: a soak run is informational and
// duration-configurable, not a fast pass/fail. Run it with
// `npm run soak` (sensible small defaults, ~30s) and scale it up with the
// env vars below for a real stress or leak hunt. If SOAK_MAX_P99_MS or
// SOAK_MAX_RSS_GROWTH_MB is set, it also exits non-zero when a threshold
// is breached, so it can gate a manual check.
//
// Why separate relay processes rather than in-process createRelayServer:
// the whole point is honest memory measurement, and an in-process relay's
// RSS would be inseparable from the hundreds of client sockets this driver
// itself holds. Spawning `src/index.ts` (the real production entrypoint,
// in development mode) also means we soak the actual boot path, not a
// stripped-down test double.
//
// Env vars (all optional):
//   SOAK_DURATION_MS       total run time after ramp-up          (default 30000)
//   SOAK_VIEWERS           concurrent viewer sockets              (default 200)
//   SOAK_PUBLISH_HZ        producer updates/sec, per session      (default 5)
//   SOAK_SESSIONS          distinct concurrent sessions/producers (default 4)
//   SOAK_SESSION_ROTATE_MS retire+recreate one session this often (default 0 = off)
//                          — exercises the sessions-map lifecycle: a large
//                          run with rotation on is how the (currently
//                          un-reaped) sessions Map's growth shows up as an
//                          RSS trend.
//   REDIS_URL              use an existing Redis instead of spawning one
//   SOAK_MAX_P99_MS        fail the run if p99 latency exceeds this
//   SOAK_MAX_RSS_GROWTH_MB fail the run if either relay's RSS grows past this
//
// Requires `redis-server` on PATH (brew install redis) unless REDIS_URL is
// set; exits with a clear message otherwise.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`[soak] ${name}="${raw}" is not a non-negative number`);
    process.exit(2);
  }
  return parsed;
}

const DURATION_MS = intEnv("SOAK_DURATION_MS", 30_000);
const VIEWERS = intEnv("SOAK_VIEWERS", 200);
const PUBLISH_HZ = intEnv("SOAK_PUBLISH_HZ", 5);
const SESSIONS = Math.max(1, intEnv("SOAK_SESSIONS", 4));
const SESSION_ROTATE_MS = intEnv("SOAK_SESSION_ROTATE_MS", 0);
const MAX_P99_MS = process.env["SOAK_MAX_P99_MS"] ? intEnv("SOAK_MAX_P99_MS", 0) : undefined;
const MAX_RSS_GROWTH_MB = process.env["SOAK_MAX_RSS_GROWTH_MB"] ? intEnv("SOAK_MAX_RSS_GROWTH_MB", 0) : undefined;

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const relayDir = resolve(scriptDir, "..");
const repoRoot = resolve(relayDir, "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

const OWN_REDIS = !process.env["REDIS_URL"];
const REDIS_PORT = 16600 + (process.pid % 100);
const REDIS_URL = process.env["REDIS_URL"] ?? `redis://127.0.0.1:${REDIS_PORT}`;
const PORT_A = 18700 + (process.pid % 50);
const PORT_B = PORT_A + 1;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForPortOpen(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const attempt = (): void => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        res();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) rej(new Error(`nothing listening on :${port} within ${timeoutMs}ms`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Fixed-bucket latency histogram — O(1) memory regardless of run length (a long soak can deliver millions of samples, so storing them all just to take quantiles would itself be a memory confound). 1ms buckets up to 500ms, one overflow bucket, exact max/mean tracked separately. */
class Histogram {
  private readonly buckets = new Int32Array(501); // index 0..500 ms; 500 = "500+"
  private countN = 0;
  private sum = 0;
  private maxV = 0;

  record(ms: number): void {
    if (ms < 0) ms = 0;
    const idx = ms >= 500 ? 500 : Math.floor(ms);
    this.buckets[idx]! += 1;
    this.countN += 1;
    this.sum += ms;
    if (ms > this.maxV) this.maxV = ms;
  }

  get count(): number {
    return this.countN;
  }

  get mean(): number {
    return this.countN === 0 ? 0 : this.sum / this.countN;
  }

  get max(): number {
    return this.maxV;
  }

  quantile(q: number): number {
    if (this.countN === 0) return 0;
    const target = q * this.countN;
    let cumulative = 0;
    for (let i = 0; i <= 500; i++) {
      cumulative += this.buckets[i]!;
      if (cumulative >= target) return i;
    }
    return 500;
  }
}

/** Samples a process's RSS (MB) and CPU (%) via `ps` — the OS's own view, faithfully separating each relay's footprint from this driver's. Returns null if the process is gone. NOTE: `ps pcpu` is a *lifetime* average (CPU time / elapsed since the process started), not a windowed rate, so it under-reports a burst that arrives after a longer idle boot — RSS, latency, and throughput are the load-faithful signals here; treat the CPU figure as a coarse floor. A windowed CPU% (diffing cumulative `ps -o cputime` between samples) is the obvious refinement if CPU headroom ever becomes the question. */
function sampleProcess(pid: number): { rssMb: number; cpu: number } | null {
  const out = spawnSync("ps", ["-o", "rss=", "-o", "pcpu=", "-p", String(pid)], { encoding: "utf8" });
  const line = out.stdout.trim();
  if (!line) return null;
  const parts = line.split(/\s+/);
  const rssKb = Number(parts[0]);
  const cpu = Number(parts[1]);
  if (!Number.isFinite(rssKb)) return null;
  return { rssMb: rssKb / 1024, cpu: Number.isFinite(cpu) ? cpu : 0 };
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
/** The relay Node processes themselves — see resolveRelayPid. Killed explicitly in cleanup because a SIGKILL to the tsx wrapper that spawned them is never forwarded, which is how earlier runs left orphaned relays holding the 187xx ports for days. */
const relayPids: number[] = [];
let cleanedUp = false;

function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const pid of relayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

/**
 * `spawn(tsxBin, …)` starts tsx's CLI wrapper, which in turn spawns the real
 * Node process running the relay — so the ChildProcess's pid is the wrapper's,
 * and sampling it reports a flat ~35 MB supervisor instead of the relay (a
 * bug that made every earlier soak's RSS column meaningless and its
 * SOAK_MAX_RSS_GROWTH_MB gate unable to fire). Resolve the wrapper's direct
 * child instead; falls back to the wrapper pid if none is found yet.
 */
function resolveRelayPid(wrapperPid: number): number {
  const out = spawnSync("pgrep", ["-P", String(wrapperPid)], { encoding: "utf8" });
  const first = out.stdout.trim().split(/\s+/)[0];
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : wrapperPid;
}

function spawnRelay(port: number): ChildProcess {
  const child = spawn(tsxBin, ["src/index.ts"], {
    cwd: relayDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      RIFTSIGHT_MODE: "development", // unauthenticated producer + local-debug viewer paths, no secrets required
      RELAY_PORT: String(port),
      REDIS_URL,
      // Own temp DB per instance so nothing about SQLite file-locking
      // contends and confounds the WS-path measurement (the hot path
      // never touches the DB in development mode anyway).
      RIFTSIGHT_DB_PATH: `file:${join(tmpdir(), `riftsight-soak-${port}.db`)}`,
    },
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  child.on("exit", (code) => {
    if (!cleanedUp && code !== 0 && code !== null) {
      console.error(`[soak] relay on :${port} exited early (code ${code}):\n${stderr}`);
    }
  });
  return child;
}

// ---------------------------------------------------------------------------
// Load model
// ---------------------------------------------------------------------------

const CARD_TEMPLATE = Array.from({ length: 12 }, (_, i) => ({
  instanceId: `card_${i}`,
  zone: "battlefield" as const,
  owner: "self" as const,
  visibility: "public" as const,
  cardId: `OGN-${100 + i}`,
  bounds: { x: (i % 6) * 0.15, y: i < 6 ? 0.3 : 0.6, width: 0.09, height: 0.16 },
  rotation: 0,
  landscape: false,
  localWidth: 0.09,
  localHeight: 0.16,
  fromDialog: false,
}));

function statePayload(sessionId: string, sequence: number) {
  return {
    protocolVersion: 1,
    sessionId,
    sequence,
    capturedAt: Date.now(), // read back on the viewer to compute end-to-end latency (same machine, same clock)
    sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    cards: CARD_TEMPLATE,
  };
}

interface Metrics {
  delivered: number;
  latency: Histogram;
  sequenceGaps: number;
  unexpectedViewerCloses: number;
}

const metrics: Metrics = {
  delivered: 0,
  latency: new Histogram(),
  sequenceGaps: 0,
  unexpectedViewerCloses: 0,
};

let running = true;

/** One producer: connects to instance A and republishes its session's state at PUBLISH_HZ until stopped. Returns a stop() that closes the socket. */
function startProducer(sessionId: string): () => void {
  const ws = new WebSocket(`ws://localhost:${PORT_A}`);
  let sequence = 0;
  let timer: NodeJS.Timeout | undefined;
  ws.on("open", () => {
    const tick = (): void => {
      if (!running || ws.readyState !== WebSocket.OPEN) return;
      sequence += 1;
      ws.send(JSON.stringify({ type: "overlay-state", payload: statePayload(sessionId, sequence) }));
    };
    tick();
    timer = setInterval(tick, Math.max(1, Math.round(1000 / PUBLISH_HZ)));
  });
  ws.on("error", () => {}); // a producer socket closed during teardown is expected, not a failure
  return () => {
    if (timer) clearInterval(timer);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
}

/** One viewer: subscribes to sessionId on the given instance and records latency + sequence integrity for every overlay-state it receives. */
function startViewer(port: number, sessionId: string): () => void {
  const ws = new WebSocket(`ws://localhost:${port}`);
  let lastSeq: number | undefined;
  let intentionalClose = false;
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
  });
  ws.on("message", (raw) => {
    let msg: { type?: string; payload?: { sequence: number; capturedAt: number; cards: unknown[] } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "overlay-state" || !msg.payload) return;
    const { sequence, capturedAt, cards } = msg.payload;
    // An empty-cards clear is the TTL sweep, not a real update — don't let
    // it distort latency or look like a sequence gap.
    if (cards.length === 0) return;
    metrics.delivered += 1;
    metrics.latency.record(Date.now() - capturedAt);
    // First message a viewer sees is whatever's current (its subscribe
    // landed mid-stream / via snapshot) — only judge continuity after that.
    if (lastSeq !== undefined && sequence > lastSeq + 1) metrics.sequenceGaps += sequence - lastSeq - 1;
    lastSeq = sequence;
  });
  ws.on("close", () => {
    // The relay force-closes chronically slow consumers (isSlowConsumer on
    // bufferedAmount) — under this harness that's the signal we're pushing
    // more than a viewer can drain, worth surfacing distinctly from our own
    // teardown closes.
    if (!intentionalClose && running) metrics.unexpectedViewerCloses += 1;
  });
  ws.on("error", () => {});
  return () => {
    intentionalClose = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (OWN_REDIS && spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error("[soak] redis-server not found on PATH. Install it (brew install redis) or set REDIS_URL to an existing instance.");
    process.exit(2);
  }

  console.log("[soak] config:", {
    durationMs: DURATION_MS,
    viewers: VIEWERS,
    publishHz: PUBLISH_HZ,
    sessions: SESSIONS,
    sessionRotateMs: SESSION_ROTATE_MS || "off",
    redis: OWN_REDIS ? `spawned :${REDIS_PORT}` : REDIS_URL,
    ports: [PORT_A, PORT_B],
  });

  if (OWN_REDIS) {
    const redis = spawn("redis-server", ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    children.push(redis);
    await waitForPortOpen(REDIS_PORT, 15_000);
    console.log("[soak] redis up");
  }

  spawnRelay(PORT_A);
  spawnRelay(PORT_B);
  await Promise.all([waitForPortOpen(PORT_A, 30_000), waitForPortOpen(PORT_B, 30_000)]);
  // Relays bind the port before finishing StateBus/subscribe setup; a beat
  // avoids attributing first-message setup jitter to steady-state latency.
  await wait(500);
  console.log("[soak] both relays up");

  const relayPidA = resolveRelayPid(children[OWN_REDIS ? 1 : 0]!.pid!);
  const relayPidB = resolveRelayPid(children[OWN_REDIS ? 2 : 1]!.pid!);
  relayPids.push(relayPidA, relayPidB);

  // Active session state, keyed so rotation can retire and replace entries.
  interface ActiveSession {
    id: string;
    stopProducer: () => void;
    stopViewers: (() => void)[];
  }
  const active = new Map<number, ActiveSession>();
  let sessionCounter = 0;
  let totalSessionsCreated = 0;

  function viewersForSlot(): number {
    return Math.round(VIEWERS / SESSIONS);
  }

  async function openSession(slot: number): Promise<void> {
    const id = `soak-session-${sessionCounter++}`;
    totalSessionsCreated += 1;
    const stopProducer = startProducer(id);
    await wait(30); // let the producer's first publish land + snapshot save before viewers pile on
    const stopViewers: (() => void)[] = [];
    const n = viewersForSlot();
    for (let i = 0; i < n; i++) {
      // Split viewers across both instances so roughly half exercise the
      // cross-instance Redis fan-out path and half the local path.
      const port = i % 2 === 0 ? PORT_A : PORT_B;
      stopViewers.push(startViewer(port, id));
      if (i % 25 === 0) await wait(15); // gentle ramp — avoid a connect thundering-herd skewing early latency
    }
    active.set(slot, { id, stopProducer, stopViewers });
  }

  // Ramp all sessions up.
  const rampStart = Date.now();
  for (let slot = 0; slot < SESSIONS; slot++) await openSession(slot);
  console.log(`[soak] ramped ${SESSIONS} session(s) / ${VIEWERS} viewer(s) in ${Date.now() - rampStart}ms; running ${DURATION_MS}ms...`);

  // Per-second sampling: throughput + per-relay RSS/CPU.
  const rssA: number[] = [];
  const rssB: number[] = [];
  const cpuA: number[] = [];
  const cpuB: number[] = [];
  let lastDelivered = 0;
  const throughput: number[] = [];
  const sampler = setInterval(() => {
    throughput.push(metrics.delivered - lastDelivered);
    lastDelivered = metrics.delivered;
    const a = sampleProcess(relayPidA);
    const b = sampleProcess(relayPidB);
    if (a) {
      rssA.push(a.rssMb);
      cpuA.push(a.cpu);
    }
    if (b) {
      rssB.push(b.rssMb);
      cpuB.push(b.cpu);
    }
  }, 1000);

  // Optional session rotation — retire the oldest slot and open a fresh
  // one on a distinct id, so the number of DISTINCT sessions seen grows
  // over the run even though concurrency stays flat.
  let rotator: NodeJS.Timeout | undefined;
  if (SESSION_ROTATE_MS > 0) {
    let nextSlot = 0;
    rotator = setInterval(() => {
      if (!running) return;
      const slot = nextSlot % SESSIONS;
      nextSlot += 1;
      const old = active.get(slot);
      if (old) {
        old.stopProducer();
        for (const stop of old.stopViewers) stop();
      }
      void openSession(slot);
    }, SESSION_ROTATE_MS);
  }

  await wait(DURATION_MS);

  // Teardown of the load, but keep relays alive for a final RSS read.
  running = false;
  clearInterval(sampler);
  if (rotator) clearInterval(rotator);
  for (const s of active.values()) {
    s.stopProducer();
    for (const stop of s.stopViewers) stop();
  }
  await wait(500);

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------
  const seconds = throughput.length || 1;
  const avgThroughput = metrics.delivered / (DURATION_MS / 1000);
  const rssGrowth = (arr: number[]): { start: number; end: number; max: number; growth: number } => {
    if (arr.length === 0) return { start: 0, end: 0, max: 0, growth: 0 };
    const start = arr[0]!;
    const end = arr[arr.length - 1]!;
    return { start, end, max: Math.max(...arr), growth: end - start };
  };
  const avg = (arr: number[]): number => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const gA = rssGrowth(rssA);
  const gB = rssGrowth(rssB);
  const fmt = (n: number): string => n.toFixed(1);

  console.log("\n" + "=".repeat(64));
  console.log("SOAK REPORT");
  console.log("=".repeat(64));
  console.log(`duration            ${DURATION_MS} ms (${seconds} samples)`);
  console.log(`distinct sessions   ${totalSessionsCreated} (${SESSIONS} concurrent${SESSION_ROTATE_MS ? `, rotating every ${SESSION_ROTATE_MS}ms` : ""})`);
  console.log(`messages delivered  ${metrics.delivered}`);
  console.log(`throughput          ${fmt(avgThroughput)} msg/s avg, ${Math.max(0, ...throughput)} msg/s peak`);
  console.log("latency (ms)        " + `p50 ${metrics.latency.quantile(0.5)}  p90 ${metrics.latency.quantile(0.9)}  p99 ${metrics.latency.quantile(0.99)}  max ${fmt(metrics.latency.max)}  mean ${fmt(metrics.latency.mean)}`);
  console.log(`relay A (:${PORT_A})     RSS ${fmt(gA.start)}→${fmt(gA.end)} MB (peak ${fmt(gA.max)}, growth ${fmt(gA.growth)}), CPU ~${fmt(avg(cpuA))}% (lifetime avg, coarse)`);
  console.log(`relay B (:${PORT_B})     RSS ${fmt(gB.start)}→${fmt(gB.end)} MB (peak ${fmt(gB.max)}, growth ${fmt(gB.growth)}), CPU ~${fmt(avg(cpuB))}% (lifetime avg, coarse)`);
  console.log(`sequence gaps       ${metrics.sequenceGaps}${metrics.sequenceGaps === 0 ? " (no dropped updates)" : " ⚠ dropped/reordered updates"}`);
  console.log(`slow-consumer drops ${metrics.unexpectedViewerCloses}${metrics.unexpectedViewerCloses === 0 ? "" : " ⚠ relay force-closed backlogged viewers"}`);
  console.log("=".repeat(64));

  // Threshold gate (only if the operator asked for one).
  const failures: string[] = [];
  if (MAX_P99_MS !== undefined && metrics.latency.quantile(0.99) > MAX_P99_MS) {
    failures.push(`p99 latency ${metrics.latency.quantile(0.99)}ms > ${MAX_P99_MS}ms`);
  }
  if (MAX_RSS_GROWTH_MB !== undefined) {
    if (gA.growth > MAX_RSS_GROWTH_MB) failures.push(`relay A RSS growth ${fmt(gA.growth)}MB > ${MAX_RSS_GROWTH_MB}MB`);
    if (gB.growth > MAX_RSS_GROWTH_MB) failures.push(`relay B RSS growth ${fmt(gB.growth)}MB > ${MAX_RSS_GROWTH_MB}MB`);
  }

  cleanup();
  if (failures.length > 0) {
    console.error("[soak] THRESHOLD BREACH:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("[soak] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[soak] fatal:", err);
  cleanup();
  process.exit(1);
});
