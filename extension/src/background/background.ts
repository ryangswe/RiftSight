// MV3 background service worker. Owns the relay WebSocket connection —
// content scripts hand it already-sanitized OverlayState and never touch
// the socket themselves (see content/publisher.ts).
//
// Known limitation, accepted for this local prototype: MV3 service workers
// are ephemeral and can be suspended by Chrome after ~30s of inactivity.
// When that happens the open WebSocket dies with it; the next time Chrome
// wakes this worker (e.g. because a content script sent a message), this
// entire module re-evaluates from scratch and calls connect() again at the
// bottom — so "reconnect on wake" falls out of the SW lifecycle model for
// free, rather than needing a keepalive hack.

import { ProducerMessageSchema, RELAY_URL, type OverlayState } from "@riftsight/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

let socket: WebSocket | null = null;
let status: ConnectionStatus = "disconnected";
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

// Only the single most recent unsent state is retained while disconnected
// — deliberately not a queue. A stale intermediate board state is useless
// once a newer one exists; sending both back-to-back on reconnect would
// just make the viewer briefly render outdated data.
let latestUnsent: OverlayState | null = null;

function send(state: OverlayState): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "overlay-state", payload: state }));
  } else {
    latestUnsent = state;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function connect(): void {
  if (socket) return;
  status = "connecting";

  const ws = new WebSocket(RELAY_URL);
  socket = ws;

  ws.addEventListener("open", () => {
    status = "connected";
    backoffMs = INITIAL_BACKOFF_MS; // reset backoff on a successful connection
    if (latestUnsent) {
      send(latestUnsent);
      latestUnsent = null;
    }
  });

  ws.addEventListener("close", () => {
    socket = null;
    status = "disconnected";
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // "close" fires right after "error" for a failed connection attempt;
    // let that handler own reconnect scheduling so it only happens once.
    ws.close();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "overlay-state") {
    const parsed = ProducerMessageSchema.safeParse(message);
    if (parsed.success) send(parsed.data.payload);
    return false;
  }

  if (message?.type === "get-status") {
    sendResponse({ status, hasUnsent: latestUnsent !== null });
    return true;
  }

  return false;
});

connect();
