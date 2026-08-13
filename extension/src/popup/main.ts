// The toolbar popup — the sole streamer-facing UI in closed-beta builds
// (see content/inventory.ts's bottom-of-file gating: the debug panel it
// injects into RiftAtlas never renders in that mode). A separate JS
// execution context from both the content script and the background
// worker, so it talks to background.ts through the exact same
// chrome.runtime.sendMessage contract inventory.ts already uses — no new
// message types.
//
// Two things this file deliberately never does:
//  - Send "heartbeat": background.ts's heartbeat handler reads
//    sender.tab?.id to track RiftAtlas presence, and a popup has no
//    associated tab (it degrades gracefully — the message is just
//    dropped — but sending it here would be pointless). Presence stays
//    sourced exclusively from the content script, which keeps running
//    headlessly whether or not this popup is ever opened.
//  - Call startPublishing/stopPublishing directly: this popup has no DOM
//    access to RiftAtlas and can't import publisher.ts/card-observer.ts
//    (wrong execution context). It only ever writes intent via
//    set-publishing-intent; content/inventory.ts's sendHeartbeat() tick
//    is what actually starts/stops the publisher, re-polling
//    get-publishing-intent every cycle specifically so it picks up a
//    change made from here (see that function's doc comment).

import { LINK_STATUS_LABEL, type LinkState, type LinkStatus } from "../background/link-state.js";
import { idlePublishingMessage, PRESENCE_STATUS_LABEL, type PresenceStatus } from "../background/presence.js";
import { describeStreamerError } from "../background/error-messages.js";
import { safeSendMessage } from "../shared/messaging.js";

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const accountStatusEl = requireElement<HTMLDivElement>("account-status");
const connectButton = requireElement<HTMLButtonElement>("connect-button");
const disconnectButton = requireElement<HTMLButtonElement>("disconnect-button");
const presenceStatusEl = requireElement<HTMLDivElement>("presence-status");
const publishStatusEl = requireElement<HTMLDivElement>("publish-status");
const publishToggleButton = requireElement<HTMLButtonElement>("publish-toggle");

let cachedPublishingIntent = false;
let lastKnownLinkStatus: LinkStatus = "not-connected";
let lastKnownPresenceStatus: PresenceStatus = "no-riftatlas";

function updateAccountSection(): void {
  safeSendMessage<LinkState>({ type: "get-link-state" })
    .then((state) => {
      const status: LinkStatus = state?.status ?? "not-connected";
      lastKnownLinkStatus = status;
      const label = LINK_STATUS_LABEL[status];
      accountStatusEl.textContent = status === "connected" && state?.displayName ? `${label} as ${state.displayName}` : label;
      accountStatusEl.className = status === "not-in-beta" ? "status-line status-warning" : "status-line";

      const showConnect =
        status === "not-connected" || status === "credential-expired" || status === "backend-unavailable" || status === "not-in-beta";
      connectButton.style.display = showConnect ? "inline-block" : "none";
      disconnectButton.style.display = status === "connected" ? "inline-block" : "none";
    })
    .catch(() => {
      lastKnownLinkStatus = "backend-unavailable";
      accountStatusEl.textContent = LINK_STATUS_LABEL["backend-unavailable"];
      accountStatusEl.className = "status-line";
      connectButton.style.display = "inline-block";
      disconnectButton.style.display = "none";
    });
}

function updatePresenceSection(): void {
  safeSendMessage<{ status?: PresenceStatus }>({ type: "get-presence-state" })
    .then((response) => {
      lastKnownPresenceStatus = response?.status ?? "no-riftatlas";
      presenceStatusEl.textContent = PRESENCE_STATUS_LABEL[lastKnownPresenceStatus];
    })
    .catch(() => {
      lastKnownPresenceStatus = "no-riftatlas";
      presenceStatusEl.textContent = PRESENCE_STATUS_LABEL["no-riftatlas"];
    });
}

function syncPublishToggleUI(): void {
  publishToggleButton.textContent = cachedPublishingIntent ? "Stop publishing" : "Start publishing";
}

/**
 * The relay-reported viewer count, appended to the "Publishing." status
 * line — the strongest signal this popup can show that things are working
 * end to end, since it means someone else's browser is actually receiving
 * data, not just that this extension believes it's sending. Undefined
 * (never omit vs. "0 viewers" as if they're the same thing) means no
 * producer connection has told us yet — nothing appended in that case,
 * rather than a misleading "0 viewers" flash before the first real count
 * arrives.
 */
function describeViewerCount(count: number | undefined): string {
  if (count === undefined) return "";
  return ` — ${count} viewer${count === 1 ? "" : "s"}`;
}

// Approximates content/inventory.ts's isPublishing()/publishedSnapshotCount()
// via presence instead of a dedicated message — those two live purely in
// publisher.ts's content-script-local state and were never exposed over
// chrome.runtime messaging, and adding a new message type just to mirror
// them here isn't worth it for a status line. "presence active" is a close
// enough proxy for "actually publishing" for this summary view; the richer
// per-snapshot count stays a debug-panel-only (dev mode) detail.
function updatePublishStatus(): void {
  if (!cachedPublishingIntent) {
    publishStatusEl.textContent = "Not publishing.";
    return;
  }
  if (lastKnownPresenceStatus !== "active") {
    publishStatusEl.textContent = idlePublishingMessage(lastKnownPresenceStatus);
    return;
  }

  safeSendMessage<{ status?: string; replaced?: boolean; viewerCount?: number }>({ type: "get-status" })
    .then((response) => {
      publishStatusEl.textContent = response?.replaced
        ? describeStreamerError("producer-replaced")
        : response?.status === "connected"
          ? `Publishing. Relay: connected${describeViewerCount(response.viewerCount)}`
          : response?.status === "disconnected"
            ? describeStreamerError("relay-reconnecting")
            : idlePublishingMessage(lastKnownPresenceStatus);
    })
    .catch(() => {
      publishStatusEl.textContent = describeStreamerError("backend-unreachable");
    });
}

connectButton.addEventListener("click", () => {
  void safeSendMessage({ type: "start-link" }).then(updateAccountSection);
});
disconnectButton.addEventListener("click", () => {
  void safeSendMessage({ type: "disconnect-link" }).then(updateAccountSection);
});

publishToggleButton.addEventListener("click", () => {
  if (!cachedPublishingIntent && lastKnownLinkStatus !== "connected") {
    publishStatusEl.textContent = "Link your Twitch account first.";
    return;
  }
  cachedPublishingIntent = !cachedPublishingIntent;
  syncPublishToggleUI();
  updatePublishStatus();
  void safeSendMessage({ type: "set-publishing-intent", intent: cachedPublishingIntent }).catch(() => {
    // Best-effort, matching content/inventory.ts's setIntent() — a
    // genuinely dropped persist only matters across a reload, and the
    // content script's own heartbeat-tick re-fetch of this same value will
    // reconcile it soon regardless.
  });
});

async function init(): Promise<void> {
  updateAccountSection();
  updatePresenceSection();
  const intentResponse = (await safeSendMessage({ type: "get-publishing-intent" }).catch(() => undefined)) as
    | { intent?: boolean }
    | undefined;
  cachedPublishingIntent = Boolean(intentResponse?.intent);
  syncPublishToggleUI();
  updatePublishStatus();
}

void init();

// Chrome tears down and re-creates this entire document every time the
// popup is opened, so there's no stale-state problem to solve across opens
// — this interval only needs to keep things fresh while a single popup
// instance stays open.
setInterval(() => {
  updateAccountSection();
  updatePresenceSection();
  updatePublishStatus();
}, 2000);
