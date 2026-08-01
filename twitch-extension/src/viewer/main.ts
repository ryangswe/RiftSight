// Twitch video-overlay entry point. This same file drives both the real
// Twitch-hosted page (viewer.html, loads the real Twitch Extension
// Helper) and this repo's local mock harness (index.html, which sets
// window.__RIFTSIGHT_MOCK__ before this script loads) — per the milestone
// spec's requirement that mock mode run "the same UI code used inside
// Twitch". Only the OverlayStateSource implementation and the dev-only
// chrome differ between the two; the rendering logic below never touches
// window.Twitch directly — only the onAuthorized wiring at the bottom of
// this file does.
import {
  FULL_FRAME_SOURCE_REGION,
  cardPopupContentFor,
  computeHitboxStyle,
  computeTooltipPosition,
  delayedLiveTarget,
  hitboxClassName,
  isWaitingForHistory,
  mapBoundsToSourceRegion,
  tooltipContentFor,
  type SourceRegion,
} from "@riftsight/overlay-core";
import { TimeWindowBuffer, type OverlayCard, type OverlayState } from "@riftsight/protocol";
import { parseOverlayConfig, type OverlayConfig } from "../config/overlay-config.js";
import { MockOverlayStateSource, type MockConnectionStatus } from "../platform/mock-state-source.js";
import { getConfiguredRelayUrl } from "../platform/relay-url.js";
import { buildPlatformContext } from "../platform/twitch-context.js";
import { TwitchOverlayStateSource } from "../platform/twitch-state-source.js";

const isMock = window.__RIFTSIGHT_MOCK__ === true;

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const stage = requireElement<HTMLElement>("overlay-stage");
const tooltip = requireElement<HTMLElement>("tooltip");

// Every incoming state is buffered regardless of delay (a delay of 0ms is
// just "no meaningful lag" through the same pipeline, not a separate
// code path) — mirrors debug-viewer's delayed-live wiring exactly, reusing
// the same overlay-core calculators.
const stateBuffer = new TimeWindowBuffer<OverlayState>();
const bufferStartedAt = Date.now();
const DELAYED_LIVE_TICK_MS = 200;

let delayMs = 0;
let debugOutlines = false; // hidden by default in production; the mock harness has its own checkbox
let overlayEnabled = true; // broadcaster kill-switch, applied via broadcaster config in real Twitch mode
let sourceAspectRatioOverride: number | undefined; // broadcaster-set override for checkAspectRatioMismatch, when set
let sourceRegion: SourceRegion = FULL_FRAME_SOURCE_REGION; // where RiftAtlas sits within the stream canvas, broadcaster-calibrated
let latestCards: OverlayCard[] = [];
let displayedState: OverlayState | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

// Development-only connection diagnostics (real Twitch mode only — the
// mock harness's own dev panel already shows connection status directly,
// see index.html). `diagnosticsPanel` stays undefined in mock mode, so
// setDiagnosticStage is a safe no-op to call from anywhere regardless of
// mode. Gated behind debugOutlines rather than a separate flag — reuses
// the one dev-mode signal this app already has, per "unobtrusive and
// development-only".
let diagnosticsPanel: HTMLElement | undefined;
let lastDiagnosticStage = "";

function setDiagnosticStage(stage: string): void {
  lastDiagnosticStage = stage;
  if (!diagnosticsPanel) return;
  if (!debugOutlines) {
    diagnosticsPanel.style.display = "none";
    return;
  }
  diagnosticsPanel.style.display = "block";
  diagnosticsPanel.textContent = stage;
}

