// Broadcaster configuration page entry point. Twitch only ever shows this
// to the broadcaster (and extension editors) for their own channel — that
// access restriction is enforced by Twitch's platform, not this code;
// normal viewers never load this page at all. Same mock/real branching
// convention as src/viewer/main.ts.
import {
  FULL_FRAME_SOURCE_REGION,
  SOURCE_REGION_PRESETS,
  computeHitboxStyle,
  hitboxClassName,
  isValidSourceRegion,
  mapBoundsToSourceRegion,
  type SourceRegion,
} from "@riftsight/overlay-core";
import type { OverlayCard } from "@riftsight/protocol";
import { MockOverlayStateSource } from "../platform/mock-state-source.js";
import { getConfiguredRelayUrl } from "../platform/relay-url.js";
import { buildPlatformContext } from "../platform/twitch-context.js";
import { TwitchOverlayStateSource } from "../platform/twitch-state-source.js";
import { DEFAULT_OVERLAY_CONFIG, OVERLAY_CONFIG_VERSION, parseOverlayConfig, serializeOverlayConfig, type OverlayConfig } from "./overlay-config.js";

const isMock = window.__RIFTSIGHT_MOCK__ === true;
const MOCK_STORAGE_KEY = "riftsight-mock-broadcaster-config";
// The mock config harness has no channel-id input of its own — it always
// previews against "local-debug", the same default the debug-viewer and
// twitch-extension's own mock harness (index.html) use, so publishing
// there while this page is open is enough to see live data with no extra
// setup.
const MOCK_PREVIEW_CHANNEL_ID = "local-debug";

// Shown until a live state arrives (or if none ever does) — one public,
// one hidden, so the preview also demonstrates that a hidden card's
// identity never leaks into the calibration UI (tooltipContentFor's
// existing guarantee, exercised here the same as in the real overlay).
const MOCK_PREVIEW_CARDS: OverlayCard[] = [
  {
    instanceId: "preview-card-1",
    cardId: "OGN-089",
    name: "Preview Card",
    zone: "battlefield",
    owner: "self",
    visibility: "public",
    bounds: { x: 0.3, y: 0.35, width: 0.12, height: 0.18 },
    rotation: 0,
    landscape: false,
  },
  {
    instanceId: "preview-card-2",
    zone: "hand",
    owner: "opponent",
    visibility: "hidden",
    bounds: { x: 0.62, y: 0.15, width: 0.08, height: 0.12 },
    rotation: 20,
    landscape: false,
  },
];

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const overlayEnabledInput = requireElement<HTMLInputElement>("overlay-enabled-input");
const delayInput = requireElement<HTMLInputElement>("delay-input");
const debugOutlinesInput = requireElement<HTMLInputElement>("debug-outlines-input");
const aspectRatioInput = requireElement<HTMLInputElement>("aspect-ratio-input");
const regionXInput = requireElement<HTMLInputElement>("region-x-input");
const regionYInput = requireElement<HTMLInputElement>("region-y-input");
const regionWidthInput = requireElement<HTMLInputElement>("region-width-input");
const regionHeightInput = requireElement<HTMLInputElement>("region-height-input");
const regionResetButton = requireElement<HTMLButtonElement>("region-reset-button");
const saveButton = requireElement<HTMLButtonElement>("save-button");
const statusText = requireElement<HTMLElement>("status-text");
const previewContainer = requireElement<HTMLElement>("calibration-preview");
const previewRegionBox = requireElement<HTMLElement>("calibration-region");
const previewResizeHandle = requireElement<HTMLElement>("calibration-resize-handle");
const previewHitboxLayer = requireElement<HTMLElement>("calibration-hitboxes");

// The numeric x/y/width/height inputs are the authoritative source of
// truth (the drag/resize preview below is layered on top of the same
// underlying state, per the spec's "must remain usable without
// drag/resize" requirement) — currentSourceRegion always holds the last
// *valid* region; an invalid manual edit reverts the inputs to it rather
// than saving something broken.
let currentSourceRegion: SourceRegion = FULL_FRAME_SOURCE_REGION;
let previewCards: OverlayCard[] = MOCK_PREVIEW_CARDS;

function applyRegionToInputs(region: SourceRegion): void {
  regionXInput.value = region.x.toFixed(3);
  regionYInput.value = region.y.toFixed(3);
  regionWidthInput.value = region.width.toFixed(3);
  regionHeightInput.value = region.height.toFixed(3);
}

function renderRegionBox(region: SourceRegion): void {
  previewRegionBox.style.left = `${region.x * 100}%`;
  previewRegionBox.style.top = `${region.y * 100}%`;
  previewRegionBox.style.width = `${region.width * 100}%`;
  previewRegionBox.style.height = `${region.height * 100}%`;
}

