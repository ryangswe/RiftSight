// Pure rotation-extraction math for card-detector.ts. Kept separate and
// DOM-free so the string/matrix parsing is directly unit-testable without a
// browser environment.
//
// DOM ASSUMPTION, established from a live capture of a tapped/rotated
// battlefield unit (see project notes): RiftAtlas does not, in general, put
// rotation on the [data-card-id] anchor element itself — an earlier
// unrelated capture found rotation directly on the anchor (a hand-fan
// card's small tilt, via computed `matrix(...)`), but for a rotated
// battlefield unit it was found three levels up, on the position-transition
// wrapper (`div.absolute.transition-[left,bottom]...`), as an inline
// `transform: rotate(90deg)`. There's no single fixed hop count that works
// for every zone, so resolveRotation() (in card-detector.ts) searches
// outward from the anchor — checking the anchor first, then each ancestor
// in turn, up to a bounded depth.
//
// It used to stop at the first ancestor that carried any rotation at all,
// on the assumption that only one ancestor in the chain would ever have
// one. A live capture of the OPPONENT's board disproved that: RiftAtlas
// wraps every opponent zone in an ancestor one level *nearer* the anchor
// than a landscape card's own rotate(90deg) wrapper, carrying a standalone
// `rotate: 180deg` (Tailwind's `rotate-180` utility) — a perspective
// correction, presumably because the opponent's cards are logically laid
// out mirrored/upside-down (as if viewed from across the table) and this
// flips them back upright for the local viewer. Stopping at the first
// contribution found 180 alone, not the composed 270 (normalized -90) — and
// since a rectangle rotated 180° is visually indistinguishable from one not
// rotated at all, that read as "the opponent's landscape hitboxes aren't
// rotated," exactly the bug reported. resolveRotation now sums every
// contribution it finds across the whole walk (see composeRotations below)
// instead of stopping at the first — a no-op for the player's own side,
// where only one ancestor ever carries a rotation.
//
// Also confirmed empirically: `data-preview-rotation` (what the old
// parseRotation() read) stays "0" even on visibly rotated cards — it
// appears to govern the hover-preview panel's own orientation, not the
// card's live board transform, so it's no longer used as a rotation source.

const ROTATE_FUNCTION_PATTERN = /rotate\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/;
const TRAILING_DEG_PATTERN = /(-?\d+(?:\.\d+)?)deg\s*$/;

/** Extracts degrees from a `rotate(Ndeg)` function appearing anywhere in a transform string (inline or computed). Exact — no matrix decomposition, so no float noise. */
export function parseRotateFunction(transform: string): number | undefined {
  const match = transform.match(ROTATE_FUNCTION_PATTERN);
  if (!match || match[1] === undefined) return undefined;
  return Number.parseFloat(match[1]);
}

/** Parses the standalone CSS Transforms Level 2 `rotate` property's computed value (e.g. "90deg"). "none"/empty means the property isn't set. */
export function parseStandaloneRotate(rotate: string): number | undefined {
  if (!rotate || rotate === "none") return undefined;
  const match = rotate.match(TRAILING_DEG_PATTERN);
  if (!match || match[1] === undefined) return undefined;
  return Number.parseFloat(match[1]);
}

/**
 * Decomposes a computed `transform` value's in-plane rotation angle from
 * either a 2D `matrix(a, b, c, d, e, f)` or a 3D `matrix3d(...)`. For a
 * pure Z-axis rotation, both encode cosθ/sinθ in the same first two
 * positions — CSS's matrix3d() argument list is column-major, and a
 * Z-rotation's first column is (cosθ, sinθ, 0, 0) — so one atan2 works for
 * both forms. Ignores any translation/scale/skew beyond what that implies,
 * which is sufficient for RiftAtlas's card transforms (they only ever
 * combine position and rotation).
 */
export function rotationFromMatrixString(transform: string): number | undefined {
  if (!transform || transform === "none") return undefined;

  const raw = transform.match(/^matrix\(([^)]+)\)$/)?.[1] ?? transform.match(/^matrix3d\(([^)]+)\)$/)?.[1];
  if (!raw) return undefined;

  const values = raw.split(",").map((v) => Number.parseFloat(v.trim()));
  const cos = values[0];
  const sin = values[1];
  if (cos === undefined || sin === undefined || Number.isNaN(cos) || Number.isNaN(sin)) return undefined;

  return (Math.atan2(sin, cos) * 180) / Math.PI;
}

/**
 * Rounds to the nearest whole degree and wraps into (-180, 180] so
 * equivalent angles (e.g. 270 vs -90) come out consistently and float
 * noise (89.999998) disappears.
 */
export function normalizeDegrees(angle: number): number {
  let normalized = Math.round(angle) % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return normalized;
}

export interface ElementTransformInfo {
  computedRotate: string;
  inlineTransform: string;
  computedTransform: string;
}

/**
 * Resolves one element's own rotation contribution, or undefined if it
 * carries no transform-related value at all (the caller should then check
 * the next ancestor outward). Priority: the standalone `rotate` property,
 * then a `rotate()` token in the inline transform — both exact, no
 * matrix decomposition needed — then the computed transform's matrix as a
 * fallback, which is authoritative but can introduce float noise (handled
 * by normalizeDegrees).
 */
export function resolveElementRotationDeg(info: ElementTransformInfo): number | undefined {
  const standalone = parseStandaloneRotate(info.computedRotate);
  if (standalone !== undefined) return normalizeDegrees(standalone);

  const inlineRotate = parseRotateFunction(info.inlineTransform);
  if (inlineRotate !== undefined) return normalizeDegrees(inlineRotate);

  const matrixRotate = rotationFromMatrixString(info.computedTransform);
  if (matrixRotate !== undefined) return normalizeDegrees(matrixRotate);

  return undefined;
}

/**
 * Sums every ancestor's own rotation contribution (as resolveRotation's
 * walk collects them, nearest-to-anchor first) into one net rotation. Pure
 * addition, not a matrix multiply — for in-plane (Z-axis-only) rotations,
 * which is all RiftAtlas's card transforms ever are, nested CSS transforms
 * compose additively regardless of order, so summation is exact, not an
 * approximation. Empty input (no ancestor carried any rotation at all)
 * returns 0, matching resolveRotation's original no-rotation default.
 */
export function composeRotations(contributions: readonly number[]): number {
  if (contributions.length === 0) return 0;
  return normalizeDegrees(contributions.reduce((sum, deg) => sum + deg, 0));
}
