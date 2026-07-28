// Thin DOM glue — the interesting logic (geometry mapping, tooltip
// content) lives in render.ts/tooltip.ts, which are unit-tested. This file
// just wires those pure functions to the page.

import { DEFAULT_SESSION_ID, type OverlayCard, type OverlayState } from "@riftsight/protocol";
import { computeHitboxStyle, computeTooltipPosition, hitboxClassName, hitboxLabel } from "./render.js";
import { tooltipContentFor } from "./tooltip.js";
import { connectViewer, type ConnectionStatus } from "./ws-client.js";

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
const hitboxLayer = requireElement<HTMLElement>("hitboxes");
const tooltip = requireElement<HTMLElement>("tooltip");
const toggleOutlines = requireElement<HTMLInputElement>("toggle-outlines");
const toggleLabels = requireElement<HTMLInputElement>("toggle-labels");

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

// Fixed aspect ratio derived from the fixture screenshot's real dimensions,
// so the stage preserves it at any container width and on resize.
bgImage.addEventListener("load", () => {
  if (bgImage.naturalWidth > 0 && bgImage.naturalHeight > 0) {
    stage.style.aspectRatio = `${bgImage.naturalWidth} / ${bgImage.naturalHeight}`;
  }
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

connectViewer({
  sessionId,
  onStatusChange: setStatus,
  onState: (state: OverlayState) => {
    latestCards = state.cards;
    sequenceText.textContent = String(state.sequence);
    capturedText.textContent = new Date(state.capturedAt).toLocaleTimeString();
    renderHitboxes();
  },
});
