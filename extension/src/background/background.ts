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
//
// That "something wakes the worker" assumption has a real gap, found via
// live testing: the content script's own periodic messages (the heartbeat,
// the get-status poll) are what normally wake a suspended worker — but
// Chrome also throttles a *backgrounded tab's* own JS timers, sometimes
// down to about once a minute. If RiftAtlas's tab isn't focused for a
// while, those messages slow or stop, the worker never gets woken, its own
// pending reconnect timer died with it when it was suspended, and the
// whole thing sits fully disconnected until the tab is refocused — for a
// real stream, that could mean minutes of a broken producer connection any
// time the streamer alt-tabs away while thinking. chrome.alarms (see the
// bottom of this file) exists specifically to survive both the worker
// suspension and the tab-visibility throttling that setTimeout doesn't —
// registering one is what guarantees this worker gets woken periodically
// (and therefore retries connect()) even while fully backgrounded.
//
// Reconnecting the socket is still only half the fix, though: the piece
// that notices a reconnection happened and forces a fresh full snapshot
// (content/publisher.ts's republishCurrentState()) was being triggered by
// the content script polling this worker's own status every 2s — the
// *exact same* backgrounded-tab timer throttling above breaks that
// polling too, so the reconnect could complete here while the content
// script never notices in time to react. openSocket's "open" handler
// below fixes this by pushing a message to the content script the instant
// this worker's socket opens, rather than waiting for it to ask — an
// incoming message to an already-registered listener isn't subject to the
// same throttling a page's own self-scheduled timers are.

import { ProducerMessageSchema, RELAY_URL, type OverlayState } from "@riftsight/protocol";
import {
  checkProducerCredentialStatus,
  disconnect,
  getLinkState,
  getStoredCredential,
  loadPersistedLinkState,
  reportCredentialRejected,
  startLink,
} from "./auth.js";
import { credentialNeedsReconnect, shouldCheckCredentialStatus } from "./connection-diagnostics.js";
import { getCurrentPresenceStatus, recordHeartbeat } from "./presence-tracker.js";
import { getPublishingIntent, loadPersistedPublishingIntent, setPublishingIntent } from "./publishing-intent.js";
import { resolveProducerWsUrl } from "./producer-url.js";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Fallback-only wake-up, not the primary retry mechanism — the fast
 * setTimeout-based backoff above (500ms up to 10s) already handles the
 * common case (tab focused, worker stays responsive) far quicker than an
 * alarm ever could; Chrome enforces roughly a 1-minute floor on periodic
 * alarms regardless of what's requested here. This alarm's only job is to
 * guarantee *something* eventually wakes the worker even when nothing else
 * does (tab backgrounded and throttled) — see the module header for the
 * failure mode this closes. Recreating it on every wake (see the bottom of
 * this file) is intentional and harmless: chrome.alarms.create with the
 * same name simply replaces/reschedules the existing one, so on a tab that
 * stays focused and keeps sending its own messages, this alarm's
 * countdown keeps getting pushed out and may simply never fire — which is
 * fine, since in that case the fast path above is already doing the job.
 */
const RECONNECT_CHECK_ALARM_NAME = "riftsight-reconnect-check";
const RECONNECT_CHECK_ALARM_PERIOD_MINUTES = 1;

/** Must match relay/src/server.ts's CLOSE_CODE.PRODUCER_REPLACED — sent when a newer authenticated producer connection takes over this broadcaster's channel (Stage 7's replace-on-reconnect policy). Unlike a rejected credential (which the browser WebSocket API can't distinguish from a generic connection failure — see auth.ts's reportCredentialRejected doc comment), a close code on an already-open socket IS visible to client JS, so this one case can be surfaced with a specific, accurate message instead of a generic "disconnected." */
const PRODUCER_REPLACED_CLOSE_CODE = 4409;

let socket: WebSocket | null = null;
let status: ConnectionStatus = "disconnected";
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let wasReplacedByAnotherProducer = false;

/**
 * The most recent tab a content-script message was heard from — updated
 * on every "heartbeat" message (see the onMessage listener below), so it
 * stays a valid reference to "the RiftAtlas tab" for as long as that tab
 * exists, even if its own timers are currently throttled and it hasn't
 * sent anything in a while. Used only to push a relay-connected
 * notification to that tab the instant this worker's own socket opens —
 * see openSocket's "open" handler for why polling from the content-script
 * side alone isn't reliable enough for this.
 *
 * Deliberately chrome.storage.local-backed, NOT a plain module variable —
 * a real live incident showed why a plain variable doesn't work here: the
 * whole point of the alarm above is waking a *suspended* worker, and
 * suspension resets every plain module-level variable back to its initial
 * value on the next fresh evaluation, `undefined` included. A worker woken
 * by the alarm would have no idea which tab to notify until a fresh
 * heartbeat arrived — but that heartbeat is exactly as throttled as
 * everything else this fix exists to route around, so the notification
 * would silently never go out on the very reconnect path it's meant to
 * cover. Storage survives the same restart the alarm is designed for.
 */
const STORAGE_KEY_LAST_KNOWN_TAB_ID = "riftsight.lastKnownTabId";

async function rememberTabId(tabId: number): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_KNOWN_TAB_ID]: tabId });
}

async function getLastKnownTabId(): Promise<number | undefined> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY_LAST_KNOWN_TAB_ID)) as Record<string, unknown>;
  const value = stored[STORAGE_KEY_LAST_KNOWN_TAB_ID];
  return typeof value === "number" ? value : undefined;
}

