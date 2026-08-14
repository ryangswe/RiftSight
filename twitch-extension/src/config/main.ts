// Broadcaster configuration page entry point. Twitch only ever shows this
// to the broadcaster (and extension editors) for their own channel — that
// access restriction is enforced by Twitch's platform, not this code;
// normal viewers never load this page at all. Same mock/real branching
// convention as src/viewer/main.ts.
import {
  DEFAULT_OVERLAY_CONFIG,
  FULL_FRAME_SOURCE_REGION,
  MAX_DELAY_MS,
  OVERLAY_CONFIG_VERSION,
  SOURCE_REGION_PRESETS,
  applyEdgeDrag,
  computeHitboxStyle,
  computeTooltipMaxSize,
  describeTooltipScale,
  hitboxClassName,
  isValidSourceRegion,
  mapBoundsToSourceRegion,
  mapSizeToSourceRegion,
  matchDelayPreset,
  matchRegionPreset,
  msToSeconds,
  parseOverlayConfig,
  secondsToMs,
  serializeOverlayConfig,
  type OverlayConfig,
  type RegionEdge,
  type SourceRegion,
} from "@riftsight/overlay-core";
import type { OverlayCard } from "@riftsight/protocol";
import { MockOverlayStateSource } from "../platform/mock-state-source.js";
import { getConfiguredRelayUrl } from "../platform/relay-url.js";
import { buildPlatformContext } from "../platform/twitch-context.js";
import { TwitchOverlayStateSource } from "../platform/twitch-state-source.js";

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
    localWidth: 0.12,
    localHeight: 0.18,
    fromDialog: false,
  },
  {
    instanceId: "preview-card-2",
    zone: "hand",
    owner: "opponent",
    visibility: "hidden",
    bounds: { x: 0.62, y: 0.15, width: 0.08, height: 0.12 },
    rotation: 20,
    landscape: false,
    // Deliberately smaller than bounds — bounds is a rotated card's
    // inflated AABB, so a real localWidth/localHeight is always ≤ it.
    // Demonstrates the rotated-hitbox fix in this same preview.
    localWidth: 0.07,
    localHeight: 0.1,
    fromDialog: false,
  },
];

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const pageStatusText = requireElement<HTMLElement>("page-status");
const debugWarningBanner = requireElement<HTMLElement>("debug-warning-banner");

const overlayEnabledInput = requireElement<HTMLInputElement>("overlay-enabled-input");
const debugOutlinesInput = requireElement<HTMLInputElement>("debug-outlines-input");
const aspectRatioInput = requireElement<HTMLInputElement>("aspect-ratio-input");
const tooltipScaleInput = requireElement<HTMLInputElement>("tooltip-scale-input");
const tooltipScaleReadout = requireElement<HTMLElement>("tooltip-scale-readout");
const tooltipPreviewPortraitBox = requireElement<HTMLElement>("tooltip-preview-portrait");
const tooltipPreviewPortraitDims = requireElement<HTMLElement>("tooltip-preview-portrait-dims");
const tooltipPreviewLandscapeBox = requireElement<HTMLElement>("tooltip-preview-landscape");
const tooltipPreviewLandscapeDims = requireElement<HTMLElement>("tooltip-preview-landscape-dims");

const delayPresetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-delay-preset]"));
const delayCustomRow = requireElement<HTMLElement>("delay-custom-row");
const delayCustomInput = requireElement<HTMLInputElement>("delay-custom-input");

const regionPresetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-region-preset]"));
const regionPresetStatus = requireElement<HTMLElement>("region-preset-status");
const regionXInput = requireElement<HTMLInputElement>("region-x-input");
const regionYInput = requireElement<HTMLInputElement>("region-y-input");
const regionWidthInput = requireElement<HTMLInputElement>("region-width-input");
const regionHeightInput = requireElement<HTMLInputElement>("region-height-input");
const regionResetButton = requireElement<HTMLButtonElement>("region-reset-button");
const regionStatusText = requireElement<HTMLElement>("region-status-text");

