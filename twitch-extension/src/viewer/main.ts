// Twitch video-overlay entry point. This same file drives both the real
// Twitch-hosted page (viewer.html, loads the real Twitch Extension
// Helper) and this repo's local mock harness (index.html, which sets
// window.__RIFTSIGHT_MOCK__ before this script loads) — per the milestone
// spec's requirement that mock mode run "the same UI code used inside
// Twitch". Only the OverlayStateSource implementation and the dev-only
// chrome differ between the two.
//
// The hover-resolution + popup-rendering loop itself now lives in
// overlay-core's CardHoverOverlay (shared verbatim with the riftsight.gg
// website demo, so the two can't drift). This file's job is the
// Twitch/relay-specific part: authenticating, receiving OverlayState over
// the relay, buffering it for delayed-live, and feeding cards/config into
// the controller. The controller never touches window.Twitch, the relay,
// or the buffer.
import {
  CardHoverOverlay,
  FULL_FRAME_SOURCE_REGION,
  delayedLiveTarget,
  isWaitingForHistory,
  type SourceRegion,
} from "@riftsight/overlay-core";
import { TimeWindowBuffer, type OverlayState } from "@riftsight/protocol";
import { MAX_DELAY_MS, parseOverlayConfig, type OverlayConfig } from "@riftsight/overlay-core";
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

// The shared hover/preview controller — the exact loop the website demo
// also drives. main.ts only feeds it cards (applyState) and broadcaster
// config (applyConfig) and lets it own all geometry/popup rendering. Mouse
// hover is wired here (document-level, so nothing intercepts the Twitch
// video's own pointer events — #overlay-stage stays pointer-events: none).
const overlay = new CardHoverOverlay({ stage, tooltip });
overlay.attachMouseHover();

// Every incoming state is buffered regardless of delay (a delay of 0ms is
// just "no meaningful lag" through the same pipeline, not a separate
// code path) — mirrors debug-viewer's delayed-live wiring exactly, reusing
// the same overlay-core calculators.
//
// Retention is explicitly sized to MAX_DELAY_MS (the broadcaster's own
// configurable ceiling) plus a margin, rather than TimeWindowBuffer's
// 60s default — a real incident: the default silently fell short of a
// delay a broadcaster could actually configure, leaving a blank overlay
// with no error once a delayed lookup asked for history the buffer had
// already pruned. The margin absorbs normal tick/timing slack right at
// the boundary rather than pruning an entry the very moment it's needed.
// maxEntries is raised well past its own 1000 default too — at this
// retention window, a worst-case actively-changing board could otherwise
// hit the entry-count cap before the time-based one, silently giving less
// retention than MAX_DELAY_MS actually promises.
const BUFFER_RETENTION_MARGIN_MS = 30_000;
const BUFFER_MAX_ENTRIES = 2000;
const stateBuffer = new TimeWindowBuffer<OverlayState>(MAX_DELAY_MS + BUFFER_RETENTION_MARGIN_MS, BUFFER_MAX_ENTRIES);
const bufferStartedAt = Date.now();
const DELAYED_LIVE_TICK_MS = 200;

let delayMs = 0;
let debugOutlines = false; // retained here only for checkAspectRatioMismatch's debug-gated logging (the controller owns its own copy)
let sourceAspectRatioOverride: number | undefined; // broadcaster-set override for checkAspectRatioMismatch, when set
let sourceRegion: SourceRegion = FULL_FRAME_SOURCE_REGION; // retained here only for checkAspectRatioMismatch's rendered-ratio math
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
  overlay.setCards(state ? state.cards : [], state?.blockingRegion);
  if (state) lastSourceViewport = state.sourceViewport;
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
  delayMs = config.delayMs;
  debugOutlines = config.debugOutlines;
  sourceAspectRatioOverride = config.sourceAspectRatio;
  sourceRegion = config.sourceRegion;
  overlay.setConfig({
    overlayEnabled: config.overlayEnabled,
    debugOutlines: config.debugOutlines,
    sourceRegion: config.sourceRegion,
    tooltipScale: config.tooltipScale,
  });
  delayedLiveTick(); // re-selects state under the new delay; applyState only re-renders if the *selected state* changed
  checkAspectRatioMismatch();
  setDiagnosticStage(lastDiagnosticStage); // re-evaluates visibility now that debugOutlines may have just changed
}

// Hitboxes/popup are positioned in #overlay-stage's local pixel space
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
    overlay.setConfig({ debugOutlines });
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