// Mirrors the real viewer's renderHitboxes() exactly (map bounds into the
// region, then the same computeHitboxStyle/hitboxClassName calls) so the
// preview is an honest representation of what viewers will actually see
// — not a separate, potentially-drifting reimplementation.
function renderPreviewHitboxes(): void {
  previewHitboxLayer.replaceChildren();
  for (const card of previewCards) {
    const mappedBounds = mapBoundsToSourceRegion(card.bounds, currentSourceRegion);
    const style = computeHitboxStyle({ ...card, bounds: mappedBounds });
    const box = document.createElement("div");
    box.className = `${hitboxClassName(card)} ${debugOutlinesInput.checked ? "debug-outline" : ""}`.trim();
    box.style.left = style.left;
    box.style.top = style.top;
    box.style.width = style.width;
    box.style.height = style.height;
    box.style.zIndex = style.zIndex;
    previewHitboxLayer.appendChild(box);
  }
}

function setSourceRegion(region: SourceRegion): void {
  if (!isValidSourceRegion(region)) {
    statusText.textContent = "Invalid source region (must stay within the frame) — reverted to the last valid value.";
    applyRegionToInputs(currentSourceRegion);
    return;
  }
  currentSourceRegion = region;
  applyRegionToInputs(region);
  renderRegionBox(region);
  renderPreviewHitboxes();
}

// Dragging/resizing produces a continuous stream of candidate regions as
// the mouse moves — clamping (rather than setSourceRegion's usual
// revert-to-last-valid) keeps the gesture smooth instead of the box
// refusing to move the instant it grazes an edge. The clamped result is
// always valid by construction, so it never actually hits the revert
// path in setSourceRegion.
function clampSourceRegion(region: SourceRegion): SourceRegion {
  const width = Math.min(Math.max(region.width, 0.02), 1);
  const height = Math.min(Math.max(region.height, 0.02), 1);
  const x = Math.min(Math.max(region.x, 0), 1 - width);
  const y = Math.min(Math.max(region.y, 0), 1 - height);
  return { x, y, width, height };
}

interface DragState {
  startClientX: number;
  startClientY: number;
  startRegion: SourceRegion;
}
let moveState: DragState | null = null;
let resizeState: DragState | null = null;

previewRegionBox.addEventListener("mousedown", (event) => {
  if (event.target === previewResizeHandle) return; // the resize handler owns this
  event.preventDefault();
  moveState = { startClientX: event.clientX, startClientY: event.clientY, startRegion: currentSourceRegion };
});

previewResizeHandle.addEventListener("mousedown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  resizeState = { startClientX: event.clientX, startClientY: event.clientY, startRegion: currentSourceRegion };
});

window.addEventListener("mousemove", (event) => {
  if (!moveState && !resizeState) return;
  const rect = previewContainer.getBoundingClientRect();

  if (moveState) {
    const dx = (event.clientX - moveState.startClientX) / rect.width;
    const dy = (event.clientY - moveState.startClientY) / rect.height;
    setSourceRegion(
      clampSourceRegion({
        x: moveState.startRegion.x + dx,
        y: moveState.startRegion.y + dy,
        width: moveState.startRegion.width,
        height: moveState.startRegion.height,
      })
    );
  } else if (resizeState) {
    const dx = (event.clientX - resizeState.startClientX) / rect.width;
    const dy = (event.clientY - resizeState.startClientY) / rect.height;
    setSourceRegion(
      clampSourceRegion({
        x: resizeState.startRegion.x,
        y: resizeState.startRegion.y,
        width: resizeState.startRegion.width + dx,
        height: resizeState.startRegion.height + dy,
      })
    );
  }
});

window.addEventListener("mouseup", () => {
  moveState = null;
  resizeState = null;
});

debugOutlinesInput.addEventListener("change", renderPreviewHitboxes);

function readSourceRegionFromInputs(): SourceRegion {
  return {
    x: Number.parseFloat(regionXInput.value),
    y: Number.parseFloat(regionYInput.value),
    width: Number.parseFloat(regionWidthInput.value),
    height: Number.parseFloat(regionHeightInput.value),
  };
}

function applyToForm(config: OverlayConfig): void {
  overlayEnabledInput.checked = config.overlayEnabled;
  delayInput.value = String(config.delayMs);
  debugOutlinesInput.checked = config.debugOutlines;
  aspectRatioInput.value = config.sourceAspectRatio !== undefined ? String(config.sourceAspectRatio) : "";
  currentSourceRegion = config.sourceRegion;
  applyRegionToInputs(config.sourceRegion);
  renderRegionBox(config.sourceRegion);
  renderPreviewHitboxes();
}