const previewContainer = requireElement<HTMLElement>("calibration-preview");
const previewBgImage = requireElement<HTMLImageElement>("calibration-bg-image");
const dropzoneEl = requireElement<HTMLElement>("calibration-dropzone");
const bgFileInput = requireElement<HTMLInputElement>("bg-file-input");
const bgClearButton = requireElement<HTMLButtonElement>("bg-clear-button");
const dropzoneFilenameChip = requireElement<HTMLElement>("dropzone-filename");
const dropzoneFilenameText = requireElement<HTMLElement>("dropzone-filename-text");
const previewRegionBox = requireElement<HTMLElement>("calibration-region");
const previewResizeHandles = Array.from(previewRegionBox.querySelectorAll<HTMLElement>(".resize-handle"));
const previewHitboxLayer = requireElement<HTMLElement>("calibration-hitboxes");

const saveButton = requireElement<HTMLButtonElement>("save-button");
const saveStatusEl = requireElement<HTMLElement>("save-status");
const saveStatusText = requireElement<HTMLElement>("save-status-text");
const saveTimestampEl = requireElement<HTMLElement>("save-timestamp");

// The numeric x/y/width/height inputs (now under Advanced → Exact values)
// are the authoritative source of truth — the drag/resize preview above is
// layered on top of the same underlying state — currentSourceRegion always
// holds the last *valid* region; an invalid manual edit reverts the inputs
// to it rather than saving something broken.
let currentSourceRegion: SourceRegion = FULL_FRAME_SOURCE_REGION;
let currentDelayMs = DEFAULT_OVERLAY_CONFIG.delayMs;
let previewCards: OverlayCard[] = MOCK_PREVIEW_CARDS;

// Set true only while applyToForm is populating the page from a loaded
// config — every setter below also gets called from real user interaction,
// and only the latter should mark the form dirty.
let suppressDirtyTracking = true;
let isDirty = false;
let isReadyToSave = false; // authorized (real mode) or mock mode, independent of isDirty

function setSaveStatus(state: "clean" | "dirty" | "saving" | "saved" | "error"): void {
  saveStatusEl.className = state === "clean" ? "save-status" : `save-status ${state}`;
  saveStatusText.textContent = {
    clean: "No changes to save",
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    error: "Could not save",
  }[state];
}

function updateSaveButtonState(): void {
  saveButton.disabled = !isReadyToSave || !isDirty;
}

function markDirty(): void {
  if (suppressDirtyTracking) return;
  isDirty = true;
  setSaveStatus("dirty");
  updateSaveButtonState();
}

function markClean(savedAt: Date): void {
  isDirty = false;
  setSaveStatus("saved");
  saveTimestampEl.textContent = `Saved · ${savedAt.toLocaleTimeString()}`;
  updateSaveButtonState();
}

