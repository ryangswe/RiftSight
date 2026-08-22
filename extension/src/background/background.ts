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

import { ProducerMessageSchema, RELAY_URL, parseViewerCountMessage, type OverlayState } from "@riftsight/protocol";
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
import { forgetTab, getActivePublisherTabId, getCurrentPresenceStatus, isCurrentlyGoneForAutoStop, recordHeartbeat } from "./presence-tracker.js";
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

// Toolbar-icon status indicator — a small always-visible status color, so
// a streamer can tell at a glance whether RiftSight needs attention
// without opening the popup. Deliberately derived from state this file
// already tracks (relay connection `status`, link state, publishing
// intent, and presence — all read through their own modules) rather than
// adding a new state machine — this is a pure projection of existing
// truth, not a new source of it.
//
// "publishing" (green) requires RiftAtlas presence to be "active", not
// just publishing *intent* — a real incident showed why: intent alone
// only means the streamer clicked the button at some point, and stays
// true even if the extension's content script was never actually running
// (e.g. RiftAtlas was already open in a tab before a fresh
// install/reload, so the content script never got injected into it —
// content scripts don't retroactively attach to already-open tabs). That
// left the badge reporting green — Twitch linked, relay connected,
// intent on — while nothing was actually being detected or published at
// all, and the streamer had no way to tell short of opening the popup.
// Gating on presence closes that specific gap: if intent is on but
// presence isn't "active", the badge now falls to the same "connected-idle"
// yellow as "haven't started yet" instead of falsely claiming success. This
// still isn't a full guarantee: it says nothing about whether detection is
// *correct* (a partial/silent detection bug — real example: RiftAtlas
// changing the chain-zone card id format — leaves presence "active" and
// the badge green while some cards are quietly missing), and nothing
// about whether any viewer is actually receiving/rendering anything
// downstream, since there's no feedback channel from viewer back to
// producer today. Both are real, known gaps, not yet addressed here.
//
// Drawn as a small circle composited onto the base icon via
// OffscreenCanvas + chrome.action.setIcon, NOT chrome.action's own
// setBadgeText/setBadgeBackgroundColor — that API only ever renders as a
// fixed-size rounded-rectangle strip Chrome controls entirely, with no way
// to make it smaller or circular. Compositing our own icon is the only way
// to get a small, precise dot instead of a strip covering a large part of
// the icon.
type BadgeStatus = "not-connected" | "connected-idle" | "publishing" | "error";

const BADGE_COLOR: Record<BadgeStatus, string> = {
  "not-connected": "#9ca3af", // gray — no Twitch account linked yet
  "connected-idle": "#facc15", // yellow — linked, but not publishing right now
  publishing: "#22c55e", // green — actively publishing
  error: "#ef4444", // red — linked, but the relay connection itself is down/retrying
};

const ICON_SIZES = [16, 48, 128] as const;

// Loaded once per service-worker lifetime (module-level, so it survives
// across updateBadge() calls but not a worker suspend/resume — reloaded
// lazily on the next call in that case, same as everything else in this
// file that can't persist across suspension).
const baseIconBitmaps = new Map<number, ImageBitmap>();
let iconsReadyPromise: Promise<void> | undefined;

async function loadBaseIcons(): Promise<void> {
  await Promise.all(
    ICON_SIZES.map(async (size) => {
      const response = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
      const blob = await response.blob();
      baseIconBitmaps.set(size, await createImageBitmap(blob));
    })
  );
}

