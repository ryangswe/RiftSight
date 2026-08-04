import { describe, expect, it } from "vitest";
import type { OverlayCard } from "@riftsight/protocol";
import { mapBoundsToSourceRegion, mapSizeToSourceRegion } from "./source-region.js";
import {
  computeHitboxBox,
  computeHitboxStyle,
  computeOcclusionClips,
  computeTooltipPosition,
  formatOcclusionClipPath,
  hitboxClassName,
  hitboxLabel,
  type OcclusionBox,
} from "./render.js";

function card(overrides: Partial<OverlayCard> = {}): OverlayCard {
  const bounds = overrides.bounds ?? { x: 0.25, y: 0.5, width: 0.1, height: 0.2 };
  return {
    instanceId: "card_1",
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds,
    rotation: 0,
    landscape: false,
    // Defaults to the AABB's own size — with rotation 0 this makes the
    // center-based geometry below reduce to exactly the old bounds-only
    // output, so most existing assertions don't need to change.
    localWidth: bounds.width,
    localHeight: bounds.height,
    ...overrides,
  };
}

describe("computeHitboxStyle", () => {
  it("maps normalized bounds to CSS percentages", () => {
    const style = computeHitboxStyle(card());
    expect(style.left).toBe("25%");
    expect(style.top).toBe("50%");
    expect(style.width).toBe("10%");
    expect(style.height).toBe("20%");
  });

  it("omits transform/transformOrigin when rotation is 0", () => {
    const style = computeHitboxStyle(card({ rotation: 0 }));
    expect(style.transform).toBeUndefined();
    expect(style.transformOrigin).toBeUndefined();
  });

  it("emits a rotate() transform, centered, whenever rotation is non-zero", () => {
    for (const rotation of [90, -90, 180, 8]) {
      const style = computeHitboxStyle(card({ rotation }));
      expect(style.transform).toBe(`rotate(${rotation}deg)`);
      expect(style.transformOrigin).toBe("center");
    }
  });

  it("defaults zIndex to 0 when the card has none", () => {
    expect(computeHitboxStyle(card()).zIndex).toBe("0");
  });

  it("passes through an explicit zIndex", () => {
    expect(computeHitboxStyle(card({ zIndex: 42 })).zIndex).toBe("42");
  });
});

