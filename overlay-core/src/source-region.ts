import type { NormalizedBounds, SourceRegion } from "@riftsight/protocol";

// Maps RiftAtlas-relative card bounds into wherever RiftAtlas actually
// sits within the final Twitch stream canvas — a broadcaster-calibrated
// rectangle, not anything derived from OverlayState. This is deliberately
// a direct rectangular mapping only: it assumes the broadcaster selects
// the exact final rectangle RiftAtlas is displayed in (no automatic
// contain/cover/crop-edge/letterbox/perspective correction). Values are
// normalized [0,1] fractions of the stream canvas, same convention as
// NormalizedBounds itself.
//
// The SourceRegion TYPE now lives in @riftsight/protocol (it travels on
// the wire inside OverlayState.overlayConfig, so protocol owns its schema
// — see SourceRegionSchema). This module re-exports it and remains the
// home of everything that ISN'T wire shape: presets, validation with the
// friendly-fallback contract, and the coordinate mapping helpers.
// (protocol can't import from overlay-core — that would be a dependency
// cycle — which is why the type moved down rather than the helpers up.)
export type { SourceRegion } from "@riftsight/protocol";

export const FULL_FRAME_SOURCE_REGION: SourceRegion = { x: 0, y: 0, width: 1, height: 1 };

export const SOURCE_REGION_PRESETS: Record<"fullFrame" | "leftHalf" | "rightHalf" | "centered", SourceRegion> = {
  fullFrame: FULL_FRAME_SOURCE_REGION,
  leftHalf: { x: 0, y: 0, width: 0.5, height: 1 },
  rightHalf: { x: 0.5, y: 0, width: 0.5, height: 1 },
  centered: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
};

// Floating-point rounding tolerance for the two sum checks only — a
// region built from, say, repeated 1/3 divisions can land at
// 0.3333333333333333 + 0.6666666666666667 = 1.0000000000000002, which
// must not be rejected as "exceeds the frame" over a rounding artifact
// smaller than a screen pixel could ever represent.
const EPSILON = 1e-6;

export function isValidSourceRegion(region: SourceRegion): boolean {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;
  if (x < 0 || y < 0) return false;
  if (x + width > 1 + EPSILON) return false;
  if (y + height > 1 + EPSILON) return false;
  return true;
}

/**
 * Parses a stored/broadcaster-supplied source region, falling back to
 * FULL_FRAME_SOURCE_REGION for anything missing, malformed, or invalid —
 * a bad saved region must never crash the overlay for every viewer of
 * that channel (same "always returns something safe" contract as
 * parseOverlayConfig).
 */
export function parseSourceRegion(raw: unknown): SourceRegion {
  if (typeof raw !== "object" || raw === null) return FULL_FRAME_SOURCE_REGION;
  const obj = raw as Record<string, unknown>;
  const { x, y, width, height } = obj;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
    return FULL_FRAME_SOURCE_REGION;
  }
  const candidate: SourceRegion = { x, y, width, height };
  return isValidSourceRegion(candidate) ? candidate : FULL_FRAME_SOURCE_REGION;
}

/**
 * Pure linear remap of RiftAtlas-relative bounds into the calibrated
 * source region's own coordinate space within the stream canvas. Assumes
 * `sourceRegion` has already been validated (e.g. via parseSourceRegion at
 * config-parse time) — does no re-validation or clamping of its own, and
 * never reads `cardBounds` beyond x/y/width/height. `bounds` is already the
 * card's post-transform axis-aligned bounding box (see protocol's
 * coordinates.ts), so this scale/translate is all that's needed — rotation
 * (if present on the caller's card object) is retained as metadata only and
 * must not be reapplied as a further transform downstream.
 */
export function mapBoundsToSourceRegion(cardBounds: NormalizedBounds, sourceRegion: SourceRegion): NormalizedBounds {
  return {
    x: sourceRegion.x + cardBounds.x * sourceRegion.width,
    y: sourceRegion.y + cardBounds.y * sourceRegion.height,
    width: cardBounds.width * sourceRegion.width,
    height: cardBounds.height * sourceRegion.height,
  };
}

export interface NormalizedSize {
  width: number;
  height: number;
}

/**
 * Same per-axis scaling mapBoundsToSourceRegion applies to bounds, for a
 * plain size (no x/y — sizes don't get the sourceRegion.x/y translation).
 * Used alongside mapBoundsToSourceRegion for a card's true unrotated
 * size (see protocol's localWidth/localHeight), so the box a hitbox is
 * rotated at goes through the same broadcaster-calibrated mapping bounds
 * already do.
 */
export function mapSizeToSourceRegion(size: NormalizedSize, sourceRegion: SourceRegion): NormalizedSize {
  return {
    width: size.width * sourceRegion.width,
    height: size.height * sourceRegion.height,
  };
}
