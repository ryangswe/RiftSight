// Production pre-flight: open N synthetic Twitch-style viewer connections
// against a REAL relay deployment (by default, production) and hold them,
// to prove the full network path — Railway's edge proxy, the WebSocket
// upgrade, JWT verification, admission, and fan-out — carries a large
// audience before a big stream does it for real. The local soak harness
// (redis-fanout branch, `npm run soak`) only ever exercises loopback; this
// is the only tool that exercises the deployment itself.
//
// It mints Twitch Extension JWTs with YOUR extension's shared secret,
// exactly the way relay/src/twitch-auth.ts verifies them (HS256, claims
// channel_id/role/opaque_user_id/exp), so the relay admits these sockets
// through the same path a real Twitch viewer takes. The secret is read
// from the environment only — never pass it on the command line, never
// commit it, never paste it into a chat.
//
// Strongest signal: run it WHILE the target channel's streamer (you, on
// your own channel) is publishing from the RiftSight extension. Every
// admitted socket then receives overlay-state on subscribe and on every
// board change, so "admitted" and "messages/sec" are proven end to end,
// not inferred. With no producer live the relay admits silently (no ack
// message exists on the wire), so the run can only prove connections
// stay open, not that they were admitted.
//
// Usage (all env vars; defaults in brackets):
//   TWITCH_EXTENSION_SECRET=<base64 shared secret>   required
//   PREFLIGHT_CHANNEL_ID=<numeric twitch channel id>  required — a channel
//                                                     whose broadcaster is
//                                                     allowlisted on the
//                                                     target relay
//   PREFLIGHT_RELAY_URL   [wss://riftsightrelay-production.up.railway.app]
//   PREFLIGHT_VIEWERS     [300]   concurrent viewer sockets
//   PREFLIGHT_RAMP_PER_S  [100]   new connections per second during ramp
//   PREFLIGHT_HOLD_MS     [60000] how long to hold every socket open
//
//   npm run preflight-viewers -w relay
//
// NOTE — per-IP connection limiting: relays built from the youtube-live
// line onward cap WebSocket upgrades per source IP (rate-limit.ts's
// WS_CONNECTION_LIMIT, 60/min by default), which a single-machine
// preflight would trip at viewer 61. Against such a relay either run from
// several machines, or temporarily raise the limit on a staging service —
// never on production. The pre-youtube-live production relay has no
// per-IP limit, so a one-machine run of 1000+ is fine there.
//
// Start small (300) and step up (1000, 2000). A clean run reports every
// socket open for the whole hold, zero unexpected closes, and — with a
// live producer — admitted == open and a steady messages/sec. Abort with
// Ctrl-C at any time; sockets close immediately. It only ever opens
// viewer connections (read-only subscribers); it never publishes.

import jwt from "jsonwebtoken";
import { WebSocket } from "ws";

const SECRET = process.env["TWITCH_EXTENSION_SECRET"];
const CHANNEL_ID = process.env["PREFLIGHT_CHANNEL_ID"];
const RELAY_URL = process.env["PREFLIGHT_RELAY_URL"] ?? "wss://riftsightrelay-production.up.railway.app";
const VIEWERS = intEnv("PREFLIGHT_VIEWERS", 300);
const RAMP_PER_S = Math.max(1, intEnv("PREFLIGHT_RAMP_PER_S", 100));
const HOLD_MS = intEnv("PREFLIGHT_HOLD_MS", 60_000);

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`[preflight] ${name}="${raw}" is not a non-negative number`);
    process.exit(2);
  }
  return parsed;
}

if (!SECRET || !CHANNEL_ID) {
  console.error("[preflight] TWITCH_EXTENSION_SECRET and PREFLIGHT_CHANNEL_ID are required (environment only).");
  process.exit(2);
}
if (!/^\d+$/.test(CHANNEL_ID)) {
  console.error("[preflight] PREFLIGHT_CHANNEL_ID must be the numeric Twitch channel id, not a login name.");
  process.exit(2);
}

const secretBytes = Buffer.from(SECRET, "base64");
function mintViewerToken(index: number): string {
  // Same claim shape the relay verifies (relay/src/twitch-auth.ts); one
  // distinct opaque_user_id per synthetic viewer so nothing about this
  // run collapses into "one user".
  return jwt.sign(
    {
      channel_id: CHANNEL_ID,
      role: "viewer",
      opaque_user_id: `UPREFLIGHT${index}`,
      pubsub_perms: { listen: ["broadcast"] },
    },
    secretBytes,
    { algorithm: "HS256", expiresIn: Math.ceil(HOLD_MS / 1000) + 600 }
  );
}

interface ViewerStats {
  opened: number;
  handshakeFailed: number;
  admitted: number; // received at least one overlay-state
  messages: number;
  bytes: number;
  closedUnexpectedly: number;
  closeCodes: Map<number, number>;
  errors: Map<string, number>;
  connectLatencies: number[];
}