// Best-effort protection against losing unsaved changes: reliably works for
// an actual browser tab close or top-level navigation, since that's a real
// unload of this document's own window. What it can't guarantee is Twitch's
// own in-dashboard dismissal of the config iframe — browsers are known to
// suppress the confirmation dialog (though not the event itself) for a
// subframe being removed/navigated by its parent, as opposed to a real
// tab-close, and there's no Twitch-specific documentation either way. The
// sticky save bar's persistent "Unsaved changes" text is the fallback that
// still works regardless: it's visible for as long as this iframe stays
// alive, dialog or not.
window.addEventListener("beforeunload", (event) => {
  if (!isDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

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

function updateRegionPresetState(region: SourceRegion): void {
  const match = matchRegionPreset(region, SOURCE_REGION_PRESETS);
  for (const button of regionPresetButtons) {
    button.setAttribute("aria-pressed", String(button.dataset["regionPreset"] === match));
  }
  regionPresetStatus.textContent = match === "custom" ? "Custom" : "";
}

// Mirrors the real viewer's renderHitboxes() exactly (map bounds into the
// region, then the same computeHitboxStyle/hitboxClassName calls) so the
// preview is an honest representation of what viewers will actually see —
// not a separate, potentially-drifting reimplementation. Unlike the real
// overlay, this preview always renders hitboxes visibly regardless of the
// "Show hitbox outlines to viewers" setting — that checkbox controls only
// what real viewers see after Save; a broadcaster calibrating here (with
// that setting correctly left off) still needs to see where cards land.
function renderPreviewHitboxes(): void {
  previewHitboxLayer.replaceChildren();

  for (const card of previewCards) {
    const mappedBounds = mapBoundsToSourceRegion(card.bounds, currentSourceRegion);
    const mappedSize = mapSizeToSourceRegion({ width: card.localWidth, height: card.localHeight }, currentSourceRegion);
    const mappedCard = { ...card, bounds: mappedBounds, localWidth: mappedSize.width, localHeight: mappedSize.height };

    const style = computeHitboxStyle(mappedCard);
    const box = document.createElement("div");
    box.className = hitboxClassName(card);
    box.style.left = style.left;
    box.style.top = style.top;
    box.style.width = style.width;
    box.style.height = style.height;
    box.style.zIndex = style.zIndex;
    box.style.transform = style.transform ?? "";
    box.style.transformOrigin = style.transformOrigin ?? "";
    previewHitboxLayer.appendChild(box);
  }
}

function setSourceRegion(region: SourceRegion): void {
  if (!isValidSourceRegion(region)) {
    regionStatusText.textContent = "That region doesn't fit within the frame — reverted to the last valid value.";
    applyRegionToInputs(currentSourceRegion);
    return;
  }
  regionStatusText.textContent = "";
  currentSourceRegion = region;
  applyRegionToInputs(region);
  renderRegionBox(region);
  updateRegionPresetState(region);
  renderPreviewHitboxes();
  markDirty();
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
interface ResizeDragState extends DragState {
  edges: readonly RegionEdge[];
}
let moveState: DragState | null = null;
let resizeState: ResizeDragState | null = null;

previewRegionBox.addEventListener("mousedown", (event) => {
  if ((event.target as HTMLElement).closest(".resize-handle")) return; // a resize handle owns this instead
  event.preventDefault();
  moveState = { startClientX: event.clientX, startClientY: event.clientY, startRegion: currentSourceRegion };
});

// One shared handler for all 8 handles (4 corners + 4 mid-edges) — which
// edge(s) of the region each one drags comes from its own data-edges
// attribute (e.g. "left top" for the top-left corner, "right" for the
// right mid-edge handle), read once at drag-start time.
previewResizeHandles.forEach((handle) => {
  const edges = (handle.dataset["edges"] ?? "").split(" ").filter((edge): edge is RegionEdge => edge.length > 0);
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizeState = { startClientX: event.clientX, startClientY: event.clientY, startRegion: currentSourceRegion, edges };
  });
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
    setSourceRegion(applyEdgeDrag(resizeState.startRegion, resizeState.edges, dx, dy));
  }
});

window.addEventListener("mouseup", () => {
  moveState = null;
  resizeState = null;
});

// A reference screenshot for visually aligning the region against the
// broadcaster's real stream composition — purely a local sighting aid, kept
// in-memory for this page load only (never part of OverlayConfig, never
// sent anywhere). URL.createObjectURL keeps the file entirely in this tab.
let referenceImageObjectUrl: string | null = null;

function loadReferenceImage(file: File): void {
  if (referenceImageObjectUrl) URL.revokeObjectURL(referenceImageObjectUrl);
  referenceImageObjectUrl = URL.createObjectURL(file);
  previewBgImage.src = referenceImageObjectUrl;
  previewBgImage.classList.add("loaded");
  dropzoneFilenameText.textContent = file.name;
  dropzoneFilenameChip.classList.add("visible");
}

function clearReferenceImage(): void {
  bgFileInput.value = "";
  if (referenceImageObjectUrl) {
    URL.revokeObjectURL(referenceImageObjectUrl);
    referenceImageObjectUrl = null;
  }
  previewBgImage.removeAttribute("src");
  previewBgImage.classList.remove("loaded");
  dropzoneFilenameChip.classList.remove("visible");
  dropzoneFilenameText.textContent = "";
}

bgFileInput.addEventListener("change", () => {
  const file = bgFileInput.files?.[0];
  if (file) loadReferenceImage(file);
});
bgClearButton.addEventListener("click", clearReferenceImage);

dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("drag-over");
});
dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("drag-over");
});
dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("drag-over");
  const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
  if (file) loadReferenceImage(file);
});

