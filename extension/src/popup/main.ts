// The popup — the cross-platform RiftSight client's front door, organized
// around the two experiences (Watch | Stream) rather than the
// implementation model. All UI-state decisions live in the pure, tested
// view-model.ts; this file is render glue + event wiring on the same
// background-message contract as before, refreshed on the popup's
// established 2s cadence.
//
// Views: first-run onboarding (sets the DEFAULT tab only — never a
// permanent role), the main tabbed view, and a settings view holding the
// low-frequency account/linking administration that used to crowd the top
// of the old popup. Tab selection persists locally.

import { LINK_STATUS_LABEL, type LinkState } from "../background/link-state.js";
import { type PresenceStatus } from "../background/presence.js";
import { safeSendMessage } from "../shared/messaging.js";
import { enableYouTube, isYouTubeEnabled, YOUTUBE_ORIGIN } from "../background/youtube-enable.js";
import {
  clearYouTubeChannelClaim,
  fetchClaimedYouTubeChannel,
  saveYouTubeChannelClaim,
  type YouTubeChannelFailure,
} from "../background/youtube-channel-client.js";
import { parseYouTubeChannelInput } from "../shared/youtube-channel-input.js";
import { parseViewerPrefs, STORAGE_KEY_VIEWER_PREFS, type YouTubeViewerPrefs } from "../content/youtube-prefs.js";
import type { WatchPageStatus } from "../shared/viewer-port.js";
import { buildStreamView, buildWatchView, type PlatformRowModel, type StatusLine } from "./view-model.js";

const STORAGE_KEY_POPUP_TAB = "riftsight.popupTab";
const STORAGE_KEY_ONBOARDED = "riftsight.onboarded";

function el<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as unknown as T;
}

// --------------------------------------------------------------- view refs
const viewOnboarding = el<HTMLDivElement>("view-onboarding");
const viewMain = el<HTMLDivElement>("view-main");
const viewSettings = el<HTMLDivElement>("view-settings");

const tabWatch = el<HTMLButtonElement>("tab-watch");
const tabStream = el<HTMLButtonElement>("tab-stream");
const panelWatch = el<HTMLElement>("panel-watch");
const panelStream = el<HTMLElement>("panel-stream");

const watchEnable = el<HTMLDivElement>("watch-enable");
const watchEnableButton = el<HTMLButtonElement>("watch-enable-button");
const watchStatus = el<HTMLDivElement>("watch-status");
const watchOverlaysToggle = el<HTMLInputElement>("watch-overlays-toggle");
const watchPageDot = el<HTMLSpanElement>("watch-page-dot");
const watchPageText = el<HTMLSpanElement>("watch-page-text");

const streamAtlasDot = el<HTMLSpanElement>("stream-atlas-dot");
const streamAtlasText = el<HTMLSpanElement>("stream-atlas-text");
const streamPublishingDot = el<HTMLSpanElement>("stream-publishing-dot");
const streamPublishingText = el<HTMLSpanElement>("stream-publishing-text");
const streamTwitchDetail = el<HTMLSpanElement>("stream-twitch-detail");
const streamTwitchConnect = el<HTMLButtonElement>("stream-twitch-connect");
const streamYoutubeDetail = el<HTMLSpanElement>("stream-youtube-detail");
const streamYoutubeConnect = el<HTMLButtonElement>("stream-youtube-connect");
const streamPrimary = el<HTMLButtonElement>("stream-primary");
const streamNotice = el<HTMLDivElement>("stream-notice");

const settingsAccount = el<HTMLDivElement>("settings-account");
const settingsDisconnect = el<HTMLButtonElement>("settings-disconnect");
const settingsTwitchDetail = el<HTMLSpanElement>("settings-twitch-detail");
const settingsTwitchConnect = el<HTMLButtonElement>("settings-twitch-connect");
const settingsYoutubeDetail = el<HTMLSpanElement>("settings-youtube-detail");
const settingsYoutubeConnect = el<HTMLButtonElement>("settings-youtube-connect");
const settingsClaim = el<HTMLDivElement>("settings-claim");
const settingsClaimInput = el<HTMLInputElement>("settings-claim-input");
const settingsClaimSave = el<HTMLButtonElement>("settings-claim-save");
const settingsClaimClear = el<HTMLButtonElement>("settings-claim-clear");
const settingsClaimStatus = el<HTMLDivElement>("settings-claim-status");

// ----------------------------------------------------------------- state
type Tab = "watch" | "stream";
let activeTab: Tab = "watch";
let settingsOpen = false;