// Ambiguous-failure diagnosis (see connection-diagnostics.ts for the
// actual decision rules): the browser's WebSocket API never exposes the
// HTTP status of a failed upgrade, so a rejected credential and a
// backend-unreachable network blip otherwise look identical. Reset to 0 on
// every successful open — this only tracks a single unbroken run of
// failed *connection attempts*, not failures over the connection's
// lifetime overall. "Replaced" closes (a real, already-known reason) are
// deliberately not counted here — see openSocket's close handler.
let consecutiveFailedAttempts = 0;
let statusCheckedThisStreak = false;

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

/**
 * Called from the close handler once a failure streak crosses the
 * diagnosis threshold. Only ever acts on a *stored* credential — the
 * legacy/no-credential path (development, or before "Connect Twitch" has
 * ever been used) has no credential for the backend to have an opinion
 * about, so this is a no-op there. A network-error or "valid" result never
 * touches the credential (see credentialNeedsReconnect's own doc comment)
 * — only a genuine bad-credential outcome flips the UI to "reconnect
 * Twitch," reusing reportCredentialRejected, which link-state.ts has
 * modeled and unit-tested since account linking was first built.
 */
async function diagnoseFailureStreak(): Promise<void> {
  const credential = await getStoredCredential();
  if (!credential) return;

  const result = await checkProducerCredentialStatus(credential);
  if (credentialNeedsReconnect(result)) {
    await reportCredentialRejected();
  }
}

function openSocket(url: string): void {
  const ws = new WebSocket(url);
  socket = ws;
  let reachedOpen = false;

  ws.addEventListener("open", () => {
    reachedOpen = true;
    status = "connected";
    wasReplacedByAnotherProducer = false;
    consecutiveFailedAttempts = 0;
    statusCheckedThisStreak = false;
    backoffMs = INITIAL_BACKOFF_MS; // reset backoff on a successful connection

    // Push, don't rely on the content script polling for this — see
    // lastKnownTabId's doc comment. A live incident showed the polling
    // fallback in inventory.ts's updatePublishStatus() (which detects this
    // same transition and calls republishCurrentState()) can simply never
    // run again while the tab is backgrounded, since Chrome throttles the
    // content script's own setInterval right alongside everything else —
    // an *incoming* message dispatched to an already-registered listener
    // isn't subject to that same throttling, so this reaches the content
    // script promptly regardless of tab focus. Harmless to send on every
    // connect, including the very first one this worker ever makes (the
    // content script's own republishCurrentState() already no-ops if
    // nothing is currently being published, and redundantly republishing
    // an already-fresh first snapshot costs nothing beyond one extra,
    // deduped-away-if-unchanged message).
    void getLastKnownTabId().then((tabId) => {
      if (tabId === undefined) return;
      return chrome.tabs.sendMessage(tabId, { type: "relay-connected" }).catch(() => {
        // Best-effort — the tab may have navigated away, or no content
        // script is there to receive it yet. Nothing useful to do about a
        // failed push; there's no queue/retry for this, just the next
        // successful connect (or the existing poll-based fallback while
        // the tab stays focused) to catch up eventually.
      });
    });

    if (latestUnsent) {
      send(latestUnsent);
      latestUnsent = null;
    }
  });

  ws.addEventListener("close", (event) => {
    socket = null;
    status = "disconnected";
    wasReplacedByAnotherProducer = event.code === PRODUCER_REPLACED_CLOSE_CODE;

    // A "replaced" close is a real, already-known reason — never
    // ambiguous, so it never counts toward the failure streak. Everything
    // else that never reached "open" is a genuine connection failure.
    if (!reachedOpen && !wasReplacedByAnotherProducer) {
      consecutiveFailedAttempts += 1;
      if (shouldCheckCredentialStatus(consecutiveFailedAttempts, statusCheckedThisStreak)) {
        statusCheckedThisStreak = true;
        void diagnoseFailureStreak();
      }
    }

    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // "close" fires right after "error" for a failed connection attempt;
    // let that handler own reconnect scheduling so it only happens once.
    ws.close();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "overlay-state") {
    const parsed = ProducerMessageSchema.safeParse(message);
    if (parsed.success) send(parsed.data.payload);
    return false;
  }

  if (message?.type === "get-status") {
    sendResponse({ status, hasUnsent: latestUnsent !== null, replaced: wasReplacedByAnotherProducer });
    return true;
  }

  if (message?.type === "heartbeat") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      recordHeartbeat(tabId, Boolean(message.boardDetected), Number(message.publicCardCount) || 0, Date.now());
      void rememberTabId(tabId);
    }
    return false;
  }

  if (message?.type === "get-presence-state") {
    sendResponse({ status: getCurrentPresenceStatus(Date.now()) });
    return true;
  }

  if (message?.type === "get-publishing-intent") {
    sendResponse({ intent: getPublishingIntent() });
    return true;
  }

  if (message?.type === "set-publishing-intent") {
    void setPublishingIntent(Boolean(message.intent)).then(() => sendResponse({ intent: getPublishingIntent() }));
    return true; // sendResponse is called asynchronously
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
void loadPersistedPublishingIntent();

// Registered on every module load (fresh install, and every wake from
// suspension) — chrome.alarms.create with an existing name simply
// replaces/reschedules it, so this is safe to call unconditionally rather
// than needing to check "is one already registered." The listener itself
// does nothing beyond existing: being woken up at all is the point (see
// RECONNECT_CHECK_ALARM_NAME's doc comment) — connect() below already
// runs fresh on every wake regardless of what woke it, and its own
// `if (socket) return;` guard makes it a safe no-op if the connection is
// already healthy.
chrome.alarms.create(RECONNECT_CHECK_ALARM_NAME, { periodInMinutes: RECONNECT_CHECK_ALARM_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_CHECK_ALARM_NAME) return;
  connect();
});

connect();
