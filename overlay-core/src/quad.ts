import type { NormalizedBounds, OverlayCard } from "@riftsight/protocol";
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
 * Direct 4-corner rectangle, never rotated — for non-card geometry (a
 * dialog's own bounding rect) that still needs to hit-test via
 * pointInConvexQuad. `bounds` must already be region-mapped, same contract
 * as computeCardQuad.
 */
export function computeRectQuad(bounds: NormalizedBounds, stageSize: StageSize): CardQuad {
  const left = bounds.x * stageSize.width;
  const top = bounds.y * stageSize.height;
  const width = bounds.width * stageSize.width;
  const height = bounds.height * stageSize.height;
  return {
    points: [
      { x: left, y: top },
      { x: left + width, y: top },
      { x: left + width, y: top + height },
      { x: left, y: top + height },
    ],
  };
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
 * the paint-order tiebreak) — or null if none contain the point.
 *
 * Dialog candidates (fromDialog: true) are resolved as their own separate
 * group, and any one of them matching `point` at all wins outright over
 * every background candidate, regardless of raw zIndex. This is not
 * optional: detectDialogCards publishes a flat, low zIndex for every card
 * it produces (see card-detector.ts), while a background board card's
 * zIndex is a real, often much larger CSS value — comparing the two
 * groups by magnitude in one pool let an arbitrary background card behind
 * a dialog card win the point purely on zIndex, which live testing showed
 * makes a dialog's own card hoverable only in the sliver where no
 * background card happens to occupy the same screen position, exactly
 * backwards from a dialog always being the topmost thing actually painted
 * there. A dialog card is therefore never suppressed and never has to
 * out-rank anything outside its own group.
 *
 * `blockingRegion`, when given, is the active dialog's own bounding quad
 * (see card-detector.ts's detectCards / OverlayState.blockingRegion),
 * checked only once no dialog candidate matched `point` at all. The
 * winning background candidate is suppressed (null) rather than returned
 * when it falls inside that region — it's genuinely there and clickable
 * in the DOM, but visually painted over by the dialog in the actual
 * video, so showing its tooltip would be misleading. A background card
 * outside the region is unaffected.
 */
export function resolveHoveredCard(
  point: Point,
  candidates: readonly HoverCandidate[],
  blockingRegion?: CardQuad
): OverlayCard | null {
  let bestDialog: HoverCandidate | null = null;
  let bestDialogIndex = -1;
  let bestBackground: HoverCandidate | null = null;
  let bestBackgroundIndex = -1;

  candidates.forEach((candidate, index) => {
    if (!pointInConvexQuad(point, candidate.quad)) return;
    if (candidate.card.fromDialog) {
      if (!bestDialog || compareStackOrder(candidate, index, bestDialog, bestDialogIndex) > 0) {
        bestDialog = candidate;
        bestDialogIndex = index;
      }
    } else if (!bestBackground || compareStackOrder(candidate, index, bestBackground, bestBackgroundIndex) > 0) {
      bestBackground = candidate;
      bestBackgroundIndex = index;
    }
  });

  if (bestDialog) return (bestDialog as HoverCandidate).card;
  if (!bestBackground) return null;
  const winner = bestBackground as HoverCandidate;
  if (blockingRegion && pointInConvexQuad(point, blockingRegion)) return null;
  return winner.card;
}