/** Base icon + a small colored circle in the bottom-right corner, sized as a fraction of the icon so it stays proportionally small (roughly a fifth of the icon's width) rather than obscuring it — with a thin white ring so the dot reads clearly against whatever the icon's own artwork looks like at that spot. */
function composeIconWithDot(size: number, color: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  const bitmap = baseIconBitmaps.get(size);
  if (bitmap) ctx.drawImage(bitmap, 0, 0, size, size);

  const radius = size * 0.2;
  const margin = size * 0.04;
  const cx = size - radius - margin;
  const cy = size - radius - margin;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Cheap and safe to call from anywhere, anytime — reads already-tracked
 * state, never awaits anything expensive itself beyond the one-time base
 * icon load (getLinkState/getPublishingIntent are both synchronous
 * in-memory reads). "error" intentionally covers both "disconnected" and
 * "connecting" — a streamer doesn't need to distinguish "down" from
 * "currently retrying," both mean the same thing to them: not actually
 * connected right now.
 */
function updateBadge(): void {
  const linkStatus = getLinkState().status;
  let badgeStatus: BadgeStatus;
  if (linkStatus !== "connected") {
    badgeStatus = "not-connected";
  } else if (status !== "connected") {
    badgeStatus = "error";
  } else if (getPublishingIntent() && getCurrentPresenceStatus(Date.now()) === "active") {
    badgeStatus = "publishing";
  } else {
    badgeStatus = "connected-idle";
  }

  const color = BADGE_COLOR[badgeStatus];
  if (!iconsReadyPromise) iconsReadyPromise = loadBaseIcons();
  void iconsReadyPromise
    .then(() => {
      const imageData: Record<string, ImageData> = {};
      for (const size of ICON_SIZES) {
        imageData[String(size)] = composeIconWithDot(size, color);
      }
      return chrome.action.setIcon({ imageData });
    })
    .catch((err: unknown) => {
      console.warn("[riftsight] failed to update toolbar status indicator:", err);
    });
}

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

// The relay's own count of viewers currently subscribed to this session —
// pushed by the relay, not polled; see ViewerCountMessageSchema. undefined
// means "unknown" (no producer connection has ever told us), deliberately
// distinct from 0 ("we were told, and it's genuinely nobody") — the popup
// only shows a number once this has a real value, rather than flashing a
// misleading "0 viewers" before the first message ever arrives. Reset to
// undefined on every disconnect for the same reason: a stale last-known
// count from a prior connection is no longer something we can vouch for.
let latestViewerCount: number | undefined;

function send(state: OverlayState): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "overlay-state", payload: state }));
  } else {
    latestUnsent = state;
  }
}

/**
 * The most recent real OverlayState this worker has forwarded from the
 * content script — used only to synthesize an explicit clear (see
 * maybeAutoStopOnGoneReceived below) when the content script itself is
 * gone and can no longer send one via its own OverlayStatePublisher.
 * `autoStoppedForCurrentGap` guards against re-sending that synthetic
 * clear on every 2s tick once already sent, and resets the moment a real
 * update arrives again — so a later reconnect/resume allows a future
 * auto-stop to fire again if the streamer leaves a second time.
 */
let lastKnownState: OverlayState | undefined;
let autoStoppedForCurrentGap = false;

/**
 * The last OverlayState received from each RiftAtlas tab, kept whether or not
 * that tab is the currently-elected publisher. Two purposes:
 *  - a non-elected tab's state is cached here but NOT forwarded to the relay,
 *    which is the actual fix for the multi-tab bug (a background tab's board
 *    used to leak onto the stream because every tab's state was forwarded
 *    blindly over the single shared producer socket);
 *  - when election flips to a different tab (the streamer switches games),
 *    its cached board can be sent immediately so viewers snap to the right
 *    game without waiting for that tab's next board mutation.
 * Entries are dropped on tab close (see the onRemoved handler). Memory-only —
 * lost on service-worker suspension, same as election state, which is fine:
 * after a wake the content scripts' own republish-on-reconnect repopulates it.
 */
const latestStateByTab = new Map<number, OverlayState>();

/**
 * The tab getActivePublisherTabId last resolved to, so a heartbeat (or a tab
 * closing) that changes the election can be detected and reacted to exactly
 * once — see evaluateElection.
 */
let lastElectedTabId: number | undefined;

/**
 * Re-checks which tab should be publishing and, if it changed, immediately
 * forwards that tab's most recent cached board so the stream snaps to it.
 * Called after every heartbeat (election inputs just changed) and after a tab
 * closes (a live tab may need to take over). Sending nothing is correct when
 * the newly-elected tab has no cached state yet — its own next publish will
 * flow through now that it's the elected tab.
 */
function evaluateElection(now: number): void {
  const active = getActivePublisherTabId(now);
  if (active === lastElectedTabId) return;
  lastElectedTabId = active;
  if (active === undefined) return;
  const cached = latestStateByTab.get(active);
  if (!cached) return;
  lastKnownState = cached;
  autoStoppedForCurrentGap = false;
  send(cached);
}

