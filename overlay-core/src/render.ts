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
 * testable and reusable by computeOcclusionClips below (which needs raw
 * numbers across many cards, not per-card percent strings). `bounds` is
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

export interface OcclusionBox extends NormalizedBox {
  /** Same value computeHitboxStyle's own `zIndex` output is derived from (card.zIndex ?? 0) — this function's "is other on top of me" test must use the identical stacking rule the browser will actually apply, or the clip and the real CSS stacking could disagree. */
  zIndex: number;
}

export interface EdgeClips {
  /** Each a 0–1 fraction of that edge's own dimension (this box's own height for top/bottom, width for left/right) — matches clip-path: inset(top right bottom left)'s own percentage semantics directly. */
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * For each box, computes how much to clip from each of its four edges to
 * exclude the region covered by higher-stacked boxes that overlap it.
 *
 * Two overlapping rectangles normally overlap in *both* axes at once —
 * e.g. two same-row hand cards share a y-range as well as an x-range —
 * so per-pair, this picks a single resolution axis via the actual 2D
 * overlap rectangle's smaller dimension (the "minimum penetration axis",
 * the same idea 2D collision resolution uses): if the overlap is wider
 * than it is tall, treat it as horizontal encroachment (clip left/right);
 * otherwise vertical (clip top/bottom). Only ever clips one edge per pair
 * — checking all four edges independently per pair (an earlier version
 * of this function did) double-counts a single overlap as both a
 * horizontal *and* vertical encroachment whenever two boxes happen to
 * share a full edge (e.g. an exact-same-height row), which is wrong.
 *
 * This is not full polygon subtraction (see this milestone's plan for
 * why: clip-path: inset() can only produce an axis-aligned smaller
 * rectangle, so a genuinely diagonal/corner-only overlap gets resolved
 * along whichever axis has the smaller penetration rather than precisely
 * notched out — a reasonable single-axis approximation, not exact, but
 * far simpler than true rotated-polygon geometry). Ties in zIndex are
 * broken by array index (later = on top), matching computeHitboxStyle's
 * own convention and the browser's default same-z-index stacking (later
 * in DOM = on top).
 *
 * Returns one EdgeClips per input box, same order as `boxes`.
 */
export function computeOcclusionClips(boxes: readonly OcclusionBox[]): EdgeClips[] {
  const isAbove = (otherIndex: number, index: number): boolean => {
    const other = boxes[otherIndex]!;
    const box = boxes[index]!;
    if (other.zIndex !== box.zIndex) return other.zIndex > box.zIndex;
    return otherIndex > index;
  };

  return boxes.map((box, index) => {
    let exposedLeft = box.left;
    let exposedRight = box.left + box.width;
    let exposedTop = box.top;
    let exposedBottom = box.top + box.height;

    for (let otherIndex = 0; otherIndex < boxes.length; otherIndex++) {
      if (otherIndex === index || !isAbove(otherIndex, index)) continue;
      const other = boxes[otherIndex]!;

      const overlapLeft = Math.max(box.left, other.left);
      const overlapRight = Math.min(box.left + box.width, other.left + other.width);
      const overlapTop = Math.max(box.top, other.top);
      const overlapBottom = Math.min(box.top + box.height, other.top + other.height);
      if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) continue; // no genuine 2D overlap

      const overlapWidth = overlapRight - overlapLeft;
      const overlapHeight = overlapBottom - overlapTop;
      const otherCenterX = other.left + other.width / 2;
      const otherCenterY = other.top + other.height / 2;
      const boxCenterX = box.left + box.width / 2;
      const boxCenterY = box.top + box.height / 2;

      if (overlapWidth <= overlapHeight) {
        if (otherCenterX >= boxCenterX) {
          if (overlapLeft < exposedRight) exposedRight = overlapLeft;
        } else {
          if (overlapRight > exposedLeft) exposedLeft = overlapRight;
        }
      } else {
        if (otherCenterY >= boxCenterY) {
          if (overlapTop < exposedBottom) exposedBottom = overlapTop;
        } else {
          if (overlapBottom > exposedTop) exposedTop = overlapBottom;
        }
      }
    }

    exposedRight = Math.max(exposedRight, exposedLeft);
    exposedBottom = Math.max(exposedBottom, exposedTop);

    return {
      top: box.height > 0 ? (exposedTop - box.top) / box.height : 0,
      right: box.width > 0 ? 1 - (exposedRight - box.left) / box.width : 0,
      bottom: box.height > 0 ? 1 - (exposedBottom - box.top) / box.height : 0,
      left: box.width > 0 ? (exposedLeft - box.left) / box.width : 0,
    };
  });
}

/** CSS clip-path value for a given EdgeClips — "" (no clip-path) when all four are zero, so callers can assign it directly without a conditional. */
export function formatOcclusionClipPath(clips: EdgeClips): string {
  if (clips.top === 0 && clips.right === 0 && clips.bottom === 0 && clips.left === 0) return "";
  const pct = (fraction: number) => `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return `inset(${pct(clips.top)} ${pct(clips.right)} ${pct(clips.bottom)} ${pct(clips.left)})`;
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
