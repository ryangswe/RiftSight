import { boundsToCssPercent, type OverlayCard } from "@riftsight/protocol";

export interface HitboxStyle {
  left: string;
  top: string;
  width: string;
  height: string;
  transform: string;
  zIndex: string;
}

/**
 * Pure geometry mapping — no DOM mutation here so it's directly testable.
 * `bounds` is the card's axis-aligned bounding box (see protocol's
 * coordinates.ts doc comment); rotation is layered on top as a CSS
 * transform, which is an approximation for a rotated card's true
 * silhouette, not exact geometry.
 */
export function computeHitboxStyle(card: OverlayCard): HitboxStyle {
  const percent = boundsToCssPercent(card.bounds);
  return {
    left: percent.left,
    top: percent.top,
    width: percent.width,
    height: percent.height,
    transform: card.rotation ? `rotate(${card.rotation}deg)` : "",
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
 * Positions a tooltip next to the hovered hitbox rather than following the
 * cursor — anchored just above the card by default, flipping below when
 * there isn't room above, and clamped horizontally within the viewport.
 * This is a reasonable default for a debug tool; real stream-safe-zone
 * placement is a later concern once this feeds an actual Twitch overlay.
 */
export function computeTooltipPosition(target: Rect, tooltipSize: Size, viewport: Size, gap = 8): TooltipPosition {
  let top = target.top - tooltipSize.height - gap;
  if (top < 0) {
    top = target.top + target.height + gap;
  }

  const maxLeft = viewport.width - tooltipSize.width - 4;
  let left = target.left;
  if (left > maxLeft) left = maxLeft;
  if (left < 4) left = 4;

  return { left, top };
}