/**
 * Proactively clears whatever a viewer is currently seeing once presence
 * has concluded RiftAtlas is genuinely gone (see presence.ts's
 * isPresenceGoneForAutoStop/AUTO_STOP_TIMEOUT_MS, and the onRemoved
 * listener below for the immediate tab-closed case) — without this,
 * the relay's own stale-state TTL sweep never fires on its own here,
 * since it explicitly skips clearing while this worker's producer
 * WebSocket is still open (relay/src/server.ts), which it stays
 * regardless of whether any RiftAtlas tab still exists.
 *
 * The content script's own explicit-clear mechanism (publisher.ts's
 * stopPublishing) can't be reused directly here — it needs the live
 * OverlayStatePublisher instance's own sequence/dedup state, which only
 * ever lives in the (now-gone) content script's module scope. Instead
 * this mirrors the exact same synthesis relay/src/server.ts's own
 * TTL-sweep clear already performs: reuse the last known state's
 * protocolVersion/sessionId/sourceViewport, empty the cards, and bump
 * sequence by one — not a new class of message the rest of the system
 * has to learn to handle. A later fresh session (new content script,
 * new OverlayStatePublisher starting its own sequence over from 1) is
 * already a normal, already-tolerated event for this system — the same
 * as after any TTL-sweep-driven clear today.
 */
function maybeAutoStopOnGoneReceived(): void {
  if (autoStoppedForCurrentGap) return;
  if (!lastKnownState || lastKnownState.cards.length === 0) return;
  autoStoppedForCurrentGap = true;
  const cleared: OverlayState = { ...lastKnownState, cards: [], sequence: lastKnownState.sequence + 1, capturedAt: Date.now() };
  lastKnownState = cleared;
  send(cleared);
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
  updateBadge();

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
    updateBadge();

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
    void getLastKnownTabId().then((lastKnownTabId) => {
      // Notify the *elected* tab so it republishes its board on reconnect —
      // that's the tab whose state viewers should see. Also notify the
      // storage-backed lastKnownTabId: it's the only target that survives a
      // service-worker suspend/wake (in-memory election is empty until fresh
      // heartbeats land), so it keeps the reconnect-republish path working on
      // exactly the backgrounded-tab wake this push exists to cover. A
      // non-elected tab that republishes is harmless — its state is gated out
      // downstream. Deduped so a single tab isn't messaged twice.
      const targets = new Set<number>();
      const elected = getActivePublisherTabId(Date.now());
      if (elected !== undefined) targets.add(elected);
      if (lastKnownTabId !== undefined) targets.add(lastKnownTabId);
      for (const tabId of targets) {
        void chrome.tabs.sendMessage(tabId, { type: "relay-connected" }).catch(() => {
          // Best-effort — the tab may have navigated away, or no content
          // script is there to receive it yet. Nothing useful to do about a
          // failed push; there's no queue/retry for this, just the next
          // successful connect (or the existing poll-based fallback while
          // the tab stays focused) to catch up eventually.
        });
      }
    });

    if (latestUnsent) {
      send(latestUnsent);
      latestUnsent = null;
    }
  });

  ws.addEventListener("message", (event) => {
    const count = parseViewerCountMessage(String(event.data));
    if (count !== undefined) latestViewerCount = count;
  });

  ws.addEventListener("close", (event) => {
    socket = null;
    status = "disconnected";
    wasReplacedByAnotherProducer = event.code === PRODUCER_REPLACED_CLOSE_CODE;
    latestViewerCount = undefined; // no longer connected — a stale last-known count isn't something we can vouch for
    updateBadge();

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
    if (parsed.success) {
      const tabId = sender.tab?.id;
      // Always cache the source tab's latest board so an election flip can
      // snap the stream to it (see evaluateElection). Only the elected tab's
      // state is actually forwarded to the relay — this is the multi-tab fix:
      // a background tab keeps publishing to the worker but no longer reaches
      // viewers. When the election is unknown (no heartbeat yet) or the
      // sender tab is somehow unidentified, stay permissive and forward, so
      // this is never worse than the old always-forward behavior.
      if (tabId !== undefined) latestStateByTab.set(tabId, parsed.data.payload);
      const active = getActivePublisherTabId(Date.now());
      if (active === undefined || tabId === undefined || tabId === active) {
        lastKnownState = parsed.data.payload;
        autoStoppedForCurrentGap = false;
        send(parsed.data.payload);
      }
    }
    return false;
  }

  if (message?.type === "get-status") {
    sendResponse({ status, hasUnsent: latestUnsent !== null, replaced: wasReplacedByAnotherProducer, viewerCount: latestViewerCount });
    return true;
  }

  if (message?.type === "heartbeat") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const now = Date.now();
      recordHeartbeat(
        tabId,
        Boolean(message.boardDetected),
        Number(message.publicCardCount) || 0,
        Boolean(message.visible),
        Boolean(message.focused),
        now
      );
      void rememberTabId(tabId);
      // Visibility/focus just changed the election inputs; if the streamer
      // switched tabs, snap the stream to the newly-active tab now rather
      // than waiting for its next board mutation.
      evaluateElection(now);
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
    void setPublishingIntent(Boolean(message.intent)).then(() => {
      updateBadge();
      sendResponse({ intent: getPublishingIntent() });
    });
    return true; // sendResponse is called asynchronously
  }

  if (message?.type === "get-link-state") {
    sendResponse(getLinkState());
    return true;
  }

  if (message?.type === "start-link") {
    void startLink().then(() => {
      updateBadge();
      sendResponse(getLinkState());
    });
    return true; // sendResponse is called asynchronously
  }

  if (message?.type === "disconnect-link") {
    void disconnect().then(() => {
      updateBadge();
      sendResponse(getLinkState());
    });
    return true;
  }

  return false;
});

