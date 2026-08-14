// The broadcaster calibration page (opened from the popup) — the
// non-Twitch counterpart of twitch-extension's config.html, persisting to
// chrome.storage.local (riftsight.overlayConfig) instead of Twitch's
// configuration service. The background attaches the saved config to every
// published state (see background.ts's withOverlayConfig), so saving here
// reaches viewers on the streamer's next board update with no further
// plumbing.
//
// The region editor is a deliberate port of config.html's: same
// applyEdgeDrag/handle scheme (hoisted to overlay-core precisely so the
// two pages share it), same presets, same live-hitbox preview idea — fed
// here by the extension's own last-published state via a background
// message rather than a relay subscription.

import {
  DEFAULT_OVERLAY_CONFIG,
  MAX_DELAY_MS,
  MAX_TOOLTIP_SCALE,
  MIN_TOOLTIP_SCALE,
  SOURCE_REGION_PRESETS,
  applyEdgeDrag,
  computeHitboxStyle,
  describeTooltipScale,
  isValidSourceRegion,
  mapBoundsToSourceRegion,
  mapSizeToSourceRegion,
  matchRegionPreset,
  parseOverlayConfig,
  serializeOverlayConfig,
  type OverlayConfig,
  type RegionEdge,
  type SourceRegion,
} from "@riftsight/overlay-core";
import type { OverlayState } from "@riftsight/protocol";
import { safeSendMessage } from "../shared/messaging.js";

const STORAGE_KEY_OVERLAY_CONFIG = "riftsight.overlayConfig";
const LIVE_PREVIEW_POLL_MS = 2_000;

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const previewBox = requireElement<HTMLDivElement>("region-preview");
const regionRect = requireElement<HTMLDivElement>("region-rect");
const inputX = requireElement<HTMLInputElement>("region-x");
const inputY = requireElement<HTMLInputElement>("region-y");
const inputW = requireElement<HTMLInputElement>("region-w");
const inputH = requireElement<HTMLInputElement>("region-h");
const presetRow = requireElement<HTMLDivElement>("preset-row");
const liveHint = requireElement<HTMLSpanElement>("live-hint");
const tooltipScaleSlider = requireElement<HTMLInputElement>("tooltip-scale");
const tooltipScaleLabel = requireElement<HTMLSpanElement>("tooltip-scale-label");
const delaySecondsInput = requireElement<HTMLInputElement>("delay-seconds");
const overlayEnabledCheckbox = requireElement<HTMLInputElement>("overlay-enabled");
const saveButton = requireElement<HTMLButtonElement>("save-button");
const saveStatus = requireElement<HTMLSpanElement>("save-status");

let config: OverlayConfig = DEFAULT_OVERLAY_CONFIG;
let lastLiveState: OverlayState | undefined;

// ---------------------------------------------------------------- region UI

function setSourceRegion(region: SourceRegion): void {
  if (!isValidSourceRegion(region)) return;
  config = { ...config, sourceRegion: region };
  renderRegion();
}

function renderRegion(): void {
  const { x, y, width, height } = config.sourceRegion;
  regionRect.style.left = `${x * 100}%`;
  regionRect.style.top = `${y * 100}%`;
  regionRect.style.width = `${width * 100}%`;
  regionRect.style.height = `${height * 100}%`;
  inputX.value = x.toFixed(3);
  inputY.value = y.toFixed(3);
  inputW.value = width.toFixed(3);
  inputH.value = height.toFixed(3);

  const matched = matchRegionPreset(config.sourceRegion, SOURCE_REGION_PRESETS);
  for (const button of Array.from(presetRow.querySelectorAll<HTMLButtonElement>("button[data-preset]"))) {
    button.setAttribute("aria-pressed", String(button.dataset["preset"] === matched));
  }
  renderLivePreview();
}

/** Move = translate with clamping (deliberately NOT applyEdgeDrag with all four edges — that clamps each edge independently and would squash the region against the frame instead of stopping it). */
function moveRegion(start: SourceRegion, fracDx: number, fracDy: number): SourceRegion {
  return {
    x: Math.min(Math.max(start.x + fracDx, 0), 1 - start.width),
    y: Math.min(Math.max(start.y + fracDy, 0), 1 - start.height),
    width: start.width,
    height: start.height,
  };
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRegion: SourceRegion;
  edges: readonly RegionEdge[] | "move";
}

let drag: DragState | null = null;

function beginDrag(event: PointerEvent, edges: readonly RegionEdge[] | "move"): void {
  drag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startRegion: config.sourceRegion,
    edges,
  };
  // Capture is a nicety (keeps the drag alive when the cursor leaves the
  // window) — the move/up listeners are on window regardless, so a failed
  // capture must never abort the drag. It CAN fail: synthetic pointer
  // events (tests/automation) have pointer ids the browser won't capture.
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // fine without capture
  }
  event.preventDefault();
  event.stopPropagation();
}

regionRect.addEventListener("pointerdown", (event) => beginDrag(event, "move"));
for (const handle of Array.from(regionRect.querySelectorAll<HTMLElement>(".resize-handle"))) {
  handle.addEventListener("pointerdown", (event) => {
    const edges = (handle.dataset["edges"] ?? "").split(" ").filter(Boolean) as RegionEdge[];
    beginDrag(event, edges);
  });
}