// Clipboard paste (e.g. a screenshot copied straight from an OS screenshot
// tool) — global on the page since there's no rich-text field here for a
// paste to conflict with; ignored entirely when the clipboard has no image.
window.addEventListener("paste", (event) => {
  const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
  if (file) loadReferenceImage(file);
});

function readSourceRegionFromInputs(): SourceRegion {
  return {
    x: Number.parseFloat(regionXInput.value),
    y: Number.parseFloat(regionYInput.value),
    width: Number.parseFloat(regionWidthInput.value),
    height: Number.parseFloat(regionHeightInput.value),
  };
}

function updateTooltipScaleReadout(): void {
  const scale = Number.parseFloat(tooltipScaleInput.value);
  const label = describeTooltipScale(scale);
  tooltipScaleReadout.textContent = `${scale.toFixed(1)}x`;
  tooltipScaleInput.setAttribute("aria-valuetext", `${scale.toFixed(1)}x, ${label}`);
}

// A live preview of the real tooltip box size at the current slider value,
// so a broadcaster can judge sizing without publishing, hovering a card on
// their own stream, then coming back here to adjust and repeat. The
// on-page box is shown at a fixed fraction of the true size (the real
// tooltip can run up to 640x896px at max scale — far too large to render
// 1:1 on this settings page) — the px readout underneath is the actual,
// real dimension viewers will see, which is the number that matters here.
// Uses the exact same computeTooltipMaxSize the real viewer calls (see
// viewer/main.ts's showTooltipFor), so this can never silently drift from
// what's actually shown on stream. Both portrait and landscape base sizes
// are shown — they're genuinely different aspect ratios (320x448 vs
// 400x500), not a scaled duplicate of each other, so a broadcaster with
// battlefield-type cards in play needs to see both, not just one.
const TOOLTIP_PREVIEW_DISPLAY_SCALE = 0.3;

function updateTooltipSizePreview(): void {
  const scale = Number.parseFloat(tooltipScaleInput.value) || DEFAULT_OVERLAY_CONFIG.tooltipScale;

  const portrait = computeTooltipMaxSize(false, scale);
  tooltipPreviewPortraitBox.style.width = `${portrait.maxWidthPx * TOOLTIP_PREVIEW_DISPLAY_SCALE}px`;
  tooltipPreviewPortraitBox.style.height = `${portrait.maxHeightPx * TOOLTIP_PREVIEW_DISPLAY_SCALE}px`;
  tooltipPreviewPortraitDims.textContent = `${Math.round(portrait.maxWidthPx)} × ${Math.round(portrait.maxHeightPx)}px`;

  const landscape = computeTooltipMaxSize(true, scale);
  tooltipPreviewLandscapeBox.style.width = `${landscape.maxWidthPx * TOOLTIP_PREVIEW_DISPLAY_SCALE}px`;
  tooltipPreviewLandscapeBox.style.height = `${landscape.maxHeightPx * TOOLTIP_PREVIEW_DISPLAY_SCALE}px`;
  tooltipPreviewLandscapeDims.textContent = `${Math.round(landscape.maxWidthPx)} × ${Math.round(landscape.maxHeightPx)}px`;
}

// Preview's aspect ratio follows the broadcaster's own aspect-ratio
// override when set, so the calibration rectangle is drawn against the
// same proportions the real overlay will actually use — falls back to
// 16:9 (this page's long-standing default) when the override is empty.
function updatePreviewAspectRatio(): void {
  const parsed = Number.parseFloat(aspectRatioInput.value);
  previewContainer.style.aspectRatio = Number.isFinite(parsed) && parsed > 0 ? String(parsed) : "16 / 9";
}

