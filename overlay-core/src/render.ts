import { boundsToCssPercent, type OverlayCard } from "@riftsight/protocol";

export interface HitboxStyle {
  left: string;
  top: string;
  width: string;
  height: string;
  zIndex: string;
  /** CSS `transform` value, e.g. "rotate(8deg)" — omitted (undefined) whenever rotation is 0, so callers can skip setting it. */
  transform: string | undefined;
  /** Always "center" when transform is set — a rotation only reproduces the card's true shape when it pivots around the same center point `left`/`top`/`width`/`height` were computed from below. */
  transformOrigin: string | undefined;
}

export interface NormalizedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Pure geometry — no DOM mutation, no formatting, so it's directly
 * testable and reusable wherever raw numbers are needed instead of
 * per-card percent strings (e.g. quad.ts's computeCardQuad, which starts
 * from this same center/size derivation). `bounds` is
 * the card's post-transform axis-aligned bounding box (see protocol's
 * coordinates.ts) — inflated relative to the card's true shape whenever
 * it's rotated, but its *center* still always coincides with the true
 * card's own center (a rigid rotation of a rectangle about any pivot
 * still individually rotates that rectangle by the same net angle about
 * its own center — see this milestone's plan for the fuller argument).
 * `card.localWidth`/`localHeight` (already region-mapped by the caller,
 * same as `card.bounds`) are the card's true unrotated size. Combining the
 * AABB's center with the true size reproduces the card's actual
 * pre-rotation box — rotating `bounds` itself here (its own width/height)
 * would double up the inflation already baked into it, which is exactly
 * the bug an earlier version of this module avoided by disabling rotation
 * entirely. `localWidth`/`localHeight` fall back to `bounds.width`/`height`
 * when absent (older callers/fixtures) — with rotation 0 that's already
 * correct, and non-zero rotation without a real local size is not a case
 * any real caller produces.
 */
export function computeHitboxBox(card: OverlayCard): NormalizedBox {
  const localWidth = card.localWidth ?? card.bounds.width;
  const localHeight = card.localHeight ?? card.bounds.height;
  const centerX = card.bounds.x + card.bounds.width / 2;
  const centerY = card.bounds.y + card.bounds.height / 2;
  return {
    left: centerX - localWidth / 2,
    top: centerY - localHeight / 2,
    width: localWidth,
    height: localHeight,
  };
}

export function computeHitboxStyle(card: OverlayCard): HitboxStyle {
  const box = computeHitboxBox(card);
  const percent = boundsToCssPercent({ x: box.left, y: box.top, width: box.width, height: box.height });
  return {
    left: percent.left,
    top: percent.top,
    width: percent.width,
    height: percent.height,
    zIndex: card.zIndex !== undefined ? String(card.zIndex) : "0",
    transform: card.rotation ? `rotate(${card.rotation}deg)` : undefined,
    transformOrigin: card.rotation ? "center" : undefined,
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
