// The YouTube viewer host: injected (dynamically — see
// background/youtube-enable.ts) into youtube.com, self-gated to LIVE
// watch pages, rendering the same CardHoverOverlay every other RiftSight
// surface uses over the player's video content area. All relay traffic
// flows through the background worker over a long-lived Port (see
// shared/viewer-port.ts) — this script never opens a socket (page-CSP
// subjection) and never learns anything about the viewer.
//
// Live-page gating is load-bearing, not cosmetic: the channel->session
// mapping is per-CHANNEL, so a VOD on a channel whose owner is
// simultaneously live playing RiftAtlas would otherwise get live board
// state painted onto old footage.

import {
  CardHoverOverlay,
  delayedLiveTarget,
  isWaitingForHistory,
  parseSourceRegion,
  FULL_FRAME_SOURCE_REGION,
} from "@riftsight/overlay-core";
import { TimeWindowBuffer, type OverlayState } from "@riftsight/protocol";
import { YOUTUBE_VIEWER_PORT, type ViewerPortMessageFromContent, type ViewerPortMessageToContent, type WatchPageStatus } from "../shared/viewer-port.js";
import { computeContainedRect, resolveViewerDelayMs, scaleTooltipForStage } from "./youtube-geometry.js";
import {
  DEFAULT_VIEWER_PREFS,
  DEFAULT_YOUTUBE_DELAY_MS,
  MAX_VIEWER_DELAY_MS,
  parseViewerPrefs,
  STORAGE_KEY_VIEWER_PREFS,
  type YouTubeViewerPrefs,
} from "./youtube-prefs.js";

// Double-injection guard: the grant flow's executeScript catch-up and the
// dynamic registration can both land in one tab (grant while a youtube
// tab is open, then a soft reload). Second arrival is a no-op.
declare global {
  interface Window {
    __riftsightYouTubeViewer?: boolean;
  }
}
if (window.__riftsightYouTubeViewer) {
  // already running in this document
} else {
  window.__riftsightYouTubeViewer = true;
  initYouTubeViewer();
}

interface WatchTarget {
  channelId: string;
  player: HTMLElement;
  video: HTMLVideoElement;
}