function updateDebugWarningBanner(): void {
  debugWarningBanner.classList.toggle("visible", debugOutlinesInput.checked);
}

// Keeps the delay pills' aria-pressed state and the custom-seconds row's
// visibility in sync with currentDelayMs — split out from setDelayMs so
// the custom seconds field's own input handler can call this without
// setDelayMs's usual "also overwrite the custom field's displayed value"
// behavior, which would otherwise stomp on what the broadcaster is
// actively typing.
function syncDelayPillState(ms: number): void {
  const match = matchDelayPreset(ms);
  for (const button of delayPresetButtons) {
    const presetAttr = button.dataset["delayPreset"] ?? "";
    const pressed = presetAttr === "custom" ? match === "custom" : Number(presetAttr) === match;
    button.setAttribute("aria-pressed", String(pressed));
  }
  delayCustomRow.style.display = match === "custom" ? "" : "none";
}

// Called from preset-pill clicks and from applyToForm — safe to overwrite
// the custom field's displayed value, since the change didn't originate
// from the user actively typing into it.
function setDelayMs(ms: number): void {
  currentDelayMs = Math.min(MAX_DELAY_MS, Math.max(0, ms));
  syncDelayPillState(currentDelayMs);
  delayCustomInput.value = String(msToSeconds(currentDelayMs));
  markDirty();
}

delayPresetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const presetAttr = button.dataset["delayPreset"] ?? "";
    if (presetAttr === "custom") {
      // Forces the custom row open and that pill pressed regardless of
      // whether currentDelayMs happens to already match a fixed preset —
      // the broadcaster explicitly asked to enter a custom value.
      for (const b of delayPresetButtons) b.setAttribute("aria-pressed", String(b === button));
      delayCustomRow.style.display = "";
      delayCustomInput.value = String(msToSeconds(currentDelayMs));
      delayCustomInput.focus();
    } else {
      setDelayMs(Number(presetAttr));
    }
  });
});

delayCustomInput.addEventListener("input", () => {
  const seconds = Number.parseFloat(delayCustomInput.value);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  currentDelayMs = Math.min(MAX_DELAY_MS, secondsToMs(seconds));
  syncDelayPillState(currentDelayMs);
  markDirty();
});

function applyToForm(config: OverlayConfig): void {
  suppressDirtyTracking = true;
  overlayEnabledInput.checked = config.overlayEnabled;
  setDelayMs(config.delayMs);
  debugOutlinesInput.checked = config.debugOutlines;
  updateDebugWarningBanner();
  aspectRatioInput.value = config.sourceAspectRatio !== undefined ? String(config.sourceAspectRatio) : "";
  updatePreviewAspectRatio();
  tooltipScaleInput.value = String(config.tooltipScale);
  updateTooltipScaleReadout();
  updateTooltipSizePreview();
  setSourceRegion(config.sourceRegion);
  suppressDirtyTracking = false;
  setSaveStatus("clean");
  updateSaveButtonState();
}

function readFromForm(): OverlayConfig {
  const parsedAspectRatio = Number.parseFloat(aspectRatioInput.value);
  return {
    overlayEnabled: overlayEnabledInput.checked,
    // Clamped at both ends: currentDelayMs is already kept within
    // [0, MAX_DELAY_MS] by setDelayMs/the custom-input handler above, but
    // clamping again here is the actual enforcement, not just an advisory
    // one. See MAX_DELAY_MS's own doc comment for why this bound exists.
    delayMs: Math.min(MAX_DELAY_MS, Math.max(0, currentDelayMs)),
    debugOutlines: debugOutlinesInput.checked,
    sourceAspectRatio: Number.isFinite(parsedAspectRatio) && parsedAspectRatio > 0 ? parsedAspectRatio : undefined,
    sourceRegion: currentSourceRegion,
    // The <input type="range" min="0.5" max="2"> can't produce an
    // out-of-range value through normal browser interaction, so no extra
    // clamping is needed here — unlike aspectRatioInput (free-text) above.
    tooltipScale: Number.parseFloat(tooltipScaleInput.value) || DEFAULT_OVERLAY_CONFIG.tooltipScale,
  };
}

