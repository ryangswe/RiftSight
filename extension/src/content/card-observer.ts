// Watches the RiftAtlas board for DOM changes and calls back, debounced, so
// callers aren't re-scanning on every animation frame or micro-mutation
// (RiftAtlas's board re-renders frequently — hover states, counters, etc.).
// Deliberately thin/browser-glue: the logic actually worth unit-testing
// (dedup, sequencing, and now the settle-loop's own control flow) lives in
// @riftsight/protocol's OverlayStatePublisher and this module's settle.ts,
// which this only wires together.

import { CARD_ANCHOR_SELECTOR } from "./card-detector.js";
import { boundsFingerprint, runSettleLoop, type FingerprintEntry, type SettleLoopHandle } from "./settle.js";

const DEBOUNCE_MS = 300;

// After the debounce settles, RiftAtlas may still be mid-CSS-transition on a
// card that was just played/moved (see rotation.ts's doc comment on the
// `transition-[left,bottom]` position wrapper) — a single DOM mutation kicks
// the transition off, but nothing re-mutates the DOM again once it's
// running, so a scan fired on a flat timer alone can read an in-flight, not
// final, position. These two constants bound how long runSettleLoop keeps
// re-sampling bounds waiting for them to stop changing before giving up and
// scanning anyway (same "next mutation corrects it" fallback as before,
// just less likely to be needed).
const SETTLE_CHECK_INTERVAL_MS = 60;
const MAX_SETTLE_CHECKS = 8;

// RiftAtlas's actual game-board DOM root (see card-detector.ts's captured
// evidence). Exported on its own — distinct from BOARD_ROOT_SELECTOR below
// — because it's also the presence-heartbeat's "is a game board present"
// signal (see content/inventory.ts's heartbeat tick and
// background/presence.ts): a real, empty-of-cards board still has this
// element, so checking for it (rather than checking for any
// CARD_ANCHOR_SELECTOR match) is what makes "no cards currently visible"
// distinguishable from "no game open at all."
export const GAME_BOARD_SELECTOR = "section.gb-board";

// Falls back to document.body if the selector above ever changes;
// watching the whole body just means more mutation events to debounce
// through for the MutationObserver below, not incorrect behavior — this
// fallback is specifically about "always have *something* to observe,"
// not about detecting board presence (see isGameBoardDetected for that).
const BOARD_ROOT_SELECTOR = `${GAME_BOARD_SELECTOR}, body`;

/** True only when a real game board is present — independent of whether any cards currently happen to be on it (an empty board at match start has zero cards but a real board root). See the heartbeat/presence design notes above for why this distinction matters. */
export function isGameBoardDetected(): boolean {
  return document.querySelector(GAME_BOARD_SELECTOR) !== null;
}

export interface CardObserverHandle {
  disconnect(): void;
}

function captureFingerprint(root: ParentNode): string {
  const entries: FingerprintEntry[] = [];
  root.querySelectorAll<HTMLElement>(CARD_ANCHOR_SELECTOR).forEach((el) => {
    const id = el.getAttribute("data-card-id");
    if (!id) return;
    const rect = el.getBoundingClientRect();
    entries.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  });
  return boundsFingerprint(entries);
}

export function observeBoard(onChange: () => void): CardObserverHandle {
  const root = document.querySelector(BOARD_ROOT_SELECTOR) ?? document.body;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let settleHandle: SettleLoopHandle | undefined;

  const startSettleLoop = (): void => {
    settleHandle = runSettleLoop({
      sample: () => captureFingerprint(root),
      onSettled: () => {
        settleHandle = undefined;
        onChange();
      },
      intervalMs: SETTLE_CHECK_INTERVAL_MS,
      maxAttempts: MAX_SETTLE_CHECKS,
    });
  };

  // While a settle loop is already running, further mutations are
  // deliberately ignored here rather than cancelling and restarting it —
  // runSettleLoop already re-samples fresh bounds on every check, so it
  // naturally keeps waiting on its own if something relevant is still
  // moving, or settles once nothing is. Cancelling on every mutation
  // (including ones unrelated to card geometry — RiftAtlas's board
  // "re-renders frequently: hover states, counters, etc.", per the header
  // comment above) meant the loop could be perpetually restarted on a busy
  // page and never actually complete, silently starving publishing
  // entirely. This way, once triggered, a scan is guaranteed to happen
  // within a bounded worst case (DEBOUNCE_MS + up to MAX_SETTLE_CHECKS *
  // SETTLE_CHECK_INTERVAL_MS) regardless of how much unrelated churn
  // happens on the page.
  const scheduleChange = (): void => {
    if (settleHandle) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      startSettleLoop();
    }, DEBOUNCE_MS);
  };

  const observer = new MutationObserver(scheduleChange);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-card-id", "data-drop-zone", "data-preview-rotation", "style", "class"],
  });

  // Fire once immediately so callers get an initial snapshot without
  // waiting for the first mutation.
  scheduleChange();

  return {
    disconnect(): void {
      observer.disconnect();
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      settleHandle?.cancel();
    },
  };
}
