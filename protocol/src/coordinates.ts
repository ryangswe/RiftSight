import type { NormalizedBounds } from "./types.js";

// `bounds` describes the element's post-transform axis-aligned bounding box
// (i.e. getBoundingClientRect()) — NOT a rotated quad. A rotated card's true
// silhouette is a parallelogram, but bounds only ever encloses it in a
// rectangle. Consumers apply `rotation` on top of this box themselves (e.g.
// a CSS `transform: rotate()` on the rendered hitbox). This module does not
// attempt to encode rotated geometry more precisely than that.

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a pixel rect to a 0..1 fraction of the given viewport, clamped to
 * the viewport's edges — a card that's partially off-screen (e.g. a
 * hand-fan card peeking above the top edge) gets its normalized rect
 * clipped rather than left with a negative x/y. Returns null for degenerate
 * input (non-positive viewport or card dimensions, or a rect that's
 * entirely off-screen) rather than emitting nonsensical coordinates.
 */
export function normalizeBounds(
  pixel: PixelBounds,
  viewport: { width: number; height: number }
): NormalizedBounds | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (pixel.width <= 0 || pixel.height <= 0) return null;

  const clampedLeft = clamp(pixel.x, 0, viewport.width);
  const clampedTop = clamp(pixel.y, 0, viewport.height);
  const clampedRight = clamp(pixel.x + pixel.width, 0, viewport.width);
  const clampedBottom = clamp(pixel.y + pixel.height, 0, viewport.height);

  const width = clampedRight - clampedLeft;
  const height = clampedBottom - clampedTop;
  if (width <= 0 || height <= 0) return null; // fully off-screen

  return {
    x: clampedLeft / viewport.width,
    y: clampedTop / viewport.height,
    width: width / viewport.width,
    height: height / viewport.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface CssPercentBounds {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** Maps normalized [0,1] bounds to CSS percentage strings for absolute positioning. */
export function boundsToCssPercent(bounds: NormalizedBounds): CssPercentBounds {
  return {
    left: `${bounds.x * 100}%`,
    top: `${bounds.y * 100}%`,
    width: `${bounds.width * 100}%`,
    height: `${bounds.height * 100}%`,
  };
}