let permissionGranted = false;
let viewerPrefs: YouTubeViewerPrefs = parseViewerPrefs(undefined);
let watchPage: WatchPageStatus | null = null;

let link: LinkState = { status: "not-connected", displayName: undefined, platform: undefined };
let presence: PresenceStatus = "no-riftatlas";
let publishingIntent = false;
let relayStatus: "connecting" | "connected" | "disconnected" = "disconnected";
let producerReplaced = false;
let viewerCount: number | undefined;
let youtubeClaim: { channelId: string | null; displayName: string | null } | "unknown" = "unknown";

// ----------------------------------------------------------- shared render
const CLAIM_ERROR_TEXT: Record<YouTubeChannelFailure, string> = {
  "not-linked": "Connect Twitch or YouTube first — linking uses your RiftSight sign-in.",
  "backend-not-configured": "No backend configured in this build (development mode).",
  conflict: "That channel is already linked to another RiftSight streamer.",
  invalid: "That doesn't look like a valid channel ID.",
  network: "Couldn't reach RiftSight — try again in a moment.",
};

// Stream rows are single-line, right-aligned values that ellipsize when long
// (row-sub); the Watch page line is a full sentence, so it wraps left instead.
function renderStatusLine(dot: HTMLElement, text: HTMLElement, line: StatusLine, wrap = false): void {
  dot.className = `dot ${line.tone === "on" ? "on" : line.tone === "waiting" ? "waiting" : line.tone === "warn" ? "warn" : ""}`.trim();
  const shape = wrap ? "status-text grow" : "status-text row-sub grow";
  text.className = `${shape} ${line.tone === "off" ? "off" : line.tone === "warn" ? "warn" : ""}`.trim();
  text.style.textAlign = wrap ? "left" : "right";
  text.textContent = line.text;
}

function platformDetailText(row: PlatformRowModel): string {
  if (row.state === "connected") return row.detail ?? "Connected";
  if (row.state === "busy") return row.detail ?? "…";
  if (row.state === "coming-soon") return row.detail ?? "Coming soon";
  return row.detail ?? "Not connected";
}

function renderViews(): void {
  viewSettings.hidden = !settingsOpen;
  viewMain.hidden = settingsOpen || viewOnboarding.hidden === false;
  if (settingsOpen) renderSettings();
}

function renderTabs(): void {
  tabWatch.setAttribute("aria-selected", String(activeTab === "watch"));
  tabStream.setAttribute("aria-selected", String(activeTab === "stream"));
  panelWatch.hidden = activeTab !== "watch";
  panelStream.hidden = activeTab !== "stream";
}

function renderWatch(): void {
  const view = buildWatchView({ permissionGranted, overlaysEnabled: viewerPrefs.enabled, page: watchPage });
  watchEnable.hidden = view.kind !== "enable";
  watchStatus.hidden = view.kind !== "status";
  if (view.kind === "status") {
    watchOverlaysToggle.checked = view.overlaysOn;
    renderStatusLine(watchPageDot, watchPageText, view.page, true);
  }
}

function renderStream(): void {
  const view = buildStreamView({ link, presence, publishingIntent, relayStatus, producerReplaced, viewerCount, youtubeClaim });

  renderStatusLine(streamAtlasDot, streamAtlasText, view.atlas);
  renderStatusLine(streamPublishingDot, streamPublishingText, view.publishing);

  streamTwitchDetail.textContent = platformDetailText(view.twitch);
  streamTwitchConnect.hidden = !view.twitch.connectable;
  streamYoutubeDetail.textContent = platformDetailText(view.youtube);
  streamYoutubeConnect.hidden = !view.youtube.connectable;

  streamPrimary.textContent = view.primary.label;
  streamPrimary.disabled = !view.primary.enabled;

  streamNotice.hidden = view.notice === null;
  streamNotice.textContent = view.notice ?? "";
}

function renderSettings(): void {
  const linked = link.status === "connected" || link.status === "credential-expired" || link.status === "backend-unavailable";
  settingsAccount.textContent = linked
    ? `Signed in via ${link.platform === "youtube" ? "YouTube" : "Twitch"}${link.displayName ? ` as ${link.displayName}` : ""}`
    : link.status === "not-connected"
      ? "No RiftSight account — viewers don't need one. Streamers sign in by connecting a platform below."
      : LINK_STATUS_LABEL[link.status];
  settingsDisconnect.hidden = !linked;

  const view = buildStreamView({ link, presence, publishingIntent, relayStatus, producerReplaced, viewerCount, youtubeClaim });
  settingsTwitchDetail.textContent = platformDetailText(view.twitch);
  settingsTwitchConnect.hidden = !view.twitch.connectable;
  settingsYoutubeDetail.textContent = platformDetailText(view.youtube);
  settingsYoutubeConnect.hidden = !view.youtube.connectable;

  // The manual channel claim is the beta attach path for an already-linked
  // account (verified Google sign-in covers fresh YouTube-only accounts).
  settingsClaim.hidden = !linked;
  if (linked && youtubeClaim !== "unknown") {
    settingsClaimClear.hidden = !youtubeClaim.channelId;
    if (!settingsClaimInput.value && youtubeClaim.channelId) settingsClaimInput.value = youtubeClaim.channelId;
  }
}