void Promise.all([loadPersistedLinkState(), loadPersistedPublishingIntent()]).then(updateBadge);

// Explicit calls above cover every transition this file directly drives
// (relay open/close, connect() starting, and the immediate result of a
// start-link/disconnect-link/set-publishing-intent message) — but
// auth.ts's own multi-minute OAuth poll loop (waiting-for-authorization ->
// connected/not-in-beta/etc.) advances entirely on its own timers deep
// inside that module, with no explicit hook back into this file. This
// periodic refresh is the resilient catch-all for those transitions,
// matching the same 2s cadence content/inventory.ts already polls
// get-link-state/get-status at for its own UI.
setInterval(() => {
  updateBadge();
  if (isCurrentlyGoneForAutoStop(Date.now())) maybeAutoStopOnGoneReceived();
}, 2000);

// Immediate, unambiguous signal that RiftAtlas is genuinely gone — doesn't
// wait out AUTO_STOP_TIMEOUT_MS at all, unlike the sustained-stale check
// above (which exists for the messier case: the tab stays open but
// navigates away from play.riftatlas.com without ever closing). Reuses
// getLastKnownTabId() (already storage-backed, survives worker
// suspension — see its own doc comment) rather than a plain module
// variable, and specifically checks that the *closed* tab is the one
// most recently heard from, so closing an old, already-inactive RiftAtlas
// tab doesn't spuriously clear a still-healthy publish from a different one.
chrome.tabs.onRemoved.addListener((tabId) => {
  // Own the single onRemoved handler for presence cleanup (presence-tracker
  // no longer registers its own), so election is re-evaluated only after the
  // closed tab has actually been forgotten — no ordering race between two
  // listeners.
  forgetTab(tabId);
  latestStateByTab.delete(tabId);

  const now = Date.now();
  const active = getActivePublisherTabId(now);
  if (active === undefined) {
    // No live RiftAtlas tab remains — genuinely gone. Only synthesize the
    // clear if the tab that just closed was the one actually feeding the
    // stream, so closing a stale/leftover tab that wasn't publishing doesn't
    // spuriously clear a still-healthy stream (matches the prior
    // lastKnownTabId guard's intent).
    void getLastKnownTabId().then((lastKnownTabId) => {
      if (tabId === lastKnownTabId) maybeAutoStopOnGoneReceived();
    });
  } else {
    // A different tab is still live and now takes over — snap the stream to
    // it rather than clearing (the closed tab may have been the one on screen).
    evaluateElection(now);
  }
});

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
