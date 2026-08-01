// Pure geometry-comparison helper for card-observer.ts. Kept separate and
// DOM-free so it's directly unit-testable — the DOM reading (querying
// elements, calling getBoundingClientRect()) stays thin glue in
// card-observer.ts itself, matching this repo's established pattern (see
// rotation.ts for the same split).

export interface FingerprintEntry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Order-independent geometry fingerprint used to detect when card bounds
 * have stopped changing between two samples taken a short beat apart —
 * card-observer.ts's only signal that a CSS position transition (RiftAtlas
 * animates card moves via a `transition-[left,bottom]` wrapper — see
 * rotation.ts's doc comment) has actually finished, since nothing else
 * re-triggers a mutation once the animation itself settles. Rounds to whole
 * pixels so subpixel layout-read jitter between two consecutive reads of a
 * genuinely static element doesn't register as "still moving". Sorted so a
 * querySelectorAll traversal-order difference between samples can't produce
 * a spurious mismatch.
 */
export function boundsFingerprint(entries: FingerprintEntry[]): string {
  return entries
    .map((e) => `${e.id}:${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)},${Math.round(e.height)}`)
    .sort()
    .join("|");
}

export interface SettleLoopOptions {
  /** Takes a fresh geometry snapshot — real callers pass boundsFingerprint(captured DOM rects); tests pass a fake. */
  sample: () => string;
  onSettled: () => void;
  intervalMs: number;
  /** Give up and call onSettled anyway after this many checks, so a genuinely never-settling element (e.g. a continuous animation) can't block forever. */
  maxAttempts: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface SettleLoopHandle {
  /** Stops the loop; onSettled is guaranteed not to fire after this, even if a check was already in flight. */
  cancel(): void;
}

/**
 * Repeatedly samples geometry a beat apart until two consecutive samples
 * agree (or maxAttempts is reached), then calls onSettled exactly once.
 * DOM-free and timer-injectable so it's testable with fake timers without a
 * real DOM/browser — card-observer.ts supplies the real
 * getBoundingClientRect()-based `sample` and is otherwise thin glue around
 * this, matching this repo's "pure logic tested, DOM glue thin" pattern
 * (see rotation.ts / relay-socket.ts's injectable WebSocket factory).
 */
export function runSettleLoop(options: SettleLoopOptions): SettleLoopHandle {
  const { sample, onSettled, intervalMs, maxAttempts, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = options;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = (attempt: number): void => {
    const before = sample();
    timer = setTimeoutFn(() => {
      if (cancelled) return;
      const after = sample();
      if (after === before || attempt >= maxAttempts) {
        onSettled();
      } else {
        step(attempt + 1);
      }
    }, intervalMs);
  };
  step(0);

  return {
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) clearTimeoutFn(timer);
    },
  };
}
