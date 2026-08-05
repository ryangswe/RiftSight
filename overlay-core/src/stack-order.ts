/**
 * Shared stack-order comparator — used by both rendering (computeOcclusionClips's
 * z-index handling in render.ts) and hit-testing (resolveHoveredCard in
 * quad.ts) so the two share one definition instead of two copies that
 * could silently drift apart. Lives in its own file rather than either
 * render.ts or quad.ts specifically: quad.ts already depends on render.ts
 * (for computeHitboxBox), so render.ts importing back from quad.ts would
 * create a circular dependency between the two.
 *
 * Positive means `a` is stacked above `b` (renders on top); matches the
 * browser's own default same-z-index behavior (later in DOM/array order
 * wins) whenever zIndex is absent or tied.
 */
export function compareStackOrder(a: { zIndex: number }, indexA: number, b: { zIndex: number }, indexB: number): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  return indexA - indexB;
}
