import type { OverlayCard } from "./types.js";

/**
 * Deterministic fingerprint of a card set + viewport, deliberately taking
 * only these two inputs — capturedAt/sequence are structurally excluded
 * from equality by never being passed in here, not filtered out after the
 * fact. Sorted by instanceId so input order never affects the result.
 * Bounds are rounded to damp sub-pixel float jitter between renders that
 * shouldn't count as a "real" change.
 */
export function fingerprintCards(
  cards: OverlayCard[],
  viewport: { width: number; height: number; devicePixelRatio: number }
): string {
  const sorted = [...cards].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const canonical = sorted.map((card) => ({
    instanceId: card.instanceId,
    cardId: card.cardId ?? null,
    name: card.name ?? null,
    imageUrl: card.imageUrl ?? null,
    zone: card.zone,
    owner: card.owner,
    visibility: card.visibility,
    bounds: roundBounds(card.bounds),
    rotation: card.rotation,
    zIndex: card.zIndex ?? null,
  }));
  return JSON.stringify({ viewport, cards: canonical });
}

function roundBounds(bounds: OverlayCard["bounds"]): OverlayCard["bounds"] {
  const round = (n: number) => Math.round(n * 10_000) / 10_000; // ~sub-pixel at typical viewport sizes
  return { x: round(bounds.x), y: round(bounds.y), width: round(bounds.width), height: round(bounds.height) };
}
