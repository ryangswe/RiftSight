import type { OverlayCard } from "@riftsight/protocol";

export interface TooltipContent {
  lines: string[];
  /** Only ever set for a public card — mirrors the wire-level guarantee, checked again here explicitly (defense in depth). */
  imageUrl: string | undefined;
}

/**
 * Explicitly branches on `visibility` rather than relying solely on which
 * fields happen to be present — so a future protocol version that adds a
 * new identity-adjacent field can't silently leak through here by
 * omission. Includes the card's actual art for public cards (not just
 * runes) since alt-art ambiguity applies to legends/champions/units too —
 * seeing the real image is the most direct way to confirm exactly which
 * card/art variant is on screen.
 */
export function tooltipContentFor(card: OverlayCard): TooltipContent {
  if (card.visibility !== "public") {
    return { lines: ["Hidden card"], imageUrl: undefined };
  }

  const lines = [card.name ?? card.cardId ?? card.instanceId];
  if (card.cardId) lines.push(card.cardId);
  lines.push(`${card.zone} · ${card.owner}`);

  return { lines, imageUrl: card.imageUrl };
}