window.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const box = previewBox.getBoundingClientRect();
  const fracDx = (event.clientX - drag.startClientX) / box.width;
  const fracDy = (event.clientY - drag.startClientY) / box.height;
  setSourceRegion(drag.edges === "move" ? moveRegion(drag.startRegion, fracDx, fracDy) : applyEdgeDrag(drag.startRegion, drag.edges, fracDx, fracDy));
});
window.addEventListener("pointerup", (event) => {
  if (drag && event.pointerId === drag.pointerId) drag = null;
});

presetRow.addEventListener("click", (event) => {
  const preset = (event.target as HTMLElement).dataset?.["preset"] as keyof typeof SOURCE_REGION_PRESETS | undefined;
  if (preset && SOURCE_REGION_PRESETS[preset]) setSourceRegion(SOURCE_REGION_PRESETS[preset]);
});

function readNumericRegion(): void {
  const candidate: SourceRegion = {
    x: Number(inputX.value),
    y: Number(inputY.value),
    width: Number(inputW.value),
    height: Number(inputH.value),
  };
  if (isValidSourceRegion(candidate)) setSourceRegion(candidate);
  else renderRegion(); // snap the fields back to the last valid region
}
for (const input of [inputX, inputY, inputW, inputH]) {
  input.addEventListener("change", readNumericRegion);
}

// ------------------------------------------------------------- live preview

/** Renders the extension's own last-published cards inside the region rect — the "am I calibrated?" signal. Same mapping the real viewer applies (mapBoundsToSourceRegion + computeHitboxStyle), painted into the preview box's coordinate space. */
function renderLivePreview(): void {
  for (const el of Array.from(previewBox.querySelectorAll(".preview-hitbox"))) el.remove();
  if (!lastLiveState) {
    liveHint.textContent = "No live board — open Rift Atlas and start publishing to preview your real hitboxes here.";
    return;
  }
  liveHint.textContent = `Live preview: ${lastLiveState.cards.length} cards`;
  for (const card of lastLiveState.cards) {
    const mapped = {
      ...card,
      bounds: mapBoundsToSourceRegion(card.bounds, config.sourceRegion),
      ...mapSizeToSourceRegion({ width: card.localWidth, height: card.localHeight }, config.sourceRegion),
    };
    const style = computeHitboxStyle({ ...mapped, localWidth: mapped.width, localHeight: mapped.height });
    const box = document.createElement("div");
    box.className = `preview-hitbox ${card.visibility !== "public" ? "hidden-card" : ""}`.trim();
    box.style.left = style.left;
    box.style.top = style.top;
    box.style.width = style.width;
    box.style.height = style.height;
    box.style.zIndex = String(style.zIndex);
    if (style.transform) {
      box.style.transform = style.transform;
      if (style.transformOrigin) box.style.transformOrigin = style.transformOrigin;
    }
    previewBox.appendChild(box);
  }
}

function pollLiveState(): void {
  void safeSendMessage<{ state?: OverlayState }>({ type: "get-last-state" })
    .then((response) => {
      lastLiveState = response?.state;
      renderLivePreview();
    })
    .catch(() => {
      lastLiveState = undefined;
      renderLivePreview();
    });
}

// ------------------------------------------------------------ other controls

function renderControls(): void {
  tooltipScaleSlider.value = String(config.tooltipScale);
  tooltipScaleLabel.textContent = `${Math.round(config.tooltipScale * 100)}% — ${describeTooltipScale(config.tooltipScale)}`;
  delaySecondsInput.value = String(Math.round(config.delayMs / 1000));
  overlayEnabledCheckbox.checked = config.overlayEnabled;
}

tooltipScaleSlider.addEventListener("input", () => {
  const scale = Math.min(Math.max(Number(tooltipScaleSlider.value), MIN_TOOLTIP_SCALE), MAX_TOOLTIP_SCALE);
  config = { ...config, tooltipScale: scale };
  tooltipScaleLabel.textContent = `${Math.round(scale * 100)}% — ${describeTooltipScale(scale)}`;
});

delaySecondsInput.addEventListener("change", () => {
  const ms = Math.round(Number(delaySecondsInput.value)) * 1000;
  config = { ...config, delayMs: Math.min(Math.max(ms, 0), MAX_DELAY_MS) };
  renderControls();
});

overlayEnabledCheckbox.addEventListener("change", () => {
  config = { ...config, overlayEnabled: overlayEnabledCheckbox.checked };
});

saveButton.addEventListener("click", () => {
  void chrome.storage.local
    .set({ [STORAGE_KEY_OVERLAY_CONFIG]: serializeOverlayConfig(config) })
    .then(() => {
      saveStatus.textContent = "Saved — publishes with your next board update.";
      setTimeout(() => (saveStatus.textContent = ""), 4000);
    })
    .catch(() => {
      saveStatus.textContent = "Couldn't save — try again.";
    });
});

// ------------------------------------------------------------------- startup

void chrome.storage.local
  .get(STORAGE_KEY_OVERLAY_CONFIG)
  .then((stored) => {
    const raw = (stored as Record<string, unknown>)[STORAGE_KEY_OVERLAY_CONFIG];
    config = parseOverlayConfig(typeof raw === "string" ? raw : undefined);
  })
  .catch(() => {
    config = DEFAULT_OVERLAY_CONFIG;
  })
  .then(() => {
    renderRegion();
    renderControls();
    pollLiveState();
    setInterval(pollLiveState, LIVE_PREVIEW_POLL_MS);
  });
