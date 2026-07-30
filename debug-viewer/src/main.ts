// Thin DOM glue — the interesting logic (geometry mapping, tooltip
// content) lives in render.ts/tooltip.ts, which are unit-tested. This file
// just wires those pure functions to the page.

import {
  DEFAULT_SESSION_ID,
  findStateAtOrBefore,
  TimeWindowBuffer,
  type OverlayCard,
  type OverlayRecording,
  type OverlayState,
  type TimestampedState,
} from "@riftsight/protocol";
import {
  computeHitboxStyle,
  computeTooltipPosition,
  delayedLiveTarget,
  hitboxClassName,
  hitboxLabel,
  isWaitingForHistory,
  playbackTarget,
  recordingPlaybackStatus,
  tooltipContentFor,
  type ViewerMode,
} from "@riftsight/overlay-core";
import { setupRecordingControls } from "./recording-controls.js";
import { connectViewer, type ConnectionStatus } from "./ws-client.js";

// Every live state is buffered regardless of the active viewer mode, so
// switching modes doesn't require reaccumulating history. Default ~60s
// retention per the milestone spec.
const stateBuffer = new TimeWindowBuffer<OverlayState>();

// When THIS viewer session started collecting — used by isWaitingForHistory
// to require actually elapsed collection time, not just "does the buffer
// happen to contain an old-enough sample" (a stale single retained state
// from a reconnect would otherwise satisfy that trivially). Deliberately
// captured once at load, not reset on mode switches — reloading the page
// is the only thing that resets collection.
const bufferStartedAt = Date.now();

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in debug-viewer/index.html`);
  return el as unknown as T;
}

const statusDot = requireElement<HTMLElement>("status-dot");
const statusText = requireElement<HTMLElement>("status-text");
const sequenceText = requireElement<HTMLElement>("sequence-text");
const capturedText = requireElement<HTMLElement>("captured-text");
const sessionInput = requireElement<HTMLInputElement>("session-input");
const stage = requireElement<HTMLElement>("stage");
const bgImage = requireElement<HTMLImageElement>("bg");
const bgFileInput = requireElement<HTMLInputElement>("bg-file-input");
const bgClearButton = requireElement<HTMLButtonElement>("bg-clear-button");
const bgVideo = requireElement<HTMLVideoElement>("bg-video");
const bgVideoFileInput = requireElement<HTMLInputElement>("bg-video-file-input");
const bgVideoClearButton = requireElement<HTMLButtonElement>("bg-video-clear-button");
const bgWarning = requireElement<HTMLElement>("bg-warning");
const hitboxLayer = requireElement<HTMLElement>("hitboxes");
const tooltip = requireElement<HTMLElement>("tooltip");
const toggleOutlines = requireElement<HTMLInputElement>("toggle-outlines");
const toggleLabels = requireElement<HTMLInputElement>("toggle-labels");
const modeSelect = requireElement<HTMLSelectElement>("mode-select");
const delayControls = requireElement<HTMLElement>("delay-controls");
const delayInput = requireElement<HTMLInputElement>("delay-input");
const modeStatusText = requireElement<HTMLElement>("mode-status");
const stateAgeText = requireElement<HTMLElement>("state-age-text");
const bufferStatusText = requireElement<HTMLElement>("buffer-status-text");
const syncControls = requireElement<HTMLElement>("sync-controls");
const syncOffsetInput = requireElement<HTMLInputElement>("sync-offset-input");
const videoTimeText = requireElement<HTMLElement>("video-time-text");
const stateOffsetText = requireElement<HTMLElement>("state-offset-text");
const offsetDiffText = requireElement<HTMLElement>("offset-diff-text");

// Recording controls own their own OverlayRecorder instance; loadedRecording
// (metadata) and loadedRecordingStates (the same states, pre-mapped into the
// {time, value} shape findStateAtOrBefore expects, keyed by offsetMs rather
// than remapping on every lookup) are populated by the import callback and
// consumed by recording-playback mode below.
let loadedRecording: OverlayRecording | undefined;
let loadedRecordingStates: TimestampedState<OverlayState>[] | undefined;

const recordingControls = setupRecordingControls(
  {
    startButton: requireElement<HTMLButtonElement>("recording-start-button"),
    stopButton: requireElement<HTMLButtonElement>("recording-stop-button"),
    clearButton: requireElement<HTMLButtonElement>("recording-clear-button"),
    exportButton: requireElement<HTMLButtonElement>("recording-export-button"),
    importInput: requireElement<HTMLInputElement>("recording-import-input"),
    statusText: requireElement<HTMLElement>("recording-status-text"),
  },
  (recording) => {
    loadedRecording = recording;
    loadedRecordingStates = recording.states.map((s) => ({ time: s.offsetMs, value: s.state }));
  }
);

const params = new URLSearchParams(location.search);
const sessionId = params.get("session") || DEFAULT_SESSION_ID;
sessionInput.value = sessionId;

// Changing the session id navigates to a fresh URL with ?session=... rather
// than tearing down/rebuilding the live connection in place — simplest
// correct behavior for a debug tool.
sessionInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const next = sessionInput.value.trim() || DEFAULT_SESSION_ID;
  const url = new URL(location.href);
  url.searchParams.set("session", next);
  location.href = url.toString();
});

// --- Background: image or video, both optional, mutually exclusive
// (whichever was most recently loaded successfully is what's shown).
// Neither is required — #stage's CSS default (aspect-ratio: 16/9 + a
// CSS-only board pattern, see index.html) is what renders whenever
// nothing is loaded, so the stage is never blank/collapsed and never
// shows a broken-image icon.
//
// Default fixture path, if you want to use one: drop a full, uncropped
// screenshot of the RiftAtlas viewport at this path relative to
// debug-viewer/index.html. Entirely optional — the fallback board renders
// fine without it, and "Clear" always returns to that fallback rather than
// retrying this path.
const DEFAULT_FIXTURE_PATH = "public/fixtures/riftatlas-game.png";

let uploadedObjectUrl: string | null = null;
let videoObjectUrl: string | null = null;

function showBgWarning(message: string): void {
  bgWarning.textContent = message;
  bgWarning.classList.add("visible");
}

function hideBgWarning(): void {
  bgWarning.classList.remove("visible");
}

function revokeUploadedObjectUrl(): void {
  if (uploadedObjectUrl) {
    URL.revokeObjectURL(uploadedObjectUrl);
    uploadedObjectUrl = null;
  }
}

function revokeVideoObjectUrl(): void {
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = null;
  }
}

function deactivateVideo(): void {
  bgVideo.classList.remove("loaded");
  bgVideo.pause();
}

function deactivateImage(): void {
  bgImage.classList.remove("loaded");
}

// Set src via JS (not a static HTML attribute) so these listeners are
// guaranteed attached before the request can resolve — avoids any race
// where a fast/cached load fires before we're listening.
bgImage.addEventListener("load", () => {
  deactivateVideo(); // mutually exclusive — this image is now the active background
  bgImage.classList.add("loaded");
  hideBgWarning();
  if (bgImage.naturalWidth > 0 && bgImage.naturalHeight > 0) {
    stage.style.aspectRatio = `${bgImage.naturalWidth} / ${bgImage.naturalHeight}`;
  }
});

bgImage.addEventListener("error", () => {
  bgImage.classList.remove("loaded");
  // Only reset to the fallback aspect ratio if nothing else is currently
  // the active background — if a video is still showing, this failed
  // image load must not yank the stage's shape out from under it.
  const videoStillActive = bgVideo.classList.contains("loaded");
  if (!videoStillActive) stage.style.aspectRatio = "16 / 9";
  // Only worth mentioning when it was a real attempt (the default fixture,
  // or a since-revoked upload) — not on the initial empty src.
  if (bgImage.getAttribute("src")) {
    const fallbackDescription = videoStillActive ? "keeping the current video background" : "showing fallback board";
    showBgWarning(
      bgImage.src.startsWith("blob:")
        ? `Uploaded screenshot failed to load — ${fallbackDescription}.`
        : `No fixture screenshot found at ${DEFAULT_FIXTURE_PATH} — ${fallbackDescription}. Upload one above, or see the README.`
    );
  }
});

bgImage.src = DEFAULT_FIXTURE_PATH;

bgFileInput.addEventListener("change", () => {
  const file = bgFileInput.files?.[0];
  if (!file) return;
  revokeUploadedObjectUrl();
  uploadedObjectUrl = URL.createObjectURL(file);
  hideBgWarning();
  bgImage.src = uploadedObjectUrl;
});

bgClearButton.addEventListener("click", () => {
  bgFileInput.value = "";
  revokeUploadedObjectUrl();
  bgImage.removeAttribute("src");
  deactivateImage();
  stage.style.aspectRatio = "16 / 9";
  hideBgWarning();
});

// Video: same object-URL/mutual-exclusion pattern as the image above.
// Play/pause/seek/rate all come for free from the native <video controls>
// element — no custom playback UI needed.
bgVideo.addEventListener("loadedmetadata", () => {
  deactivateImage(); // mutually exclusive — this video is now the active background
  bgVideo.classList.add("loaded");
  hideBgWarning();
  if (bgVideo.videoWidth > 0 && bgVideo.videoHeight > 0) {
    stage.style.aspectRatio = `${bgVideo.videoWidth} / ${bgVideo.videoHeight}`;
  }
});

bgVideo.addEventListener("error", () => {
  deactivateVideo();
  // Same symmetry as the image error handler: don't reset the stage's
  // shape if an image is still the active background.
  const imageStillActive = bgImage.classList.contains("loaded");
  if (!imageStillActive) stage.style.aspectRatio = "16 / 9";
  if (bgVideo.getAttribute("src")) {
    showBgWarning(
      `Uploaded video failed to load — ${imageStillActive ? "keeping the current screenshot background" : "showing fallback board"}.`
    );
  }
});

bgVideoFileInput.addEventListener("change", () => {
  const file = bgVideoFileInput.files?.[0];
  if (!file) return;
  revokeVideoObjectUrl();
  videoObjectUrl = URL.createObjectURL(file);
  hideBgWarning();
  bgVideo.src = videoObjectUrl;
});

bgVideoClearButton.addEventListener("click", () => {
  bgVideoFileInput.value = "";
  revokeVideoObjectUrl();
  bgVideo.removeAttribute("src");
  deactivateVideo();
  stage.style.aspectRatio = "16 / 9";
  hideBgWarning();
});

// recording-playback driver: timeupdate (fires continuously during
// playback, and stops firing while paused — so "pausing preserves the
// current overlay" needs no special handling) plus seeked (so a seek
// while paused still updates immediately). Deliberately not
// requestAnimationFrame — there's no per-frame animation happening here,
// and the spec asks to avoid excessive rerenders; timeupdate's coarser
// native rate is sufficient for this non-frame-perfect prototype. Gated
// to recording-playback so previewing a video in another mode doesn't
// stomp on what that mode is actually supposed to be showing.
bgVideo.addEventListener("timeupdate", () => {
  if (mode === "recording-playback") recordingPlaybackTick();
});
bgVideo.addEventListener("seeked", () => {
  if (mode === "recording-playback") recordingPlaybackTick();
});

function setStatus(status: ConnectionStatus): void {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = status;
}

let latestCards: OverlayCard[] = [];

// Anchored to the hovered hitbox's own rect rather than following the
// cursor — measured after content/display are set so tooltip.offsetWidth/
// Height reflect what's actually about to be shown (an image changes the
// tooltip's size a lot compared to text-only).
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

// Full rebuild per state, matching the milestone's "full snapshots over a
// complex diff protocol" preference — states are already deduped upstream
// (OverlayStatePublisher), so this won't thrash in practice.
function renderHitboxes(): void {
  hitboxLayer.replaceChildren();
  if (!toggleOutlines.checked) return;

  for (const card of latestCards) {
    const box = document.createElement("div");
    box.className = hitboxClassName(card);

    const style = computeHitboxStyle(card);
    box.style.left = style.left;
    box.style.top = style.top;
    box.style.width = style.width;
    box.style.height = style.height;
    box.style.transform = style.transform;
    box.style.zIndex = style.zIndex;

    if (toggleLabels.checked) {
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = hitboxLabel(card);
      box.appendChild(label);
    }

    box.addEventListener("mouseenter", () => {
      const content = tooltipContentFor(card);
      tooltip.replaceChildren();
      if (content.imageUrl) {
        const img = document.createElement("img");
        img.src = content.imageUrl;
        img.alt = "";
        img.className = "tooltip-art";
        tooltip.appendChild(img);
      }
      const text = document.createElement("div");
      text.textContent = content.lines.join("\n");
      tooltip.appendChild(text);
      tooltip.style.display = "block";
      positionTooltipNear(box);
    });
    box.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
    });

    hitboxLayer.appendChild(box);
  }
}

toggleOutlines.addEventListener("change", renderHitboxes);
toggleLabels.addEventListener("change", renderHitboxes);

// --- Viewer modes ------------------------------------------------------
// All three modes funnel through applyState(): "live" just calls it
// directly with whatever arrived; "delayed-live" calls it from a timer
// tick with whatever the buffer says was current `delayMs` ago;
// "recording-playback" (a later step) will call it from video time
// events. applyState dedupes on state identity so re-selecting the same
// snapshot repeatedly (e.g. every delayed-live tick between real changes)
// doesn't re-render or re-log.

let mode: ViewerMode = "live";
let delayMs = 0;
let syncOffsetMs = 0; // recording-playback only; UI controls for this land in a later step
let displayedState: OverlayState | undefined;
let lastLiveState: OverlayState | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const DELAYED_LIVE_TICK_MS = 200;

function applyState(state: OverlayState | undefined, renderedAt: number): void {
  if (state === displayedState) return; // no meaningful change — skip render + log
  displayedState = state;

  latestCards = state ? state.cards : [];
  sequenceText.textContent = state ? String(state.sequence) : "-";
  capturedText.textContent = state ? new Date(state.capturedAt).toLocaleTimeString() : "-";
  renderHitboxes();

  console.log(`[viewer] selected state changed (${mode}) -> ${state ? `seq=${state.sequence}` : "none"}`);
  refreshDiagnostics(renderedAt);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function refreshDiagnostics(renderedAt: number): void {
  bufferStatusText.textContent =
    stateBuffer.size > 0
      ? `${stateBuffer.size} state(s), spanning ${formatMs((stateBuffer.latestTime ?? renderedAt) - (stateBuffer.earliestTime ?? renderedAt))}`
      : "empty";

  if (mode === "delayed-live") {
    const waiting = isWaitingForHistory(bufferStartedAt, delayMs, renderedAt);
    modeStatusText.textContent = waiting ? "waiting for history" : "synchronized";
    modeStatusText.className = waiting ? "waiting" : "synchronized";
    stateAgeText.textContent = displayedState ? formatMs(renderedAt - displayedState.capturedAt) : "-";
  } else if (mode === "live") {
    modeStatusText.textContent = "live";
    modeStatusText.className = "live";
    stateAgeText.textContent = displayedState ? formatMs(renderedAt - displayedState.capturedAt) : "-";
  } else {
    // recording-playback
    const first = loadedRecordingStates?.[0];
    const last = loadedRecordingStates?.[loadedRecordingStates.length - 1];
    const targetOffsetMs = playbackTarget(bgVideo.currentTime, syncOffsetMs);
    const status = recordingPlaybackStatus(targetOffsetMs, first?.time, last?.time);

    const statusLabel: Record<typeof status, string> = {
      "no-recording": "no recording loaded",
      "before-start": "before first recorded state",
      synchronized: "synchronized",
      "past-end": "past end of recording (holding last state)",
    };
    modeStatusText.textContent = statusLabel[status];
    modeStatusText.className = status === "synchronized" ? "synchronized" : status === "before-start" ? "waiting" : "";
    stateAgeText.textContent = "-"; // not meaningful here — see the sync-controls readout below instead

    // The manual alignment workflow: seek the video to a known action,
    // find the matching recorded state, adjust sync offset until these
    // three numbers line up the way you expect.
    videoTimeText.textContent = formatMs(bgVideo.currentTime * 1000);
    const selectedOffsetMs = loadedRecordingStates?.find((s) => s.value === displayedState)?.time;
    stateOffsetText.textContent = selectedOffsetMs !== undefined ? formatMs(selectedOffsetMs) : "-";
    offsetDiffText.textContent = selectedOffsetMs !== undefined ? `Δ${formatMs(targetOffsetMs - selectedOffsetMs)}` : "-";
  }
}

function delayedLiveTick(): void {
  const now = Date.now();
  const targetTime = delayedLiveTarget(now, delayMs);
  const waiting = isWaitingForHistory(bufferStartedAt, delayMs, now);
  applyState(waiting ? undefined : stateBuffer.findAtOrBefore(targetTime)?.value, now);
  refreshDiagnostics(now); // buffer stats/age should stay live even between selection changes
}

function recordingPlaybackTick(): void {
  const now = Date.now();
  const first = loadedRecordingStates?.[0];
  const last = loadedRecordingStates?.[loadedRecordingStates.length - 1];
  const targetOffsetMs = playbackTarget(bgVideo.currentTime, syncOffsetMs);
  const status = recordingPlaybackStatus(targetOffsetMs, first?.time, last?.time);

  const selected =
    status === "no-recording" || status === "before-start" || !loadedRecordingStates
      ? undefined
      : findStateAtOrBefore(loadedRecordingStates, targetOffsetMs)?.value;

  applyState(selected, now);
  refreshDiagnostics(now);
}

function stopTicking(): void {
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

function setMode(next: ViewerMode): void {
  if (next === mode) return;
  mode = next;
  console.log(`[viewer] mode changed -> ${mode}`);
  stopTicking();
  delayControls.style.display = mode === "delayed-live" ? "flex" : "none";
  syncControls.style.display = mode === "recording-playback" ? "flex" : "none";

  if (mode === "live") {
    applyState(lastLiveState, Date.now());
  } else if (mode === "delayed-live") {
    tickTimer = setInterval(delayedLiveTick, DELAYED_LIVE_TICK_MS);
    delayedLiveTick(); // immediate feedback rather than waiting for the first tick
  } else {
    recordingPlaybackTick(); // immediate feedback; further updates come from video timeupdate/seeked
  }

  refreshDiagnostics(Date.now());
}

function currentDelayFromInput(): number {
  const parsed = Number.parseInt(delayInput.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function setDelay(ms: number): void {
  delayMs = ms;
  delayInput.value = String(ms);
  console.log(`[viewer] delay changed -> ${ms}ms`);
  if (mode === "delayed-live") delayedLiveTick(); // take effect immediately, no reload needed
}

function setSyncOffset(ms: number): void {
  syncOffsetMs = ms;
  syncOffsetInput.value = String(ms);
  console.log(`[viewer] sync offset changed -> ${ms}ms`);
  if (mode === "recording-playback") recordingPlaybackTick(); // take effect immediately, no reload needed
}

modeSelect.addEventListener("change", () => setMode(modeSelect.value as ViewerMode));
delayInput.addEventListener("change", () => setDelay(currentDelayFromInput()));
Array.from(document.querySelectorAll<HTMLButtonElement>("[data-delay-preset]")).forEach((button) => {
  button.addEventListener("click", () => setDelay(Number(button.dataset["delayPreset"] ?? "0")));
});

syncOffsetInput.addEventListener("change", () => {
  const parsed = Number.parseInt(syncOffsetInput.value, 10);
  setSyncOffset(Number.isFinite(parsed) ? parsed : 0);
});
Array.from(document.querySelectorAll<HTMLButtonElement>("[data-sync-step]")).forEach((button) => {
  button.addEventListener("click", () => setSyncOffset(syncOffsetMs + Number(button.dataset["syncStep"] ?? "0")));
});

connectViewer({
  sessionId,
  onStatusChange: setStatus,
  onState: (state: OverlayState) => {
    stateBuffer.push(state.capturedAt, state);
    recordingControls.recordIfActive(state);
    lastLiveState = state;
    if (mode === "live") applyState(state, Date.now());
    else refreshDiagnostics(Date.now()); // keep buffer/age readouts current even off the live path
  },
});