overlayEnabledInput.addEventListener("change", markDirty);

debugOutlinesInput.addEventListener("change", () => {
  updateDebugWarningBanner();
  markDirty();
});

aspectRatioInput.addEventListener("input", () => {
  updatePreviewAspectRatio();
  markDirty();
});

tooltipScaleInput.addEventListener("input", () => {
  updateTooltipScaleReadout();
  updateTooltipSizePreview();
  markDirty();
});

[regionXInput, regionYInput, regionWidthInput, regionHeightInput].forEach((input) => {
  input.addEventListener("change", () => setSourceRegion(readSourceRegionFromInputs()));
});

regionResetButton.addEventListener("click", () => setSourceRegion(FULL_FRAME_SOURCE_REGION));

regionPresetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset["regionPreset"] as keyof typeof SOURCE_REGION_PRESETS | undefined;
    if (key && key in SOURCE_REGION_PRESETS) setSourceRegion(SOURCE_REGION_PRESETS[key]);
  });
});

if (isMock) {
  const stored = localStorage.getItem(MOCK_STORAGE_KEY) ?? undefined;
  applyToForm(parseOverlayConfig(stored));
  pageStatusText.textContent = "Mock mode — Save writes to localStorage, not Twitch.";
  isReadyToSave = true;
  updateSaveButtonState();

  saveButton.addEventListener("click", () => {
    setSaveStatus("saving");
    window.setTimeout(() => {
      localStorage.setItem(MOCK_STORAGE_KEY, serializeOverlayConfig(readFromForm()));
      markClean(new Date());
    }, 150);
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
  pageStatusText.textContent = "Waiting for Twitch authorization…";

  if (!window.Twitch?.ext) {
    pageStatusText.textContent = "Twitch Extension Helper not found — this page must be loaded inside a Twitch extension iframe.";
    pageStatusText.classList.add("error");
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
      isReadyToSave = true;
      applyToForm(parseOverlayConfig(twitch.configuration.broadcaster?.content));
      pageStatusText.textContent = "";
      pageStatusText.classList.remove("error");
      if (!authorized) {
        authorized = true;
        previewSource?.connect(buildPlatformContext(auth, "config"));
      } else {
        previewSource?.updateToken(auth.token);
      }
    });

    // The Twitch Extension Helper's onError has exactly one active
    // listener for the whole page (not a stack), so this single
    // registration does double duty: it's both the original
    // auth-failure reporter AND the signal the save flow below polls —
    // configuration.set() itself has no success/failure callback in the
    // Helper API, so "did a save just fail" can only be inferred
    // heuristically from whether *any* Twitch error arrived shortly
    // after clicking Save. This can miss a real failure (if onError is
    // slow to arrive) or rarely misattribute an unrelated error — it's a
    // best-effort signal, not a guarantee.
    let lastTwitchErrorAt = 0;
    twitch.onError((error) => {
      console.warn("[twitch-extension] Twitch Helper reported an error", error);
      lastTwitchErrorAt = Date.now();
      pageStatusText.textContent = "Twitch authorization failed — see console for details.";
      pageStatusText.classList.add("error");
    });

    const SAVE_ERROR_CHECK_DELAY_MS = 1500;
    saveButton.addEventListener("click", () => {
      setSaveStatus("saving");
      const clickedAt = Date.now();
      twitch.configuration.set("broadcaster", OVERLAY_CONFIG_VERSION, serializeOverlayConfig(readFromForm()));
      window.setTimeout(() => {
        if (lastTwitchErrorAt > clickedAt) {
          setSaveStatus("error");
          updateSaveButtonState();
        } else {
          markClean(new Date());
        }
      }, SAVE_ERROR_CHECK_DELAY_MS);
    });
  }
}
