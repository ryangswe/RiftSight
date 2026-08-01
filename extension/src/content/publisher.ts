// Wires the real detector into the shared protocol and hands finished
// OverlayState snapshots to the background service worker, which owns the
// actual relay connection (content scripts should not own backend
// connection lifecycle — see background/background.ts).

import { OverlayStatePublisher, toOverlayCard, type DetectionInput, type Viewport } from "@riftsight/protocol";
import { detectCards } from "./card-detector.js";
import { observeBoard, type CardObserverHandle } from "./card-observer.js";

let observerHandle: CardObserverHandle | null = null;
let statePublisher: OverlayStatePublisher | null = null;
let publishedCount = 0;

function currentViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function toDetectionInput(detection: ReturnType<typeof detectCards>[number]): DetectionInput {
  return {
    instanceId: detection.instanceId,
    cardId: detection.cardId,
    name: detection.name,
    imageUrl: detection.imageUrl,
    visibility: detection.visibility,
    dropZone: detection.dropZone,
    owner: detection.owner,
    rotationDeg: detection.rotationDeg,
    zIndexHint: detection.zIndexHint,
    bounds: detection.bounds,
    landscape: detection.landscape,
  };
}

function publishOnce(): void {
  if (!statePublisher) return;

  const viewport = currentViewport();
  const cards = detectCards()
    .map((detection) => toOverlayCard(toDetectionInput(detection), viewport))
    .filter((card): card is NonNullable<typeof card> => card !== null);

  const state = statePublisher.next(cards, viewport);
  if (!state) return; // deduped — nothing meaningfully changed

  publishedCount += 1;
  chrome.runtime.sendMessage({ type: "overlay-state", payload: state }).catch(() => {
    // The background worker may be waking up from suspension; it'll pick
    // up the next debounced publish. Nothing useful to do with this here.
  });
}

export function isPublishing(): boolean {
  return observerHandle !== null;
}

export function publishedSnapshotCount(): number {
  return publishedCount;
}

export function startPublishing(sessionId: string): void {
  if (observerHandle) return;
  statePublisher = new OverlayStatePublisher(sessionId);
  publishedCount = 0;
  observerHandle = observeBoard(publishOnce);
}

export function stopPublishing(): void {
  observerHandle?.disconnect();
  observerHandle = null;
  statePublisher = null;
}