function positionTooltipNear(target: HTMLElement): void {
  const targetRect = target.getBoundingClientRect();
  const position = computeTooltipPosition(
    targetRect,
    { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  );
  tooltip.style.left = `${position.left}px`;
  tooltip.style.top = `${position.top}px`;
}

function createFallbackLabel(label: string): HTMLElement {
  const text = document.createElement("div");
  text.className = "tooltip-fallback";
  text.textContent = label;
  return text;
}

// Normal viewers see the card's art and nothing else — see cardPopupContentFor.
// The fuller zone/owner/instanceId text (tooltipContentFor) only ever
// appears here when debugOutlines is on, for calibration/QA purposes.
function showTooltipFor(card: OverlayCard, target: HTMLElement): void {
  cancelPendingHideTooltip();
  const content = cardPopupContentFor(card);
  tooltip.replaceChildren();

  if (content.imageUrl) {
    const img = document.createElement("img");
    img.src = content.imageUrl;
    img.alt = content.altText;
    // No `loading="lazy"` here: the <img> is only ever created on-demand
    // at hover time in the first place (never preloaded for every card),
    // which already gives "don't fetch until needed" for free. Adding
    // native lazy-loading on top gates the fetch behind an
    // IntersectionObserver-style heuristic that doesn't reliably fire for
    // a `position: fixed` popup that appears and disappears quickly —
    // confirmed to stall indefinitely (network request never even sent)
    // in manual testing. No cache-busting query param is added anywhere,
    // so normal browser HTTP caching still applies across hovers.
    img.decoding = "async";
    img.className = "tooltip-art";
    img.onerror = () => {
      // The popup may have already moved on to a different card by the
      // time a slow/broken image errors out — only replace content if
      // this image is still the one actually being shown. Swap just the
      // img node itself (not the whole tooltip) so a debug line appended
      // alongside it isn't lost.
      if (!img.isConnected) return;
      img.replaceWith(createFallbackLabel(content.fallbackLabel));
    };
    img.onload = () => {
      // The position computed below (before the image has loaded) assumes
      // a 0×0 box, since an <img> with no explicit width/height has no
      // intrinsic size until it loads. Once it loads and grows to its real
      // (much larger) size, re-run positioning so it's actually centered
      // near the card and re-clamped within the viewport instead of
      // silently growing past an edge.
      if (!img.isConnected) return;
      positionTooltipNear(target);
    };
    tooltip.appendChild(img);
  } else {
    tooltip.appendChild(createFallbackLabel(content.fallbackLabel));
  }

  if (debugOutlines) {
    const debugLine = document.createElement("div");
    debugLine.className = "tooltip-debug";
    debugLine.textContent = tooltipContentFor(card).lines.join(" · ");
    tooltip.appendChild(debugLine);
  }

  tooltip.style.display = "block";
  positionTooltipNear(target);
}

function hideTooltip(): void {
  cancelPendingHideTooltip();
  tooltip.style.display = "none";
}

// A short cancellable delay before actually hiding — without it, moving
// the cursor between adjacent/overlapping hitboxes (common for fanned hand
// cards) can flicker the popup closed and immediately back open. A
// mouseenter/focus on the next hitbox cancels the pending hide before it
// fires, so there's no visible gap.
const HOVER_HIDE_DELAY_MS = 80;
let pendingHideTooltip: ReturnType<typeof setTimeout> | undefined;

function cancelPendingHideTooltip(): void {
  if (pendingHideTooltip !== undefined) {
    clearTimeout(pendingHideTooltip);
    pendingHideTooltip = undefined;
  }
}

function scheduleHideTooltip(): void {
  cancelPendingHideTooltip();
  pendingHideTooltip = setTimeout(() => {
    pendingHideTooltip = undefined;
    tooltip.style.display = "none";
  }, HOVER_HIDE_DELAY_MS);
}

// #overlay-stage has pointer-events: none (see index.html); only these
// individual hitboxes opt back in, so nothing outside an active hitbox or
// the tooltip itself can ever intercept a click/hover meant for the
// underlying Twitch video player.
function renderHitboxes(): void {
  stage.replaceChildren();
  if (!overlayEnabled) return; // broadcaster kill-switch — no hitboxes, no tooltip, nothing rendered

  for (const card of latestCards) {
    const box = document.createElement("div");
    box.className = `${hitboxClassName(card)} ${debugOutlines ? "debug-outline" : ""}`.trim();
    box.tabIndex = 0;
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", tooltipContentFor(card).lines.join(", "));

    // Map RiftAtlas-relative bounds into the broadcaster-calibrated
    // source region before computing CSS position — a fresh view-model
    // object (never mutating `card`, which came straight out of the
    // buffered OverlayState). hitboxClassName/tooltipContentFor never
    // read bounds, so the original `card` is still correct for those and
    // for the hover/focus handlers below.
    const mappedBounds = mapBoundsToSourceRegion(card.bounds, sourceRegion);
    const style = computeHitboxStyle({ ...card, bounds: mappedBounds });
    box.style.left = style.left;
    box.style.top = style.top;
    box.style.width = style.width;
    box.style.height = style.height;
    box.style.zIndex = style.zIndex;

    box.addEventListener("mouseenter", () => showTooltipFor(card, box));
    box.addEventListener("mouseleave", scheduleHideTooltip);
    box.addEventListener("focus", () => showTooltipFor(card, box));
    box.addEventListener("blur", scheduleHideTooltip);

    stage.appendChild(box);
  }
}

// This milestone still uses direct rectangular mapping only (no
// automatic contain/cover/crop-edge/letterbox/perspective correction) —
// the broadcaster is expected to calibrate sourceRegion to the exact
// rectangle RiftAtlas is displayed in. Given that, a mismatch between the
// RiftAtlas source aspect ratio and *the calibrated region's own actual
// rendered aspect ratio on screen* (not the full stage's aspect ratio —
// the region may only cover part of it) usually means the calibration
// itself is off, or the capture was cropped/letterboxed upstream. Only
// logged in debug mode — normal viewers get no console noise.
// sourceAspectRatioOverride (broadcaster config's optional field) takes
// priority over each state's own sourceViewport when the broadcaster has
// explicitly set one; tolerance stays a constant since nothing in the
// spec calls for it to be independently configurable beyond that.
const ASPECT_RATIO_TOLERANCE = 0.02;
let lastSourceViewport: { width: number; height: number } | undefined;

function checkAspectRatioMismatch(): void {
  const sourceRatio = sourceAspectRatioOverride ?? (lastSourceViewport ? lastSourceViewport.width / lastSourceViewport.height : undefined);
  if (!debugOutlines || sourceRatio === undefined || stage.clientHeight === 0) return;
  const renderedRegionWidthPx = stage.clientWidth * sourceRegion.width;
  const renderedRegionHeightPx = stage.clientHeight * sourceRegion.height;
  if (renderedRegionHeightPx === 0) return;
  const renderedRatio = renderedRegionWidthPx / renderedRegionHeightPx;
  const relativeDiff = Math.abs(sourceRatio - renderedRatio) / sourceRatio;
  if (relativeDiff > ASPECT_RATIO_TOLERANCE) {
    const sourceLabel =
      sourceAspectRatioOverride !== undefined
        ? `broadcaster-configured ${sourceAspectRatioOverride.toFixed(3)}`
        : `${sourceRatio.toFixed(3)} (${lastSourceViewport?.width}x${lastSourceViewport?.height})`;
    console.warn(
      `[twitch-extension] source/rendered aspect ratio mismatch: source ${sourceLabel} vs the calibrated region's own ` +
        `rendered ratio ${renderedRatio.toFixed(3)} (${renderedRegionWidthPx.toFixed(0)}x${renderedRegionHeightPx.toFixed(0)} of a ` +
        `${stage.clientWidth}x${stage.clientHeight} stage) — hitboxes may be misaligned or the calibration may need adjusting.`
    );
  }
}

function applyState(state: OverlayState | undefined): void {
  if (state === displayedState) return; // no meaningful change — skip render
  displayedState = state;
  latestCards = state ? state.cards : [];
  if (state) lastSourceViewport = state.sourceViewport;
  renderHitboxes();
  checkAspectRatioMismatch();
  setDiagnosticStage(
    state
      ? `Receiving sequence ${state.sequence} (subscription admitted — inferred from state arrival; the relay sends no explicit ack)`
      : "Waiting for publisher state..."
  );
}

function delayedLiveTick(): void {
  const now = Date.now();
  const targetTime = delayedLiveTarget(now, delayMs);
  const waiting = isWaitingForHistory(bufferStartedAt, delayMs, now);
  applyState(waiting ? undefined : stateBuffer.findAtOrBefore(targetTime)?.value);
}

function startDelayedLiveTicking(): void {
  if (tickTimer !== undefined) clearInterval(tickTimer);
  tickTimer = setInterval(delayedLiveTick, DELAYED_LIVE_TICK_MS);
  delayedLiveTick();
}

// Applies a broadcaster-set OverlayConfig (real Twitch mode only — the
// mock harness drives delay/debugOutlines through its own dev-panel
// controls instead). Takes effect immediately, no iframe reload needed —
// called both on first read and from configuration.onChanged.
function applyConfig(config: OverlayConfig): void {
  overlayEnabled = config.overlayEnabled;
  delayMs = config.delayMs;
  debugOutlines = config.debugOutlines;
  sourceAspectRatioOverride = config.sourceAspectRatio;
  sourceRegion = config.sourceRegion;
  if (!overlayEnabled) hideTooltip();
  delayedLiveTick(); // re-selects state under the new delay; applyState only re-renders if the *selected state* changed
  renderHitboxes(); // config fields like overlayEnabled/debugOutlines change what's rendered even when the state itself didn't — must re-render unconditionally, not just rely on delayedLiveTick's state-dedup path
  checkAspectRatioMismatch();
  setDiagnosticStage(lastDiagnosticStage); // re-evaluates visibility now that debugOutlines may have just changed
}

// Hitboxes are positioned with CSS percentages against #overlay-stage
// (position: absolute; inset: 0), so they re-map correctly on their own
// whenever the iframe itself resizes — normal/theater/fullscreen player
// layouts all fall out of that for free, no per-layout-mode branching
// needed. The one thing worth re-checking on a resize is whether the
// source/rendered aspect ratio has drifted apart (see
// checkAspectRatioMismatch above).
window.addEventListener("resize", checkAspectRatioMismatch);

if (isMock) {
  const channelInput = requireElement<HTMLInputElement>("channel-input");
  const statusDot = requireElement<HTMLElement>("status-dot");
  const statusText = requireElement<HTMLElement>("status-text");
  const delayInput = requireElement<HTMLInputElement>("delay-input");
  const toggleOutlines = requireElement<HTMLInputElement>("toggle-outlines");
  const modeStatus = requireElement<HTMLElement>("mode-status");
  const bgImage = requireElement<HTMLImageElement>("mock-bg-image");
  const bgFileInput = requireElement<HTMLInputElement>("bg-file-input");
  const bgClearButton = requireElement<HTMLButtonElement>("bg-clear-button");
  const bgVideo = requireElement<HTMLVideoElement>("mock-bg-video");
  const bgVideoFileInput = requireElement<HTMLInputElement>("bg-video-file-input");
  const bgVideoClearButton = requireElement<HTMLButtonElement>("bg-video-clear-button");

  // Optional background image/video, mock-harness-only (req: "a background
  // screenshot or video for alignment testing") — never present in
  // viewer.html/production; Twitch itself supplies the video there.
  let uploadedObjectUrl: string | null = null;
  let videoObjectUrl: string | null = null;

  bgFileInput.addEventListener("change", () => {
    const file = bgFileInput.files?.[0];
    if (!file) return;
    if (uploadedObjectUrl) URL.revokeObjectURL(uploadedObjectUrl);
    uploadedObjectUrl = URL.createObjectURL(file);
    bgImage.src = uploadedObjectUrl;
    bgImage.classList.add("loaded");
    bgVideo.classList.remove("loaded");
    bgVideo.pause();
  });
  bgClearButton.addEventListener("click", () => {
    bgFileInput.value = "";
    if (uploadedObjectUrl) {
      URL.revokeObjectURL(uploadedObjectUrl);
      uploadedObjectUrl = null;
    }
    bgImage.removeAttribute("src");
    bgImage.classList.remove("loaded");
  });
  bgVideoFileInput.addEventListener("change", () => {
    const file = bgVideoFileInput.files?.[0];
    if (!file) return;
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = URL.createObjectURL(file);
    bgVideo.src = videoObjectUrl;
    bgVideo.classList.add("loaded");
    bgImage.classList.remove("loaded");
    bgVideo.play().catch(() => {});
  });
  bgVideoClearButton.addEventListener("click", () => {
    bgVideoFileInput.value = "";
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
      videoObjectUrl = null;
    }
    bgVideo.removeAttribute("src");
    bgVideo.classList.remove("loaded");
  });

  toggleOutlines.addEventListener("change", () => {
    debugOutlines = toggleOutlines.checked;
    renderHitboxes();
  });

  function currentDelayFromInput(): number {
    const parsed = Number.parseInt(delayInput.value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  function setDelay(ms: number): void {
    delayMs = ms;
    delayInput.value = String(ms);
    delayedLiveTick(); // takes effect immediately, no reload needed
  }
  delayInput.addEventListener("change", () => setDelay(currentDelayFromInput()));
  Array.from(document.querySelectorAll<HTMLButtonElement>("[data-delay-preset]")).forEach((button) => {
    button.addEventListener("click", () => setDelay(Number(button.dataset["delayPreset"] ?? "0")));
  });

  function setStatus(status: MockConnectionStatus): void {
    statusDot.className = `status-dot ${status}`;
    statusText.textContent = status;
  }

  const source = new MockOverlayStateSource(getConfiguredRelayUrl(true), setStatus);
  source.subscribe((state) => stateBuffer.push(state.capturedAt, state));

  function connectToChannel(channelId: string): void {
    source.disconnect();
    stateBuffer.clear();
    source.connect({ channelId, authToken: "mock-token", mode: "viewer" });
  }

  channelInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    connectToChannel(channelInput.value.trim() || "local-debug");
  });

  connectToChannel(channelInput.value.trim() || "local-debug");
  modeStatus.textContent = "mock mode";
  startDelayedLiveTicking();
} else {
  // The real Twitch path (viewer.html). No dev panel, no channel text
  // input — the channel comes from auth.channelId, never from the URL.
  const authStatus = requireElement<HTMLElement>("auth-status");
  diagnosticsPanel = requireElement<HTMLElement>("diagnostics");

  function showAuthPending(message: string): void {
    authStatus.textContent = message;
    authStatus.style.display = "block";
  }
  function hideAuthPending(): void {
    authStatus.style.display = "none";
  }

  showAuthPending("Waiting for Twitch authorization…");

  if (!window.Twitch?.ext) {
    // Should be unreachable in a real Twitch iframe (the Helper script
    // tag in viewer.html loads before this bundle) — this is the
    // dev-facing diagnostic for "Twitch authorization pending"/misconfigured
    // hosting the spec calls for, not a normal runtime path.
    showAuthPending("Twitch Extension Helper not found — this page must be loaded inside a Twitch extension iframe.");
  } else {
    const twitch = window.Twitch.ext;

    let source: TwitchOverlayStateSource | undefined;
    try {
      const relayUrl = getConfiguredRelayUrl(false);
      source = new TwitchOverlayStateSource(relayUrl, (status) => {
        if (status === "connecting") setDiagnosticStage(`Connecting to relay: ${relayUrl}`);
        else if (status === "connected") setDiagnosticStage(`Relay connected — twitch-subscribe sent to ${relayUrl}`);
        else if (status === "disconnected") setDiagnosticStage(`Relay disconnected — reconnecting to ${relayUrl}...`);
      });
    } catch (err) {
      // RIFTSIGHT_RELAY_URL missing/insecure for this build — fail fast
      // with a visible diagnostic rather than silently doing nothing (or
      // crashing the whole script on an uncaught throw).
      showAuthPending(err instanceof Error ? err.message : "Failed to configure the relay connection.");
    }

    if (source) {
      const twitchSource = source;
      twitchSource.subscribe((state) => stateBuffer.push(state.capturedAt, state));

      let authorized = false;

      twitch.onAuthorized((auth) => {
        if (!authorized) {
          // First-ever authorization for this session: connect and start
          // rendering. A later call (JWT refresh) only needs the token
          // retained for the next reconnect attempt, not a fresh connect —
          // tearing down a healthy connection on every routine refresh
          // would be pure churn.
          authorized = true;
          hideAuthPending();
          setDiagnosticStage(`Authorized for channel ${auth.channelId}`);
          applyConfig(parseOverlayConfig(twitch.configuration.broadcaster?.content));
          twitchSource.connect(buildPlatformContext(auth));
          startDelayedLiveTicking();
        } else {
          twitchSource.updateToken(auth.token);
        }
      });

      // "changing delay must not require reloading the Twitch iframe" —
      // the broadcaster can change any of these mid-stream via
      // config.html and every open viewer picks it up here without a
      // page reload.
      twitch.configuration.onChanged(() => {
        applyConfig(parseOverlayConfig(twitch.configuration.broadcaster?.content));
      });

      // Layout-mode changes (fullscreen/theater/normal, controls
      // visibility) are exactly when the source/rendered aspect ratio is
      // most likely to have actually drifted — hitboxes themselves need
      // no repositioning logic here (see the resize listener above), but
      // re-running the mismatch check on every reported context change
      // catches drift a plain window "resize" event might miss (e.g.
      // controls overlay toggling without the iframe's own box size
      // changing).
      twitch.onContext((_context, changedProperties) => {
        console.log("[twitch-extension] Twitch context changed", changedProperties);
        checkAspectRatioMismatch();
      });

      twitch.onError((error) => {
        console.warn("[twitch-extension] Twitch Helper reported an error", error);
        if (!authorized) showAuthPending("Twitch authorization failed — see console for details.");
      });
    }
  }
}