// Regression coverage for the double-rotation bug, and its actual fix: a
// rotated card's `bounds` is only the enclosing axis-aligned box
// (getBoundingClientRect()), inflated relative to the card's true shape —
// rotating that inflated box a second time was the original bug. The fix
// is to use the AABB only for its *center* (which always coincides with
// the true card's own center, regardless of rotation) combined with the
// card's true unrotated size (localWidth/localHeight) and a single
// rotate(). At rotation 0 this must still degrade to exactly bounds, at
// every edge of the source viewport.
describe("computeHitboxStyle — rotated geometry", () => {
  const edgeBounds: Record<string, OverlayCard["bounds"]> = {
    "left edge": { x: 0, y: 0.4, width: 0.08, height: 0.18 },
    "right edge": { x: 0.9, y: 0.4, width: 0.08, height: 0.18 },
    "top edge": { x: 0.4, y: 0, width: 0.08, height: 0.18 },
    "bottom edge": { x: 0.4, y: 0.82, width: 0.08, height: 0.18 },
  };
  const rotations = [0, 90, -90, 180];

  for (const [edgeName, bounds] of Object.entries(edgeBounds)) {
    for (const rotation of rotations) {
      it(`${edgeName}, rotation ${rotation}deg: same-size local box matches bounds exactly`, () => {
        // localWidth/localHeight equal to bounds' own size (the common
        // case for an unrotated card, and true by construction whenever
        // the AABB isn't inflated) must reproduce bounds exactly,
        // regardless of rotation angle — center-based placement with a
        // matching size is a no-op shift.
        const style = computeHitboxStyle(card({ bounds, rotation, localWidth: bounds.width, localHeight: bounds.height }));
        expect(style.left).toBe(`${bounds.x * 100}%`);
        expect(style.top).toBe(`${bounds.y * 100}%`);
        expect(style.width).toBe(`${bounds.width * 100}%`);
        expect(style.height).toBe(`${bounds.height * 100}%`);
      });
    }
  }

  it("preserves the AABB's center when the true local size differs from bounds (the inflated-AABB case)", () => {
    // A rotated card's AABB is bigger than its true shape — simulate that
    // by giving a local size smaller than bounds. The rendered box must
    // still be centered on the same point bounds itself is centered on.
    const bounds = { x: 0.3, y: 0.4, width: 0.14, height: 0.24 };
    const localWidth = 0.1;
    const localHeight = 0.2;
    const style = computeHitboxStyle(card({ bounds, rotation: 8, localWidth, localHeight }));

    const boundsCenterX = bounds.x + bounds.width / 2;
    const boundsCenterY = bounds.y + bounds.height / 2;
    const styleLeft = Number.parseFloat(style.left) / 100;
    const styleTop = Number.parseFloat(style.top) / 100;
    const styleWidth = Number.parseFloat(style.width) / 100;
    const styleHeight = Number.parseFloat(style.height) / 100;

    expect(styleLeft + styleWidth / 2).toBeCloseTo(boundsCenterX);
    expect(styleTop + styleHeight / 2).toBeCloseTo(boundsCenterY);
    expect(styleWidth).toBeCloseTo(localWidth);
    expect(styleHeight).toBeCloseTo(localHeight);
    expect(style.transform).toBe("rotate(8deg)");
  });

  it("composes correctly through a non-full-frame source region for an edge card", () => {
    const rightEdgeBounds = { x: 0.9, y: 0.4, width: 0.08, height: 0.18 };
    const sourceRegion = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const mapped = mapBoundsToSourceRegion(rightEdgeBounds, sourceRegion);
    const mappedSize = mapSizeToSourceRegion({ width: rightEdgeBounds.width, height: rightEdgeBounds.height }, sourceRegion);
    const style = computeHitboxStyle(
      card({ bounds: mapped, rotation: 90, localWidth: mappedSize.width, localHeight: mappedSize.height })
    );
    expect(style.left).toBe(`${(sourceRegion.x + rightEdgeBounds.x * sourceRegion.width) * 100}%`);
    expect(style.top).toBe(`${(sourceRegion.y + rightEdgeBounds.y * sourceRegion.height) * 100}%`);
    expect(style.width).toBe(`${rightEdgeBounds.width * sourceRegion.width * 100}%`);
    expect(style.height).toBe(`${rightEdgeBounds.height * sourceRegion.height * 100}%`);
  });
});

describe("computeHitboxBox", () => {
  it("returns the same numeric geometry computeHitboxStyle formats into percent strings", () => {
    const bounds = { x: 0.3, y: 0.4, width: 0.14, height: 0.24 };
    const testCard = card({ bounds, rotation: 8, localWidth: 0.1, localHeight: 0.2 });
    const box = computeHitboxBox(testCard);
    const style = computeHitboxStyle(testCard);
    expect(`${box.left * 100}%`).toBe(style.left);
    expect(`${box.top * 100}%`).toBe(style.top);
    expect(`${box.width * 100}%`).toBe(style.width);
    expect(`${box.height * 100}%`).toBe(style.height);
  });
});

function occlusionBox(overrides: Partial<OcclusionBox> = {}): OcclusionBox {
  return { left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0, ...overrides };
}

