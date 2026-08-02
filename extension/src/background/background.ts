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
import { disconnect, getLinkState, getStoredCredential, loadPersistedLinkState, startLink } from "./auth.js";
import { resolveProducerWsUrl } from "./producer-url.js";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Must match relay/src/server.ts's CLOSE_CODE.PRODUCER_REPLACED — sent when a newer authenticated producer connection takes over this broadcaster's channel (Stage 7's replace-on-reconnect policy). Unlike a rejected credential (which the browser WebSocket API can't distinguish from a generic connection failure — see auth.ts's reportCredentialRejected doc comment), a close code on an already-open socket IS visible to client JS, so this one case can be surfaced with a specific, accurate message instead of a generic "disconnected." */
const PRODUCER_REPLACED_CLOSE_CODE = 4409;

let socket: WebSocket | null = null;
let status: ConnectionStatus = "disconnected";
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let wasReplacedByAnotherProducer = false;

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

  // Fire-and-forget: connect() is called from setTimeout/module-load sites
  // that don't await it. getStoredCredential() reads chrome.storage.local,
  // which is always async even though it usually resolves within a tick.
  //
  // The .catch() matters: chrome.storage.local can reject with "Extension
  // context invalidated" during an MV3 service-worker suspend/wake
  // transition. Without a fallback here, a rejected lookup would mean
  // openSocket() is never called — and since scheduleReconnect() only
  // ever fires from openSocket()'s own close handler, connect() would
  // leave `status` stuck at "connecting" forever, with no retry loop ever
  // engaged, until something else (e.g. a full extension reload) forced a
  // fresh connect() call. Falling back to no-credential (the legacy
  // RELAY_URL) on failure guarantees a WebSocket attempt — and therefore
  // its own open/close-driven retry loop — always actually starts.
  void getStoredCredential()
    .then((credential) => {
      // A second connect() may have already started (e.g. background
      // worker woken twice in quick succession) — don't open a duplicate socket.
      if (socket) return;
      const url = resolveProducerWsUrl({ backendUrl: __RIFTSIGHT_BACKEND_URL__, credential, fallbackRelayUrl: RELAY_URL });
      openSocket(url);
    })
    .catch((err: unknown) => {
      console.warn("[riftsight] failed to read stored producer credential, connecting without one:", err);
      if (socket) return;
      openSocket(RELAY_URL);
    });
}

function openSocket(url: string): void {
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener("open", () => {
    status = "connected";
    wasReplacedByAnotherProducer = false;
    backoffMs = INITIAL_BACKOFF_MS; // reset backoff on a successful connection
    if (latestUnsent) {
      send(latestUnsent);
      latestUnsent = null;
    }
  });

  ws.addEventListener("close", (event) => {
    socket = null;
    status = "disconnected";
    wasReplacedByAnotherProducer = event.code === PRODUCER_REPLACED_CLOSE_CODE;
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
    sendResponse({ status, hasUnsent: latestUnsent !== null, replaced: wasReplacedByAnotherProducer });
    return true;
  }

  if (message?.type === "get-link-state") {
    sendResponse(getLinkState());
    return true;
  }

  if (message?.type === "start-link") {
    void startLink().then(() => sendResponse(getLinkState()));
    return true; // sendResponse is called asynchronously
  }

  if (message?.type === "disconnect-link") {
    void disconnect().then(() => sendResponse(getLinkState()));
    return true;
  }

  return false;
});

void loadPersistedLinkState();

connect();
