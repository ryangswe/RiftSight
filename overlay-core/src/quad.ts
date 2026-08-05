import type { OverlayCard } from "@riftsight/protocol";
import { computeHitboxBox } from "./render.js";
import { compareStackOrder } from "./stack-order.js";

export interface Point {
  x: number;
  y: number;
}

/** Four corners of a card's true rotated shape, in pixel space (see computeCardQuad's doc comment for why pixel space specifically). Order: top-left, top-right, bottom-right, bottom-left of the *unrotated* card, each individually rotated — consistent winding, required for pointInConvexQuad's edge test. */
export interface CardQuad {
  points: [Point, Point, Point, Point];
}

export interface StageSize {
  width: number;
  height: number;
}

/**
 * Reconstructs a card's true rotated shape as four corner points, in pixel
 * space. `card` should already be region-mapped (via mapBoundsToSourceRegion
 * / mapSizeToSourceRegion) exactly as renderHitboxes() does before calling
 * computeHitboxBox — this function doesn't do that mapping itself.
 *
 * Deliberately does the rotation math in pixel space, not raw normalized
 * [0,1] stage fractions: sin/cos rotation is only geometrically correct in
 * a coordinate space where x and y units represent the same physical
 * distance. The stage is not square (a 16:9 video frame), so a card's
 * normalized width and height fractions don't correspond to equal real
 * distances — rotating directly in that distorted space would visibly
 * skew the angle, not just introduce a minor rounding error (this is the
 * same class of issue already flagged as ASPECT_RATIO_TOLERANCE for the
 * CSS-transform path, but there the browser does the actual rotation in
 * real rendered pixels regardless of the stage's normalized coordinate
 * system — here there's no browser doing that for us, so getting the
 * space right is load-bearing, not cosmetic). Converting to pixel space
 * via `stageSize` first, rotating there, and returning pixel coordinates
 * throughout means the result composes directly with pointer events
 * (clientX/clientY, getBoundingClientRect()) with no further conversion.
 *
 * Uses the exact same center/local-size derivation computeHitboxBox
 * already established for the (still-current) box-based rendering path —
 * only the output shape differs (four rotated corners vs. an axis-aligned
 * box).
 */
export function computeCardQuad(card: OverlayCard, stageSize: StageSize): CardQuad {
  const box = computeHitboxBox(card);
  const centerX = (box.left + box.width / 2) * stageSize.width;
  const centerY = (box.top + box.height / 2) * stageSize.height;
  const halfWidthPx = (box.width / 2) * stageSize.width;
  const halfHeightPx = (box.height / 2) * stageSize.height;

  // Standard 2D rotation matrix, applied directly in pixel/screen
  // coordinates (y increasing downward, matching DOM client coordinates)
  // — this produces the same clockwise-for-positive-degrees rotation CSS
  // transform: rotate() applies, with no sign flip needed.
  const angleRad = (card.rotation * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const localCorners: Point[] = [
    { x: -halfWidthPx, y: -halfHeightPx },
    { x: halfWidthPx, y: -halfHeightPx },
    { x: halfWidthPx, y: halfHeightPx },
    { x: -halfWidthPx, y: halfHeightPx },
  ];
  const points = localCorners.map(({ x, y }) => ({
    x: centerX + x * cos - y * sin,
    y: centerY + x * sin + y * cos,
  })) as [Point, Point, Point, Point];

  return { points };
}

/**
 * Same-sign-cross-product test against each of the quad's four edges —
 * valid because a rotated rectangle is always convex, regardless of
 * winding direction as long as it's consistent (computeCardQuad always
 * produces the same winding). A point exactly on an edge is treated as
 * inside (a zero cross product doesn't flip the running sign) — a
 * deliberate, documented inclusive-boundary convention, not an
 * unconsidered default.
 */
export function pointInConvexQuad(point: Point, quad: CardQuad): boolean {
  const { points } = quad;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const toPointX = point.x - a.x;
    const toPointY = point.y - a.y;
    const cross = edgeX * toPointY - edgeY * toPointX;
    if (cross === 0) continue;
    const currentSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

export interface HoverCandidate {
  card: OverlayCard;
  quad: CardQuad;
  zIndex: number;
}

/**
 * Filters to candidates whose true rotated quad actually contains `point`,
 * then returns whichever has the highest effective stack rank (per
 * compareStackOrder, using each candidate's position in `candidates` as
 * the paint-order tiebreak) — or null if none contain the point. Built
 * now, ahead of Phase 2's interaction wiring, so the diagnostic can show
 * "what the new model would resolve" alongside what's actually showing
 * today, without changing any real behavior yet.
 */
export function resolveHoveredCard(point: Point, candidates: readonly HoverCandidate[]): OverlayCard | null {
  let best: HoverCandidate | null = null;
  let bestIndex = -1;
  candidates.forEach((candidate, index) => {
    if (!pointInConvexQuad(point, candidate.quad)) return;
    if (!best || compareStackOrder(candidate, index, best, bestIndex) > 0) {
      best = candidate;
      bestIndex = index;
    }
  });
  return best ? (best as HoverCandidate).card : null;
}
