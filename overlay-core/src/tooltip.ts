import type { OverlayCard } from "@riftsight/protocol";

export interface TooltipMaxSize {
  maxWidthPx: number;
  maxHeightPx: number;
}

/**
 * Base (scale 1.0) tooltip art dimensions, in px — the single source of
 * truth for both card orientations. Landscape (battlefield-type, e.g.
 * Star Spring) art gets a larger box than portrait art at the same scale,
 * since the same box that comfortably fits a portrait unit/spell card
 * leaves landscape art looking noticeably smaller.
 */
const PORTRAIT_BASE_SIZE: TooltipMaxSize = { maxWidthPx: 320, maxHeightPx: 448 };
const LANDSCAPE_BASE_SIZE: TooltipMaxSize = { maxWidthPx: 400, maxHeightPx: 500 };

/**
 * Broadcaster-configurable tooltip size, expressed as a single scale
 * multiplier applied uniformly to whichever base size a card's own
 * `landscape` flag selects — preserves the existing portrait/landscape
 * size relationship (tuned above) rather than needing two independent
 * settings. `scale` is trusted to already be validated/clamped by the
 * caller (see config/overlay-config.ts's parseOverlayConfig); this
 * function does no clamping of its own.
 */
export function computeTooltipMaxSize(landscape: boolean, scale: number): TooltipMaxSize {
  const base = landscape ? LANDSCAPE_BASE_SIZE : PORTRAIT_BASE_SIZE;
  return { maxWidthPx: base.maxWidthPx * scale, maxHeightPx: base.maxHeightPx * scale };
}

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

export interface CardPopupContent {
  /** Only ever set for a public card. */
  imageUrl: string | undefined;
  /** Concise accessible label for the <img> itself — never the full zone/owner text. */
  altText: string;
  /** Shown in place of the image when there's none, or if it fails to load. */
  fallbackLabel: string;
}

/**
 * Content for the normal (non-debug) viewer popup, which shows just the
 * card's art — see tooltipContentFor for the fuller text used by
 * debug-viewer's own dev-facing tooltip. Same visibility branch/identity
 * guarantee as tooltipContentFor (checked independently here, not derived
 * from it), so a hidden card never leaks its name/art through this path
 * either.
 */
export function cardPopupContentFor(card: OverlayCard): CardPopupContent {
  if (card.visibility !== "public") {
    return { imageUrl: undefined, altText: "Hidden card", fallbackLabel: "Hidden card" };
  }

  const label = card.name ?? card.cardId ?? card.instanceId;
  return { imageUrl: card.imageUrl, altText: label, fallbackLabel: label };
}
