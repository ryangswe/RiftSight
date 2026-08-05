// Pure, DOM-free parsing of a card's shared 3D-flip container's computed
// `transform` into a face-facing classification. Mirrors rotation.ts's
// existing split of pure matrix math from card-detector.ts's DOM glue.
//
// CONFIRMED via live DevTools inspection of a real RiftAtlas session: every
// multi-face card renders a front-face wrapper (implicitly rotateY(0deg))
// and a cardback wrapper (a static, always-present rotateY(180deg)) as two
// sibling elements, each with `backface-visibility: hidden`, under one
// shared `transform-style: preserve-3d` parent. That shared parent's own
// `transform` — toggled between an identity matrix and a rotateY(180deg)
// matrix — is what actually flips the card; the two children's own
// transforms never change. This was verified to agree with the old
// pixel-sampling approach on 14 real face-up cards and one genuinely
// face-down card (a hidden battlefield attachment), with zero
// disagreements — see this milestone's plan for the full capture.
//
// Reading this one CSS property is therefore a complete, occlusion-
// independent replacement for pixel sampling: it depends only on the
// card's own two children, never on what a different, overlapping card
// happens to be drawn on top of.

export type FaceFacing = "front" | "back" | "intermediate" | "unsupported";

/**
 * How close (in degrees) the shared parent's net Y-rotation must be to
 * 0deg or 180deg before this module commits to a definite front/back
 * verdict. Anything outside both windows is "intermediate" — covers a
 * genuine mid-flip-animation frame, not just floating-point noise (a
 * browser-computed matrix for the two static rest states is exact, no
 * noise in practice, but the tolerance is real defense-in-depth on top
 * of whatever settle/debounce logic already delays scanning until the
 * DOM stops changing).
 */
const FACING_TOLERANCE_DEG = 15;

/**
 * Extracts the net Y-axis rotation angle (degrees, in (-180, 180]) from a
 * CSS `transform` computed-style string, or undefined if the string
 * isn't a rotation this module knows how to interpret.
 *
 * "none" and an empty string both mean "no transform set" (0deg) — real
 * browsers only ever report computed `transform` as "none", never "",
 * but treating an empty string the same way costs nothing and avoids
 * depending on that never changing.
 *
 * An identity 2D `matrix(...)` also means 0deg: a plain 2D matrix cannot
 * encode a Y-axis rotation at all (that needs a 3D component), so its
 * mere presence instead of "none" isn't itself suspicious — this
 * module just has nothing to extract from it.
 *
 * `matrix3d(...)` is CSS's column-major flattening of the full 4x4
 * transform matrix. For a pure rotateY(θ) with no other transform
 * composed in, that reduces to cosθ at index 0 and sinθ at index 8 —
 * confirmed against the real captured matrix for rotateY(180deg),
 * `matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)`
 * (index 0 = -1 = cos180°, index 8 = 0 = sin180°). atan2 of those two
 * values recovers θ exactly as well for a genuine mid-flip angle as for
 * the two rest states — this function doesn't distinguish those, only
 * classifyFaceFacing does. A magnitude check (the cos/sin pair should
 * sit on the unit circle) rejects a matrix that's doing something else
 * entirely (scale, skew composed in) rather than silently guessing.
 */
export function extractYRotationDeg(transform: string): number | undefined {
  const trimmed = transform.trim();
  if (trimmed === "" || trimmed === "none") return 0;

  const matrix2d = trimmed.match(/^matrix\(([^)]+)\)$/);
  if (matrix2d) {
    const values = matrix2d[1]!.split(",").map((v) => Number.parseFloat(v.trim()));
    if (values.length !== 6 || values.some((v) => Number.isNaN(v))) return undefined;
    return 0;
  }

  const matrix3d = trimmed.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d) {
    const values = matrix3d[1]!.split(",").map((v) => Number.parseFloat(v.trim()));
    if (values.length !== 16 || values.some((v) => Number.isNaN(v))) return undefined;
    const cos = values[0]!;
    const sin = values[8]!;
    if (Math.abs(Math.hypot(cos, sin) - 1) > 0.05) return undefined;
    return (Math.atan2(sin, cos) * 180) / Math.PI;
  }

  return undefined;
}

/**
 * Classifies which face is toward the camera from the shared 3D-flip
 * parent's own computed `transform` alone — see this module's header.
 * "intermediate" is a genuine mid-flip angle; "unsupported" is anything
 * extractYRotationDeg couldn't interpret at all. card-detector.ts treats
 * both the same way: "unknown", fail-closed — never guesses public.
 */
export function classifyFaceFacing(transform: string): FaceFacing {
  const deg = extractYRotationDeg(transform);
  if (deg === undefined) return "unsupported";

  const distanceFromFront = Math.abs(deg);
  const distanceFromBack = 180 - distanceFromFront;

  if (distanceFromFront <= FACING_TOLERANCE_DEG) return "front";
  if (distanceFromBack <= FACING_TOLERANCE_DEG) return "back";
  return "intermediate";
}
