import { boundsToCssPercent, type OverlayCard } from "@riftsight/protocol";

export interface HitboxStyle {
  left: string;
  top: string;
  width: string;
  height: string;
  zIndex: string;
}

/**
 * Pure geometry mapping — no DOM mutation here so it's directly testable.
 * `bounds` is already the card's post-transform axis-aligned bounding box
 * (see protocol's coordinates.ts doc comment — it comes straight from
 * getBoundingClientRect() on the rotated card), so it's rendered directly
 * with no further CSS rotation: applying `rotate()` on top of an
 * already-rotated AABB would rotate it a second time. `card.rotation` is
 * intentionally not read here — it's retained on OverlayCard as metadata
 * (e.g. for debug tooling) but must not affect hitbox geometry.
 */
export function computeHitboxStyle(card: OverlayCard): HitboxStyle {
  const percent = boundsToCssPercent(card.bounds);
  return {
    left: percent.left,
    top: percent.top,
    width: percent.width,
    height: percent.height,
    zIndex: card.zIndex !== undefined ? String(card.zIndex) : "0",
  };
}

export function hitboxClassName(card: OverlayCard): string {
  if (card.visibility === "hidden") return "hitbox hidden-card";
  if (card.visibility === "unknown") return "hitbox unknown-card";
  return "hitbox";
}

/** Debug label text — never includes identity for a non-public card, since cardId/name are already undefined on the wire for those. */
export function hitboxLabel(card: OverlayCard): string {
  const parts: string[] = [card.zone, card.owner, card.visibility];
  if (card.cardId) parts.push(card.cardId);
  return parts.join("/");
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
}

/**
 * Positions a popup next to the hovered hitbox rather than following the
 * cursor — anchored to the right of the card by default (so it doesn't sit
 * on top of the thing being hovered), flipping to the left when there
 * isn't room on the right, vertically aligned with the card's top edge and
 * shifted/clamped so it never overflows the viewport on any side. Shared by
 * both the real Twitch viewer popup and debug-viewer's own tooltip.
 */
export function computeTooltipPosition(target: Rect, tooltipSize: Size, viewport: Size, gap = 8): TooltipPosition {
  const rightLeft = target.left + target.width + gap;
  const leftLeft = target.left - tooltipSize.width - gap;
  const fitsRight = rightLeft + tooltipSize.width <= viewport.width;
  const fitsLeft = leftLeft >= 0;

  // Prefer the right side; only flip to the left when the right side
  // genuinely doesn't fit but the left side does — otherwise keep the
  // right-side placement and let the clamps below pull it back on-screen
  // (unavoidable overlap with the card is preferable to placing the popup
  // off the opposite edge instead).
  let left = fitsRight || !fitsLeft ? rightLeft : leftLeft;
  const maxLeft = viewport.width - tooltipSize.width - 4;
  left = Math.min(Math.max(left, 4), maxLeft);

  const maxTop = viewport.height - tooltipSize.height - 4;
  const top = Math.min(Math.max(target.top, 4), maxTop);

  return { left, top };
}
