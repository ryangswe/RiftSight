import { describe, expect, it } from "vitest";
import type { OverlayCard } from "@riftsight/protocol";
import { mapBoundsToSourceRegion } from "./source-region.js";
import { computeHitboxStyle, computeTooltipPosition, hitboxClassName, hitboxLabel } from "./render.js";

function card(overrides: Partial<OverlayCard> = {}): OverlayCard {
  return {
    instanceId: "card_1",
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds: { x: 0.25, y: 0.5, width: 0.1, height: 0.2 },
    rotation: 0,
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

  it("never emits a transform field, regardless of rotation", () => {
    for (const rotation of [0, 90, -90, 180]) {
      expect(computeHitboxStyle(card({ rotation }))).not.toHaveProperty("transform");
    }
  });

  it("defaults zIndex to 0 when the card has none", () => {
    expect(computeHitboxStyle(card()).zIndex).toBe("0");
  });

  it("passes through an explicit zIndex", () => {
    expect(computeHitboxStyle(card({ zIndex: 42 })).zIndex).toBe("42");
  });
});

// Regression coverage for the double-rotation bug: `bounds` is already the
// post-transform axis-aligned bounding box (getBoundingClientRect() on the
// rotated card), so computeHitboxStyle must place the hitbox exactly at
// those bounds regardless of `rotation` — at every rotation angle a card
// might report, and at every edge of the source viewport where a
// mis-rotated hitbox would be most visibly offset.
describe("computeHitboxStyle — rotation must not affect placement, at any viewport edge", () => {
  const edgeBounds: Record<string, OverlayCard["bounds"]> = {
    "left edge": { x: 0, y: 0.4, width: 0.08, height: 0.18 },
    "right edge": { x: 0.9, y: 0.4, width: 0.08, height: 0.18 },
    "top edge": { x: 0.4, y: 0, width: 0.08, height: 0.18 },
    "bottom edge": { x: 0.4, y: 0.82, width: 0.08, height: 0.18 },
  };
  const rotations = [0, 90, -90, 180];

  for (const [edgeName, bounds] of Object.entries(edgeBounds)) {
    for (const rotation of rotations) {
      it(`${edgeName}, rotation ${rotation}deg: style matches bounds exactly`, () => {
        const upright = computeHitboxStyle(card({ bounds, rotation: 0 }));
        const rotated = computeHitboxStyle(card({ bounds, rotation }));
        // Same bounds must produce the same style no matter what rotation
        // the card reports — proves rotation is genuinely ignored, not
        // just absent from the output shape.
        expect(rotated).toEqual(upright);
        expect(rotated.left).toBe(`${bounds.x * 100}%`);
        expect(rotated.top).toBe(`${bounds.y * 100}%`);
        expect(rotated.width).toBe(`${bounds.width * 100}%`);
        expect(rotated.height).toBe(`${bounds.height * 100}%`);
      });
    }
  }

  it("composes correctly through a non-full-frame source region for an edge card", () => {
    const rightEdgeBounds = { x: 0.9, y: 0.4, width: 0.08, height: 0.18 };
    const sourceRegion = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const mapped = mapBoundsToSourceRegion(rightEdgeBounds, sourceRegion);
    const style = computeHitboxStyle(card({ bounds: mapped, rotation: 90 }));
    expect(style.left).toBe(`${(sourceRegion.x + rightEdgeBounds.x * sourceRegion.width) * 100}%`);
    expect(style.top).toBe(`${(sourceRegion.y + rightEdgeBounds.y * sourceRegion.height) * 100}%`);
    expect(style.width).toBe(`${rightEdgeBounds.width * sourceRegion.width * 100}%`);
    expect(style.height).toBe(`${rightEdgeBounds.height * sourceRegion.height * 100}%`);
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
