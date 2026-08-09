import { fingerprintCards } from "./fingerprint.js";
import { PROTOCOL_VERSION } from "./schema.js";
import type { NormalizedBounds, OverlayCard, OverlayState, Viewport } from "./types.js";

/**
 * Turns detection results into OverlayState snapshots: assigns
 * monotonically increasing sequence numbers and suppresses publishing when
 * nothing meaningfully changed. Pure and DOM-free — the browser-side
 * debouncing (MutationObserver + timer) lives in the extension; this class
 * is what's actually worth unit-testing (sequencing, dedup).
 */
export class OverlayStatePublisher {
  private sequence = 0;
  private lastFingerprint: string | null = null;

  constructor(private readonly sessionId: string) {}

  /**
   * Returns the next OverlayState to publish, or null if nothing
   * meaningfully changed since the last call. capturedAt/sequence are only
   * assigned after the fingerprint comparison, so they can never influence
   * whether a state is treated as a duplicate.
   */
  next(
    cards: OverlayCard[],
    viewport: Viewport,
    options: { blockingRegion?: NormalizedBounds; now?: number } = {}
  ): OverlayState | null {
    const { blockingRegion, now = Date.now() } = options;
    const fingerprint = fingerprintCards(cards, viewport, blockingRegion);
    if (fingerprint === this.lastFingerprint) return null;

    this.lastFingerprint = fingerprint;
    this.sequence += 1;

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sequence: this.sequence,
      capturedAt: now,
      sourceViewport: viewport,
      cards,
      blockingRegion,
    };
  }

  /** Clears dedup/sequencing state so the next next() call is unconditionally treated as new, regardless of whether it matches whatever was last published — e.g. after a fresh relay connection that has no memory of anything sent before it existed. */
  reset(): void {
    this.sequence = 0;
    this.lastFingerprint = null;
  }
}