function readFromForm(): OverlayConfig {
  const parsedAspectRatio = Number.parseFloat(aspectRatioInput.value);
  return {
    overlayEnabled: overlayEnabledInput.checked,
    delayMs: Math.max(0, Number.parseInt(delayInput.value, 10) || 0),
    debugOutlines: debugOutlinesInput.checked,
    sourceAspectRatio: Number.isFinite(parsedAspectRatio) && parsedAspectRatio > 0 ? parsedAspectRatio : undefined,
    sourceRegion: currentSourceRegion,
  };
}

Array.from(document.querySelectorAll<HTMLButtonElement>("[data-delay-preset]")).forEach((button) => {
  button.addEventListener("click", () => {
    delayInput.value = button.dataset["delayPreset"] ?? "0";
  });
});

[regionXInput, regionYInput, regionWidthInput, regionHeightInput].forEach((input) => {
  input.addEventListener("change", () => setSourceRegion(readSourceRegionFromInputs()));
});

regionResetButton.addEventListener("click", () => setSourceRegion(FULL_FRAME_SOURCE_REGION));

Array.from(document.querySelectorAll<HTMLButtonElement>("[data-region-preset]")).forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset["regionPreset"] as keyof typeof SOURCE_REGION_PRESETS | undefined;
    if (key && key in SOURCE_REGION_PRESETS) setSourceRegion(SOURCE_REGION_PRESETS[key]);
  });
});

if (isMock) {
  const stored = localStorage.getItem(MOCK_STORAGE_KEY) ?? undefined;
  applyToForm(parseOverlayConfig(stored));
  statusText.textContent = "mock mode — saved to localStorage, not Twitch";

  saveButton.addEventListener("click", () => {
    localStorage.setItem(MOCK_STORAGE_KEY, serializeOverlayConfig(readFromForm()));
    statusText.textContent = `saved to localStorage at ${new Date().toLocaleTimeString()}`;
  });

  // Read-only: this source only ever feeds the calibration preview, it
  // never publishes anything — "mode: config" distinguishes it from the
  // real overlay viewer's own subscription (same channel, two purposes).
  const previewSource = new MockOverlayStateSource(getConfiguredRelayUrl(true));
  previewSource.subscribe((state) => {
    previewCards = state.cards;
    renderPreviewHitboxes();
  });
  previewSource.connect({ channelId: MOCK_PREVIEW_CHANNEL_ID, authToken: "mock-token", mode: "config" });
} else {
  applyToForm(DEFAULT_OVERLAY_CONFIG);
  statusText.textContent = "Waiting for Twitch authorization…";
  saveButton.disabled = true;

  if (!window.Twitch?.ext) {
    statusText.textContent = "Twitch Extension Helper not found — this page must be loaded inside a Twitch extension iframe.";
  } else {
    const twitch = window.Twitch.ext;

    // The calibration preview is best-effort — if RIFTSIGHT_RELAY_URL
    // isn't configured for this build, the config page's actual job
    // (reading/saving overlayEnabled/delayMs/debugOutlines/sourceRegion/
    // sourceAspectRatio via Twitch's own configuration service) doesn't
    // need a relay connection at all, so a missing relay URL shouldn't
    // block it — just fall back to MOCK_PREVIEW_CARDS forever.
    let previewSource: TwitchOverlayStateSource | undefined;
    try {
      previewSource = new TwitchOverlayStateSource(getConfiguredRelayUrl(false));
      previewSource.subscribe((state) => {
        previewCards = state.cards;
        renderPreviewHitboxes();
      });
    } catch (err) {
      console.warn(
        "[twitch-extension] calibration preview unavailable (config saving still works):",
        err instanceof Error ? err.message : err
      );
    }

    // onAuthorized fires again on every routine JWT refresh (same as
    // viewer/main.ts) — connect the read-only preview source once, then
    // just keep its token current for any future reconnect rather than
    // opening a second, orphaned connection on every refresh.
    let authorized = false;
    twitch.onAuthorized((auth) => {
      saveButton.disabled = false;
      applyToForm(parseOverlayConfig(twitch.configuration.broadcaster?.content));
      statusText.textContent = "Ready.";
      if (!authorized) {
        authorized = true;
        previewSource?.connect(buildPlatformContext(auth, "config"));
      } else {
        previewSource?.updateToken(auth.token);
      }
    });

    twitch.onError((error) => {
      console.warn("[twitch-extension] Twitch Helper reported an error", error);
      statusText.textContent = "Twitch authorization failed — see console for details.";
    });

    saveButton.addEventListener("click", () => {
      twitch.configuration.set("broadcaster", OVERLAY_CONFIG_VERSION, serializeOverlayConfig(readFromForm()));
      statusText.textContent = `saved at ${new Date().toLocaleTimeString()}`;
    });
  }
}
