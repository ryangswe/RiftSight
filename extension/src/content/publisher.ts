// Wires the real detector into the shared protocol and hands finished
// OverlayState snapshots to the background service worker, which owns the
// actual relay connection (content scripts should not own backend
// connection lifecycle — see background/background.ts).

import { normalizeBounds, OverlayStatePublisher, toOverlayCard, type DetectionInput, type Viewport } from "@riftsight/protocol";
import { detectCards } from "./card-detector.js";
import { observeBoard, type CardObserverHandle } from "./card-observer.js";
import type { CardDetection } from "./types.js";
import { safeSendMessage } from "../shared/messaging.js";

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

function toDetectionInput(detection: CardDetection): DetectionInput {
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
    localWidth: detection.localWidth,
    localHeight: detection.localHeight,
    fromDialog: detection.fromDialog,
  };
}

function publishOnce(): void {
  if (!statePublisher) return;

  const viewport = currentViewport();
  const detection = detectCards();
  const cards = detection.cards
    .map((card) => toOverlayCard(toDetectionInput(card), viewport))
    .filter((card): card is NonNullable<typeof card> => card !== null);
  const blockingRegion = detection.blockingRegion ? (normalizeBounds(detection.blockingRegion, viewport) ?? undefined) : undefined;

  const state = statePublisher.next(cards, viewport, { blockingRegion });
  if (!state) return; // deduped — nothing meaningfully changed

  publishedCount += 1;
  safeSendMessage({ type: "overlay-state", payload: state }).catch(() => {
    // The background worker may be waking up from suspension; it'll pick
    // up the next debounced publish. Nothing useful to do with this here.
  });
}

export function isPublishing(): boolean {
  return observerHandle !== null;
}

/**
 * Forces a fresh full snapshot to be sent right now, regardless of whether
 * the board looks unchanged since the last publish. Meant to be called
 * right after the producer WebSocket reconnects (see
 * content/inventory.ts's disconnected -> connected detection in its
 * get-status poll): a plain reconnect alone is not enough to guarantee a
 * freshly-restarted relay ever receives anything, since publisher.next()'s
 * ordinary dedup would otherwise suppress publishing entirely until the
 * board next actually changes — which, for a static board, could be
 * arbitrarily far in the future. reset() clears the dedup fingerprint (so
 * the very next detection is guaranteed to be treated as new) and the
 * sequence counter (a fresh relay-side session has no prior sequence to
 * continue from — see OverlayStatePublisher.reset's own doc comment).
 * A no-op if nothing is currently being published.
 */
export function republishCurrentState(): void {
  if (!statePublisher) return;
  statePublisher.reset();
  publishOnce();
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
  // Explicit clear before disconnecting: without this, a viewer would keep
  // rendering whatever hitboxes were last published until either the relay's
  // own stale-state TTL sweep eventually clears it (relay/src/server.ts,
  // on the order of tens of seconds) or the streamer starts publishing
  // again and the board happens to differ from its last-known state. This
  // sends immediately instead of waiting on either. next([], ...) still
  // goes through the same dedup as every other publish — if the board was
  // already empty (nothing to clear), it correctly sends nothing.
  if (statePublisher) {
    const state = statePublisher.next([], currentViewport());
    if (state) {
      safeSendMessage({ type: "overlay-state", payload: state }).catch(() => {
        // Best-effort: if the background worker is mid-suspend/wake and
        // misses this, the relay's own TTL sweep is the fallback safety
        // net — see server.ts's sweepStaleSessions.
      });
    }
  }

  observerHandle?.disconnect();
  observerHandle = null;
  statePublisher = null;
}