const stats: ViewerStats = {
  opened: 0,
  handshakeFailed: 0,
  admitted: 0,
  messages: 0,
  bytes: 0,
  closedUnexpectedly: 0,
  closeCodes: new Map(),
  errors: new Map(),
  connectLatencies: [],
};
const sockets: WebSocket[] = [];
let shuttingDown = false;

function bump(map: Map<string | number, number>, key: string | number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function openViewer(index: number): void {
  const startedAt = Date.now();
  const ws = new WebSocket(RELAY_URL);
  let admitted = false;
  let opened = false;
  sockets.push(ws);

  ws.on("open", () => {
    opened = true;
    stats.opened += 1;
    stats.connectLatencies.push(Date.now() - startedAt);
    ws.send(JSON.stringify({ type: "twitch-subscribe", channelId: CHANNEL_ID, token: mintViewerToken(index) }));
  });
  ws.on("message", (raw) => {
    const text = raw.toString();
    stats.messages += 1;
    stats.bytes += text.length;
    if (!admitted && text.includes('"overlay-state"')) {
      admitted = true;
      stats.admitted += 1;
    }
  });
  ws.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    bump(stats.errors, code);
  });
  ws.on("close", (code) => {
    if (shuttingDown) return;
    if (!opened) stats.handshakeFailed += 1;
    else {
      stats.closedUnexpectedly += 1;
      bump(stats.closeCodes, code);
    }
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function snapshotLine(elapsedMs: number, lastMessages: number, lastBytes: number, windowMs: number): string {
  const open = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
  const msgPerS = ((stats.messages - lastMessages) * 1000) / windowMs;
  const kbPerS = ((stats.bytes - lastBytes) * 1000) / windowMs / 1024;
  return (
    `[preflight] t+${Math.round(elapsedMs / 1000)}s open=${open}/${VIEWERS} admitted=${stats.admitted} ` +
    `handshake-failed=${stats.handshakeFailed} closed=${stats.closedUnexpectedly} ` +
    `rx=${msgPerS.toFixed(1)} msg/s ${kbPerS.toFixed(0)} KiB/s`
  );
}

async function main(): Promise<void> {
  console.log(`[preflight] target ${RELAY_URL}  channel ${CHANNEL_ID}  viewers ${VIEWERS}  ramp ${RAMP_PER_S}/s  hold ${HOLD_MS}ms`);
  const startedAt = Date.now();
  const intervalMs = 1000 / RAMP_PER_S;
  for (let i = 0; i < VIEWERS; i += 1) {
    openViewer(i);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log(`[preflight] ramp complete in ${Date.now() - startedAt}ms; holding ${HOLD_MS}ms...`);

  let lastMessages = stats.messages;
  let lastBytes = stats.bytes;
  const windowMs = 5000;
  const ticker = setInterval(() => {
    console.log(snapshotLine(Date.now() - startedAt, lastMessages, lastBytes, windowMs));
    lastMessages = stats.messages;
    lastBytes = stats.bytes;
  }, windowMs);
  await new Promise((r) => setTimeout(r, HOLD_MS));
  clearInterval(ticker);

  const open = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
  shuttingDown = true;
  for (const s of sockets) s.close();

  console.log("");
  console.log("================================================================");
  console.log("PREFLIGHT REPORT");
  console.log("================================================================");
  console.log(`target                ${RELAY_URL}`);
  console.log(`requested / opened    ${VIEWERS} / ${stats.opened}`);
  console.log(`still open at end     ${open}`);
  console.log(`admitted (got state)  ${stats.admitted}  ${stats.admitted === 0 ? "(no overlay-state seen — was a producer publishing to this channel?)" : ""}`);
  console.log(`handshake failures    ${stats.handshakeFailed}`);
  console.log(`unexpected closes     ${stats.closedUnexpectedly}  ${fmtMap(stats.closeCodes)}`);
  console.log(`socket errors         ${fmtMap(stats.errors) || "none"}`);
  console.log(`connect latency (ms)  p50 ${percentile(stats.connectLatencies, 50)}  p90 ${percentile(stats.connectLatencies, 90)}  p99 ${percentile(stats.connectLatencies, 99)}`);
  console.log(`messages received     ${stats.messages}  (${(stats.bytes / 1024 / 1024).toFixed(1)} MiB total)`);
  console.log("================================================================");
  const healthy = stats.handshakeFailed === 0 && stats.closedUnexpectedly === 0 && open === stats.opened && stats.opened === VIEWERS;
  console.log(healthy ? "[preflight] PASS — every socket connected and stayed open for the whole hold." : "[preflight] ATTENTION — see the counters above.");
  process.exit(healthy ? 0 : 1);
}

function fmtMap(map: Map<string | number, number>): string {
  if (map.size === 0) return "";
  return "{" + [...map.entries()].map(([k, v]) => `${k}: ${v}`).join(", ") + "}";
}

process.on("SIGINT", () => {
  shuttingDown = true;
  for (const s of sockets) s.close();
  console.log("\n[preflight] aborted — sockets closed.");
  process.exit(130);
});

main().catch((err) => {
  console.error("[preflight] failed:", err);
  process.exit(1);
});