describe("computeOcclusionClips", () => {
  it("is all zero for a single box with nothing above it", () => {
    expect(computeOcclusionClips([occlusionBox()])).toEqual([{ top: 0, right: 0, bottom: 0, left: 0 }]);
  });

  it("is all zero when a higher box exists but doesn't overlap at all", () => {
    const box = occlusionBox({ zIndex: 0 });
    const farAway = occlusionBox({ left: 0.9, top: 0.9, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, farAway]);
    expect(clip).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("clips only the right edge for pure rightward encroachment (the hand-fan case)", () => {
    // box spans x:[0.3,0.5]; higher box's left edge (0.45) cuts into that from the right.
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const encroacher = occlusionBox({ left: 0.45, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, encroacher]);
    expect(clip!.right).toBeCloseTo(1 - (0.45 - 0.3) / 0.2); // 0.25
    expect(clip!.top).toBe(0);
    expect(clip!.bottom).toBe(0);
    expect(clip!.left).toBe(0);
  });

  it("clips only the left edge for pure leftward encroachment", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const encroacher = occlusionBox({ left: 0.15, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, encroacher]);
    expect(clip!.left).toBeCloseTo((0.35 - 0.3) / 0.2); // 0.25
    expect(clip!.top).toBe(0);
    expect(clip!.right).toBe(0);
    expect(clip!.bottom).toBe(0);
  });

  it("clips only the top edge for a box crowding from above (vertical stacking, not a fan)", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const encroacher = occlusionBox({ left: 0.3, top: 0.15, width: 0.2, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, encroacher]);
    expect(clip!.top).toBeCloseTo((0.35 - 0.3) / 0.2); // 0.25
    expect(clip!.right).toBe(0);
    expect(clip!.bottom).toBe(0);
    expect(clip!.left).toBe(0);
  });

  it("clips only the bottom edge for a box crowding from below", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const encroacher = occlusionBox({ left: 0.3, top: 0.45, width: 0.2, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, encroacher]);
    expect(clip!.bottom).toBeCloseTo(1 - (0.45 - 0.3) / 0.2); // 0.25
    expect(clip!.top).toBe(0);
    expect(clip!.right).toBe(0);
    expect(clip!.left).toBe(0);
  });

  it("clips two adjacent edges independently when crowded by two separate higher boxes (base/battlefield case, not just a hand fan)", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const rightEncroacher = occlusionBox({ left: 0.45, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const topEncroacher = occlusionBox({ left: 0.3, top: 0.15, width: 0.2, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, rightEncroacher, topEncroacher]);
    expect(clip!.right).toBeCloseTo(0.25);
    expect(clip!.top).toBeCloseTo(0.25);
    expect(clip!.bottom).toBe(0);
    expect(clip!.left).toBe(0);
  });

  it("fully clips a box completely spanned by a single higher box on one axis (not just partial one-sided encroachment)", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    // Starts before box's left edge and ends after box's right edge — the
    // one-sided "other.left > box.left" / "otherRight < box.right" checks
    // alone would never fire for this; needs its own branch.
    const fullSpan = occlusionBox({ left: 0.2, top: 0.3, width: 0.5, height: 0.2, zIndex: 1 });
    const [clip] = computeOcclusionClips([box, fullSpan]);
    expect(clip!.left + clip!.right).toBeGreaterThanOrEqual(1);
  });

  it("uses the most restrictive (smallest exposed range) boundary when multiple higher boxes encroach from the same side", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.3, height: 0.2, zIndex: 0 }); // x:[0.3,0.6]
    const weaker = occlusionBox({ left: 0.5, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const stronger = occlusionBox({ left: 0.4, top: 0.3, width: 0.3, height: 0.2, zIndex: 2 });
    const [clip] = computeOcclusionClips([box, weaker, stronger]);
    expect(clip!.right).toBeCloseTo(1 - (0.4 - 0.3) / 0.3); // stronger (0.4), not weaker (0.5)
  });

  it("never clips against a lower-stacked overlapping box", () => {
    const box = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const lower = occlusionBox({ left: 0.35, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const [clip] = computeOcclusionClips([box, lower]);
    expect(clip).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("breaks equal zIndex ties by array index — later index is on top, matching DOM/paint order", () => {
    const first = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const second = occlusionBox({ left: 0.4, top: 0.3, width: 0.2, height: 0.2, zIndex: 0 });
    const [firstClip, secondClip] = computeOcclusionClips([first, second]);
    expect(firstClip!.right).toBeGreaterThan(0); // clipped by the later (on-top) box
    expect(secondClip!.left).toBe(0); // never clipped by the earlier (underneath) box
  });

  it("returns zero, not NaN, for a zero-width or zero-height box even with an encroaching higher box", () => {
    const zeroWidth = occlusionBox({ width: 0, zIndex: 0 });
    const zeroHeight = occlusionBox({ height: 0, zIndex: 0 });
    const encroacher = occlusionBox({ left: 0.3, top: 0.3, width: 0.2, height: 0.2, zIndex: 1 });
    const [widthClip] = computeOcclusionClips([zeroWidth, encroacher]);
    const [heightClip] = computeOcclusionClips([zeroHeight, encroacher]);
    expect(widthClip!.left).toBe(0);
    expect(widthClip!.right).toBe(0);
    expect(heightClip!.top).toBe(0);
    expect(heightClip!.bottom).toBe(0);
  });
});

describe("formatOcclusionClipPath", () => {
  it("returns an empty string when all four clips are zero", () => {
    expect(formatOcclusionClipPath({ top: 0, right: 0, bottom: 0, left: 0 })).toBe("");
  });

  it("formats a non-zero clip as an inset() value, top/right/bottom/left order, percent values", () => {
    expect(formatOcclusionClipPath({ top: 0, right: 0.25, bottom: 0, left: 0 })).toBe("inset(0% 25% 0% 0%)");
  });

  it("formats all four edges when multiple are clipped", () => {
    expect(formatOcclusionClipPath({ top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 })).toBe("inset(10% 20% 30% 40%)");
  });
});

describe("hitboxClassName", () => {
  it("flags hidden and unknown cards distinctly from public ones", () => {
    expect(hitboxClassName(card({ visibility: "public" }))).toBe("hitbox");
    expect(hitboxClassName(card({ visibility: "hidden" }))).toContain("hidden-card");
    expect(hitboxClassName(card({ visibility: "unknown" }))).toContain("unknown-card");
  });
});

describe("hitboxLabel", () => {
  it("includes cardId for a public card", () => {
    expect(hitboxLabel(card({ visibility: "public", cardId: "OGN-089" }))).toContain("OGN-089");
  });

  it("never includes a card-id-shaped string for a hidden card", () => {
    const label = hitboxLabel(card({ visibility: "hidden", cardId: undefined }));
    expect(label).not.toMatch(/[A-Z]+-\d+/);
  });
});

describe("computeTooltipPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const tooltipSize = { width: 150, height: 100 };

  it("anchors to the right of the target when there's room, aligned with its top edge", () => {
    const target = { left: 200, top: 300, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(200 + 120 + 8);
    expect(position.top).toBe(300);
  });

  it("flips to the left of the target when there isn't enough room on the right", () => {
    const target = { left: 850, top: 300, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(850 - tooltipSize.width - 8);
  });

  it("stays on the right (clamped) when neither side fully fits", () => {
    // The target itself is wide enough that there's no room on either side.
    const target = { left: 50, top: 300, width: 800, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(viewport.width - tooltipSize.width - 4);
  });

  it("clamps left so the popup never overflows the left edge", () => {
    // Target is far enough off-screen to the left that even the right-side
    // placement would land in negative territory before clamping.
    const target = { left: -300, top: 300, width: 20, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(4);
  });

  it("clamps top so the popup never overflows the bottom edge", () => {
    const target = { left: 200, top: 750, width: 120, height: 40 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.top).toBe(viewport.height - tooltipSize.height - 4);
  });

  it("clamps top so the popup never overflows the top edge", () => {
    const target = { left: 200, top: -50, width: 120, height: 40 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.top).toBe(4);
  });

  it("doesn't cover the hovered card when the card sits near the left edge", () => {
    const target = { left: 10, top: 300, width: 60, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    // Naturally anchors to the right — nothing to flip since there's no
    // room on the left of a card that's already near the left edge.
    expect(position.left).toBe(10 + 60 + 8);
  });
});