function initYouTubeViewer(): void {
  const DELAYED_LIVE_TICK_MS = 200;
  const BUFFER_RETENTION_MARGIN_MS = 30_000;
  const NAVIGATION_SETTLE_ATTEMPTS = 10;
  const NAVIGATION_SETTLE_INTERVAL_MS = 600;
  const PORT_RECONNECT_MIN_MS = 1_000;
  const PORT_RECONNECT_MAX_MS = 10_000;

  // ------------------------------------------------------------------ state
  const STAGE_WATCHDOG_INTERVAL_MS = 1_000;
  let port: chrome.runtime.Port | null = null;
  let portReconnectMs = PORT_RECONNECT_MIN_MS;
  let announcedChannelId: string | null = null;

  let target: WatchTarget | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleAttemptsLeft = 0;

  const stateBuffer = new TimeWindowBuffer<OverlayState>(MAX_VIEWER_DELAY_MS + BUFFER_RETENTION_MARGIN_MS, 2000);
  let bufferStartedAt = Date.now();
  let displayedState: OverlayState | undefined;
  let latestState: OverlayState | undefined;
  let rejectedForCurrentChannel = false;

  let prefs: YouTubeViewerPrefs = DEFAULT_VIEWER_PREFS;

  // ------------------------------------------------------------- overlay DOM
  // Everything lives under one root appended to the PLAYER element so
  // element-fullscreen keeps containing it. Created once, moved between
  // players if YouTube swaps the element, hidden whenever inactive.
  const root = document.createElement("div");
  root.className = "riftsight-yt-root";
  root.style.display = "none";

  const stage = document.createElement("div");
  stage.className = "riftsight-yt-stage";
  const tooltip = document.createElement("div");
  tooltip.className = "riftsight-yt-tooltip";
  stage.appendChild(tooltip);
  root.appendChild(stage);

  const gearButton = document.createElement("button");
  gearButton.className = "riftsight-yt-gear";
  gearButton.type = "button";
  gearButton.title = "RiftSight overlay settings";
  gearButton.textContent = "⚙";
  root.appendChild(gearButton);

  const panel = document.createElement("div");
  panel.className = "riftsight-yt-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <label class="riftsight-yt-row"><input type="checkbox" data-pref="enabled" /> Card overlay</label>
    <label class="riftsight-yt-row"><input type="checkbox" data-pref="outlines" /> Show card outlines</label>
    <div class="riftsight-yt-row riftsight-yt-delay-row">
      <span>Delay <span data-delay-label></span></span>
      <input type="range" min="0" max="${MAX_VIEWER_DELAY_MS / 1000}" step="1" data-pref="delay" />
    </div>
    <div class="riftsight-yt-hint">Match the delay to your stream latency so cards line up with the video.</div>
  `;
  root.appendChild(panel);

  const style = document.createElement("style");
  // Scoped under .riftsight-yt-* — mirrors twitch-extension/viewer.html's
  // hitbox/tooltip styling (the classes are emitted by CardHoverOverlay
  // itself, so the names must match), plus the injected chrome this host
  // adds (gear + panel). z-index 40 sits above the video and the
  // player's gradient overlays but below YouTube's own controls bar.
  style.textContent = `
    .riftsight-yt-root { position: absolute; inset: 0; pointer-events: none; z-index: 40; font: 12px/1.4 Roboto, Arial, sans-serif; color: #e6e6e6; }
    .riftsight-yt-stage { position: absolute; pointer-events: none; }
    .riftsight-yt-stage .hitbox { position: absolute; box-sizing: border-box; border: 1px solid transparent; pointer-events: none; }
    .riftsight-yt-stage .hitbox.debug-outline { border-color: rgba(102, 255, 102, 0.6); background: rgba(102, 255, 102, 0.05); }
    .riftsight-yt-stage .hitbox.debug-outline.hidden-card { border-color: rgba(255, 102, 102, 0.6); background: rgba(255, 102, 102, 0.05); }
    .riftsight-yt-tooltip { position: absolute; pointer-events: none; display: none; z-index: 10; }
    .riftsight-yt-tooltip .tooltip-art { display: block; border-radius: 6px; filter: drop-shadow(0 4px 16px rgba(0, 0, 0, 0.6)); object-fit: contain; }
    .riftsight-yt-tooltip .tooltip-fallback { max-width: 240px; background: rgba(17, 17, 17, 0.95); border: 1px solid #444; border-radius: 4px; padding: 6px 8px; font-size: 12px; }
    .riftsight-yt-tooltip .tooltip-debug { margin-top: 4px; max-width: 320px; background: rgba(17, 17, 17, 0.85); border-radius: 4px; padding: 4px 8px; color: #9fdf9f; font-size: 11px; }
    .riftsight-yt-gear { position: absolute; top: 8px; right: 8px; pointer-events: auto; cursor: pointer; width: 28px; height: 28px; border-radius: 50%; border: none; background: rgba(17, 17, 17, 0.6); color: #fff; font-size: 14px; opacity: 0; transition: opacity 0.15s; }
    .riftsight-yt-root:hover .riftsight-yt-gear { opacity: 0.85; }
    .riftsight-yt-gear:hover { opacity: 1 !important; }
    .riftsight-yt-panel { position: absolute; top: 42px; right: 8px; pointer-events: auto; background: rgba(11, 15, 22, 0.95); border: 1px solid #4c1d95; border-radius: 6px; padding: 10px 12px; width: 220px; }
    .riftsight-yt-row { display: block; margin-bottom: 8px; }
    .riftsight-yt-row input[type="range"] { width: 100%; }
    .riftsight-yt-hint { font-size: 11px; color: #8b8b98; }
  `;
  document.documentElement.appendChild(style);

  const overlay = new CardHoverOverlay({ stage, tooltip });
  overlay.attachMouseHover();

  // -------------------------------------------------------------- prefs UI
  const enabledCheckbox = panel.querySelector<HTMLInputElement>('[data-pref="enabled"]')!;
  const outlinesCheckbox = panel.querySelector<HTMLInputElement>('[data-pref="outlines"]')!;
  const delaySlider = panel.querySelector<HTMLInputElement>('[data-pref="delay"]')!;
  const delayLabel = panel.querySelector<HTMLElement>("[data-delay-label]")!;

  function currentDelayMs(): number {
    return resolveViewerDelayMs(prefs.delayMs, latestState?.overlayConfig?.recommendedDelayMs, DEFAULT_YOUTUBE_DELAY_MS);
  }

  function syncPanelFromPrefs(): void {
    enabledCheckbox.checked = prefs.enabled;
    outlinesCheckbox.checked = prefs.outlines;
    const delayMs = currentDelayMs();
    delaySlider.value = String(Math.round(delayMs / 1000));
    delayLabel.textContent = `${Math.round(delayMs / 1000)}s${prefs.delayMs === null ? " (auto)" : ""}`;
  }

  function persistPrefs(): void {
    void chrome.storage.local.set({ [STORAGE_KEY_VIEWER_PREFS]: prefs }).catch(() => {});
  }

  gearButton.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    syncPanelFromPrefs();
  });
  enabledCheckbox.addEventListener("change", () => {
    prefs = { ...prefs, enabled: enabledCheckbox.checked };
    persistPrefs();
    applyConfigToOverlay();
  });
  outlinesCheckbox.addEventListener("change", () => {
    prefs = { ...prefs, outlines: outlinesCheckbox.checked };
    persistPrefs();
    applyConfigToOverlay();
  });
  delaySlider.addEventListener("input", () => {
    prefs = { ...prefs, delayMs: Number(delaySlider.value) * 1000 };
    delayLabel.textContent = `${delaySlider.value}s`;
    persistPrefs();
  });

  void chrome.storage.local
    .get(STORAGE_KEY_VIEWER_PREFS)
    .then((stored) => {
      prefs = parseViewerPrefs((stored as Record<string, unknown>)[STORAGE_KEY_VIEWER_PREFS]);
      syncPanelFromPrefs();
      applyConfigToOverlay();
    })
    .catch(() => {});

  // --------------------------------------------------------- stage geometry
  let syncQueued = false;

  /**
   * Positions the stage exactly over the video CONTENT (letterbox-aware —
   * see computeContainedRect) in player-local coordinates. Coalesced via
   * rAF with a setTimeout fallback racing it — rAF alone stalls entirely
   * in hidden tabs (and some embedded environments), which would leave
   * the stage unpositioned until the next user-visible frame; whichever
   * scheduler fires first wins and the queued flag makes the loser a
   * no-op.
   */
  function queueStageSync(): void {
    if (syncQueued) return;
    syncQueued = true;
    const run = (): void => {
      if (!syncQueued) return;
      syncQueued = false;
      if (!target) return;
      const playerRect = target.player.getBoundingClientRect();
      const videoRect = target.video.getBoundingClientRect();
      const content = computeContainedRect(
        { x: videoRect.x, y: videoRect.y, width: videoRect.width, height: videoRect.height },
        target.video.videoWidth,
        target.video.videoHeight
      );
      const next = {
        left: `${content.x - playerRect.x}px`,
        top: `${content.y - playerRect.y}px`,
        width: `${content.width}px`,
        height: `${content.height}px`,
      };
      const key = `${next.left} ${next.top} ${next.width} ${next.height}`;
      if (key === lastAppliedStageKey) return;
      lastAppliedStageKey = key;
      stage.style.left = next.left;
      stage.style.top = next.top;
      stage.style.width = next.width;
      stage.style.height = next.height;
      applyConfigToOverlay();
    };
    requestAnimationFrame(run);
    setTimeout(run, 100);
  }

  let lastAppliedStageKey = "";

  const resizeObserver = new ResizeObserver(queueStageSync);
  window.addEventListener("resize", queueStageSync);
  document.addEventListener("fullscreenchange", queueStageSync);
  // Safety net under all of the above: rAF and ResizeObserver both ride
  // the rendering frame loop, which stalls entirely in hidden tabs (and
  // some embedded environments) — a once-a-second recheck guarantees the
  // stage converges on the video within a beat no matter which delivery
  // mechanism failed. Cheap: two rect reads, and the key-compare in run()
  // means zero style writes when nothing moved.
  setInterval(() => {
    if (target) queueStageSync();
  }, STAGE_WATCHDOG_INTERVAL_MS);

  // ------------------------------------------------------------- rendering
  function applyConfigToOverlay(): void {
    const wire = latestState?.overlayConfig;
    const sourceRegion = wire?.sourceRegion ? parseSourceRegion(wire.sourceRegion) : FULL_FRAME_SOURCE_REGION;
    const stageWidth = stage.getBoundingClientRect().width || 1;
    overlay.setConfig({
      sourceRegion,
      tooltipScale: scaleTooltipForStage(stageWidth, wire?.tooltipScale ?? 1),
      debugOutlines: prefs.outlines,
      overlayEnabled: prefs.enabled && (wire?.overlayEnabled ?? true),
    });
  }

  function applyState(state: OverlayState | undefined): void {
    if (state === displayedState) return;
    displayedState = state;
    overlay.setCards(state ? state.cards : [], state?.blockingRegion);
  }

  setInterval(() => {
    if (!target || rejectedForCurrentChannel) return;
    const now = Date.now();
    const delayMs = currentDelayMs();
    const waiting = isWaitingForHistory(bufferStartedAt, delayMs, now);
    applyState(waiting ? undefined : stateBuffer.findAtOrBefore(delayedLiveTarget(now, delayMs))?.value);
  }, DELAYED_LIVE_TICK_MS);

  // ------------------------------------------------------------------ port
  function ensurePort(): chrome.runtime.Port | null {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: YOUTUBE_VIEWER_PORT });
    } catch {
      schedulePortReconnect();
      return null;
    }
    port.onMessage.addListener((message: ViewerPortMessageToContent) => {
      if (message.type === "overlay-state") {
        latestState = message.state;
        rejectedForCurrentChannel = false;
        stateBuffer.push(message.state.capturedAt, message.state);
        const firstState = root.style.display === "none";
        root.style.display = "block";
        applyConfigToOverlay();
        if (firstState) reportPageStatus();
        return;
      }
      if (message.type === "subscribe-rejected") {
        // Quiet no-op posture: no session for this channel — show nothing,
        // leave the page exactly as if RiftSight weren't installed. The
        // background retries rejected channels about once a minute.
        rejectedForCurrentChannel = true;
        applyState(undefined);
        root.style.display = "none";
        reportPageStatus();
        return;
      }
      // relay-status: no UI today — reconnects are the background's job.
    });
    port.onDisconnect.addListener(() => {
      // Background worker restarted (routine MV3) — reconnect with backoff
      // and re-announce whatever this tab is watching.
      port = null;
      schedulePortReconnect();
    });
    portReconnectMs = PORT_RECONNECT_MIN_MS;
    return port;
  }

  function schedulePortReconnect(): void {
    const delay = portReconnectMs;
    portReconnectMs = Math.min(portReconnectMs * 2, PORT_RECONNECT_MAX_MS);
    setTimeout(() => {
      if (announcedChannelId === null) return; // nothing to watch — reconnect lazily on the next navigation instead
      const reconnected = ensurePort();
      if (reconnected) announce(announcedChannelId);
    }, delay);
  }

  /** The popup's Watch view renders off these reports (see shared/viewer-port.ts). Sent on every meaningful transition; cheap and idempotent. */
  function reportPageStatus(): void {
    const onWatchPage = location.pathname === "/watch";
    const player = onWatchPage ? findPlayer() : null;
    const live = player !== null && isLivePlayer(player);
    const status: WatchPageStatus = target
      ? {
          pageKind: "live-watch",
          channelId: target.channelId,
          session: rejectedForCurrentChannel ? "unavailable" : latestState ? "active" : "waiting",
        }
      : { pageKind: onWatchPage ? (live ? "live-watch" : "vod-watch") : "other", channelId: null, session: "idle" };
    const activePort = ensurePort();
    if (!activePort) return;
    try {
      activePort.postMessage({ type: "page-status", status } satisfies ViewerPortMessageFromContent);
    } catch {
      port = null;
      schedulePortReconnect();
    }
  }

  function announce(channelId: string | null): void {
    announcedChannelId = channelId;
    const activePort = ensurePort();
    if (!activePort) return;
    try {
      activePort.postMessage({ type: "watch-channel", channelId } satisfies ViewerPortMessageFromContent);
    } catch {
      port = null;
      schedulePortReconnect();
    }
  }

  // ----------------------------------------------------- watch-page detection
  function findPlayer(): HTMLElement | null {
    return document.querySelector<HTMLElement>("#movie_player");
  }

  function findVideo(player: HTMLElement): HTMLVideoElement | null {
    return player.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  }

  /** YouTube marks a live player by putting ytp-live on the time display. DVR-paused live still carries it; finished-stream VODs don't. */
  function isLivePlayer(player: HTMLElement): boolean {
    return player.querySelector(".ytp-time-display.ytp-live, .ytp-time-display .ytp-live-badge:not([disabled])") !== null;
  }

  /**
   * The watch page's channel id, from page microdata. YouTube maintains
   * these across SPA navigations (with a small lag — hence the settle
   * retries in evaluateWatchState). Two independent sources checked in
   * order; both are the PAGE's own statement of whose video this is.
   */
  function findChannelId(): string | null {
    const meta = document.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]');
    if (meta?.content && /^UC[A-Za-z0-9_-]{22}$/.test(meta.content)) return meta.content;
    const authorLink = document.querySelector<HTMLLinkElement>('span[itemprop="author"] link[itemprop="url"]');
    const match = authorLink?.href?.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?:$|[/?#])/);
    return match?.[1] ?? null;
  }

  function deactivate(): void {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = undefined;
    target = null;
    resizeObserver.disconnect();
    latestState = undefined;
    rejectedForCurrentChannel = false;
    stateBuffer.clear();
    displayedState = undefined;
    overlay.setCards([]);
    overlay.hide();
    root.style.display = "none";
    panel.style.display = "none";
    announce(null);
    reportPageStatus();
  }

  function activate(channelId: string, player: HTMLElement, video: HTMLVideoElement): void {
    target = { channelId, player, video };
    bufferStartedAt = Date.now();
    stateBuffer.clear();
    displayedState = undefined;
    latestState = undefined;
    rejectedForCurrentChannel = false;

    if (root.parentElement !== player) player.appendChild(root);
    // Hidden until the first state arrives — an inert page shows nothing.
    root.style.display = "none";

    resizeObserver.disconnect();
    resizeObserver.observe(player);
    resizeObserver.observe(video);
    video.addEventListener("loadedmetadata", queueStageSync);
    video.addEventListener("resize", queueStageSync);
    queueStageSync();
    announce(channelId);
    reportPageStatus();
  }

  /**
   * Decides what this document currently is — retried a few beats after
   * each navigation because YouTube populates the player, live badge, and
   * microdata asynchronously (same settle-don't-assume pattern as the
   * producer side's card-observer settle loop).
   */
  function evaluateWatchState(): void {
    const onWatchPage = location.pathname === "/watch";
    const player = onWatchPage ? findPlayer() : null;
    const video = player ? findVideo(player) : null;
    const channelId = onWatchPage ? findChannelId() : null;
    const live = player !== null && isLivePlayer(player);

    if (onWatchPage && player && video && channelId && live) {
      if (target?.channelId !== channelId || target.player !== player || target.video !== video) {
        activate(channelId, player, video);
      }
      return;
    }

    // Not (yet) a live watch page — keep retrying while attempts remain
    // (the page may still be settling), otherwise conclude inactive.
    if (settleAttemptsLeft > 0) {
      settleAttemptsLeft -= 1;
      settleTimer = setTimeout(evaluateWatchState, NAVIGATION_SETTLE_INTERVAL_MS);
      if (target && !onWatchPage) deactivate(); // left the watch page outright — don't wait out the retries to stand down
      return;
    }
    if (target) deactivate();
    else reportPageStatus(); // settled on a non-live page having never activated — tell the popup what this page is
  }

  function onNavigation(): void {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleAttemptsLeft = NAVIGATION_SETTLE_ATTEMPTS;
    evaluateWatchState();
  }

  // yt-navigate-finish is YouTube's own SPA "new page is ready" event;
  // the initial load gets the same treatment.
  window.addEventListener("yt-navigate-finish", onNavigation);
  onNavigation();
}