function renderAll(): void {
  renderTabs();
  renderWatch();
  renderStream();
  renderViews();
}

// ------------------------------------------------------------- data refresh
function refreshWatchData(): void {
  void isYouTubeEnabled().then((enabled) => {
    permissionGranted = enabled;
    renderWatch();
  });
  void chrome.storage.local
    .get(STORAGE_KEY_VIEWER_PREFS)
    .then((stored) => {
      viewerPrefs = parseViewerPrefs((stored as Record<string, unknown>)[STORAGE_KEY_VIEWER_PREFS]);
      renderWatch();
    })
    .catch(() => {});
  void safeSendMessage<{ status?: WatchPageStatus | null }>({ type: "get-watch-status" })
    .then((response) => {
      watchPage = response?.status ?? null;
      renderWatch();
    })
    .catch(() => {
      watchPage = null;
      renderWatch();
    });
}

function refreshStreamData(): void {
  void safeSendMessage<LinkState>({ type: "get-link-state" })
    .then((state) => {
      if (state) link = state;
      renderStream();
      if (settingsOpen) renderSettings();
    })
    .catch(() => {
      link = { ...link, status: "backend-unavailable" };
      renderStream();
    });
  void safeSendMessage<{ status?: PresenceStatus }>({ type: "get-presence-state" })
    .then((response) => {
      presence = response?.status ?? "no-riftatlas";
      renderStream();
    })
    .catch(() => {});
  void safeSendMessage<{ intent?: boolean }>({ type: "get-publishing-intent" })
    .then((response) => {
      publishingIntent = Boolean(response?.intent);
      renderStream();
    })
    .catch(() => {});
  void safeSendMessage<{ status?: string; replaced?: boolean; viewerCount?: number }>({ type: "get-status" })
    .then((response) => {
      relayStatus = response?.status === "connected" ? "connected" : response?.status === "connecting" ? "connecting" : "disconnected";
      producerReplaced = Boolean(response?.replaced);
      viewerCount = response?.viewerCount;
      renderStream();
    })
    .catch(() => {});
}

let claimRefreshed = false;
function refreshClaim(force = false): void {
  if (claimRefreshed && !force) return;
  claimRefreshed = true;
  void fetchClaimedYouTubeChannel().then((result) => {
    // Definitive answers (including "this build has no backend" and "not
    // signed in") render as not-linked; only a transient network failure
    // keeps the row in its busy state for the next refresh to resolve.
    youtubeClaim = result.ok
      ? { channelId: result.channelId, displayName: result.displayName }
      : result.error === "network"
        ? "unknown"
        : { channelId: null, displayName: null };
    renderStream();
    if (settingsOpen) renderSettings();
  });
}

// ---------------------------------------------------------------- actions
el<HTMLButtonElement>("settings-button").addEventListener("click", () => {
  settingsOpen = !settingsOpen;
  refreshClaim(true);
  renderAll();
});
el<HTMLButtonElement>("settings-back").addEventListener("click", () => {
  settingsOpen = false;
  renderAll();
});

function selectTab(tab: Tab): void {
  activeTab = tab;
  void chrome.storage.local.set({ [STORAGE_KEY_POPUP_TAB]: tab }).catch(() => {});
  renderTabs();
}
tabWatch.addEventListener("click", () => selectTab("watch"));
tabStream.addEventListener("click", () => selectTab("stream"));

watchEnableButton.addEventListener("click", () => {
  // Must run directly in the click handler — Chrome only honors
  // permissions.request from a user gesture.
  void chrome.permissions
    .request({ origins: [YOUTUBE_ORIGIN] })
    .then((granted) => (granted ? enableYouTube() : undefined))
    .then(() => refreshWatchData())
    .catch(() => {});
});

watchOverlaysToggle.addEventListener("change", () => {
  viewerPrefs = { ...viewerPrefs, enabled: watchOverlaysToggle.checked };
  void chrome.storage.local.set({ [STORAGE_KEY_VIEWER_PREFS]: viewerPrefs }).catch(() => {});
  renderWatch();
});

function connectPlatform(platform: "twitch" | "youtube"): void {
  void safeSendMessage({ type: "start-link", platform }).then(() => {
    refreshStreamData();
    // Now that an account exists, re-run the one-shot claim lookup so the
    // other platform's row resolves from "Checking…" to its real state
    // ("Link in Settings" or the linked channel) instead of hanging.
    refreshClaim(true);
  });
}
streamTwitchConnect.addEventListener("click", () => connectPlatform("twitch"));
streamYoutubeConnect.addEventListener("click", () => connectPlatform("youtube"));
settingsTwitchConnect.addEventListener("click", () => connectPlatform("twitch"));
settingsYoutubeConnect.addEventListener("click", () => connectPlatform("youtube"));

settingsDisconnect.addEventListener("click", () => {
  void safeSendMessage({ type: "disconnect-link" }).then(() => {
    youtubeClaim = "unknown";
    refreshStreamData();
    renderAll();
  });
});

streamPrimary.addEventListener("click", () => {
  publishingIntent = !publishingIntent;
  renderStream();
  void safeSendMessage({ type: "set-publishing-intent", intent: publishingIntent }).catch(() => {
    // Best-effort — the background's own state remains authoritative and
    // the next refresh reconciles.
  });
});

el<HTMLButtonElement>("calibrate-button").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("calibration.html") });
});

settingsClaimSave.addEventListener("click", () => {
  const channelId = parseYouTubeChannelInput(settingsClaimInput.value);
  if (!channelId) {
    settingsClaimStatus.textContent = "Paste your channel ID (starts with UC) or a youtube.com/channel/UC… URL.";
    return;
  }
  settingsClaimStatus.textContent = "Saving…";
  void saveYouTubeChannelClaim(channelId).then((result) => {
    if (result.ok) {
      settingsClaimStatus.textContent = "Linked.";
      refreshClaim(true);
    } else {
      settingsClaimStatus.textContent = CLAIM_ERROR_TEXT[result.error];
    }
  });
});

settingsClaimClear.addEventListener("click", () => {
  settingsClaimStatus.textContent = "Clearing…";
  void clearYouTubeChannelClaim().then((result) => {
    settingsClaimStatus.textContent = result.ok ? "Cleared." : CLAIM_ERROR_TEXT[result.error];
    settingsClaimInput.value = "";
    refreshClaim(true);
  });
});

// -------------------------------------------------------------- onboarding
function completeOnboarding(defaultTab: Tab, requestYouTube: boolean): void {
  const finish = (): void => {
    void chrome.storage.local.set({ [STORAGE_KEY_ONBOARDED]: true }).catch(() => {});
    viewOnboarding.hidden = true;
    selectTab(defaultTab);
    renderAll();
    refreshWatchData();
    refreshStreamData();
    refreshClaim();
  };
  if (requestYouTube) {
    // The onboarding button click is the user gesture the permission
    // prompt needs — request inline, then continue either way (declining
    // just leaves the Watch view showing its enable CTA).
    void chrome.permissions
      .request({ origins: [YOUTUBE_ORIGIN] })
      .then((granted) => (granted ? enableYouTube() : undefined))
      .catch(() => {})
      .then(finish);
  } else {
    finish();
  }
}
el<HTMLButtonElement>("onboard-watch").addEventListener("click", () => completeOnboarding("watch", true));
el<HTMLButtonElement>("onboard-stream").addEventListener("click", () => completeOnboarding("stream", false));
el<HTMLButtonElement>("onboard-both").addEventListener("click", () => completeOnboarding("watch", true));

// ----------------------------------------------------------------- startup
async function init(): Promise<void> {
  const stored = (await chrome.storage.local.get([STORAGE_KEY_POPUP_TAB, STORAGE_KEY_ONBOARDED]).catch(() => ({}))) as Record<string, unknown>;
  const onboarded = stored[STORAGE_KEY_ONBOARDED] === true;
  activeTab = stored[STORAGE_KEY_POPUP_TAB] === "stream" ? "stream" : "watch";

  viewOnboarding.hidden = onboarded;
  renderAll();
  if (onboarded) {
    refreshWatchData();
    refreshStreamData();
    refreshClaim();
  }
}

void init();

// Chrome tears this document down on every close — the interval only keeps
// a single open popup fresh.
setInterval(() => {
  if (!viewOnboarding.hidden) return;
  refreshWatchData();
  refreshStreamData();
}, 2000);
