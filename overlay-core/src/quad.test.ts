import { describe, expect, it } from "vitest";
import type { OverlayCard } from "@riftsight/protocol";
import { compareStackOrder } from "./stack-order.js";
import {
  computeCardQuad,
  computeRectQuad,
  pointInConvexQuad,
  resolveHoveredCard,
  type CardQuad,
  type HoverCandidate,
} from "./quad.js";

function card(overrides: Partial<OverlayCard> = {}): OverlayCard {
  const bounds = overrides.bounds ?? { x: 0.25, y: 0.25, width: 0.2, height: 0.3 };
  return {
    instanceId: "card_1",
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds,
    rotation: 0,
    landscape: false,
    localWidth: bounds.width,
    localHeight: bounds.height,
    fromDialog: false,
    ...overrides,
  };
}

describe("computeCardQuad", () => {
  it("matches the axis-aligned corners exactly for an upright card, scaled per-axis by stage size", () => {
    const stageSize = { width: 1000, height: 500 };
    const quad = computeCardQuad(card({ rotation: 0 }), stageSize);
    // bounds x:0.25,y:0.25,width:0.2,height:0.3 → pixel box [250,125]-[450,275]
    expect(quad.points[0]).toEqual({ x: 250, y: 125 }); // top-left
    expect(quad.points[1]).toEqual({ x: 450, y: 125 }); // top-right
    expect(quad.points[2]).toEqual({ x: 450, y: 275 }); // bottom-right
    expect(quad.points[3]).toEqual({ x: 250, y: 275 }); // bottom-left
  });

  it("rotates correctly in pixel space on a non-square stage, not naively in raw normalized fractions", () => {
    // A naive rotation applied directly to normalized [0,1] fractions would
    // distort the angle whenever the stage isn't square, since normalized
    // width/height don't represent equal physical distances there. This
    // asserts the actual, hand-computed pixel-space result for a known
    // 90° rotation on a deliberately non-square stage (1000x500) — a
    // wrong (normalized-space) implementation would not produce these
    // values, since the correct answer depends on converting to pixels
    // (via the stage's real width/height) *before* rotating.
    const stageSize = { width: 1000, height: 500 };
    const quad = computeCardQuad(card({ rotation: 90 }), stageSize);
    // center (350,200), half-width 100px, half-height 75px pre-rotation —
    // a 90° rotation swaps which axis each half-extent applies along.
    expect(quad.points[0].x).toBeCloseTo(425);
    expect(quad.points[0].y).toBeCloseTo(100);
    expect(quad.points[1].x).toBeCloseTo(425);
    expect(quad.points[1].y).toBeCloseTo(300);
    expect(quad.points[2].x).toBeCloseTo(275);
    expect(quad.points[2].y).toBeCloseTo(300);
    expect(quad.points[3].x).toBeCloseTo(275);
    expect(quad.points[3].y).toBeCloseTo(100);
  });

  it("reuses computeHitboxBox's center/size derivation — matches its own output when converted to pixels", () => {
    const stageSize = { width: 800, height: 800 };
    const bounds = { x: 0.3, y: 0.4, width: 0.14, height: 0.24 };
    const testCard = card({ bounds, rotation: 0, localWidth: 0.1, localHeight: 0.2 });
    const quad = computeCardQuad(testCard, stageSize);
    // Center of bounds: (0.37, 0.52) → pixel (296, 416); local half-size (0.05, 0.1) → pixel (40, 80).
    expect(quad.points[0]).toEqual({ x: 256, y: 336 });
    expect(quad.points[2]).toEqual({ x: 336, y: 496 });
  });
});

describe("computeRectQuad", () => {
  it("builds an unrotated 4-corner rect scaled per-axis by stage size", () => {
    const stageSize = { width: 1000, height: 500 };
    const quad = computeRectQuad({ x: 0.3, y: 0.4, width: 0.2, height: 0.3 }, stageSize);
    expect(quad.points[0]).toEqual({ x: 300, y: 200 }); // top-left
    expect(quad.points[1]).toEqual({ x: 500, y: 200 }); // top-right
    expect(quad.points[2]).toEqual({ x: 500, y: 350 }); // bottom-right
    expect(quad.points[3]).toEqual({ x: 300, y: 350 }); // bottom-left
  });
});

describe("pointInConvexQuad", () => {
  const uprightQuad: CardQuad = {
    points: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ],
  };

  it("is true for a point inside an upright quad", () => {
    expect(pointInConvexQuad({ x: 150, y: 150 }, uprightQuad)).toBe(true);
  });

  it("is false for a point outside an upright quad", () => {
    expect(pointInConvexQuad({ x: 50, y: 50 }, uprightQuad)).toBe(false);
  });

  it("is true for a point exactly on an edge (inclusive boundary convention)", () => {
    expect(pointInConvexQuad({ x: 100, y: 150 }, uprightQuad)).toBe(true);
  });

  it("is true for a point inside a rotated quad", () => {
    const rotatedQuad: CardQuad = {
      points: [
        { x: 425, y: 100 },
        { x: 425, y: 300 },
        { x: 275, y: 300 },
        { x: 275, y: 100 },
      ],
    };
    expect(pointInConvexQuad({ x: 350, y: 200 }, rotatedQuad)).toBe(true); // center
  });

  it("is false for a point inside the rotated card's AABB but outside its true rotated quad — the core case this exists to fix", () => {
    // A square (half-size 50, center (100,100)) rotated 45° becomes a
    // diamond inscribed in its own [50,50]-[150,150] AABB — touching only
    // the midpoints of each AABB edge. A point near an AABB *corner* is
    // inside the AABB but clearly outside the diamond.
    const rotatedDiamond: CardQuad = {
      points: [
        { x: 100, y: 29.29 },
        { x: 170.71, y: 100 },
        { x: 100, y: 170.71 },
        { x: 29.29, y: 100 },
      ],
    };
    expect(pointInConvexQuad({ x: 60, y: 60 }, rotatedDiamond)).toBe(false);
    expect(pointInConvexQuad({ x: 100, y: 100 }, rotatedDiamond)).toBe(true); // center, sanity check
  });
});

describe("compareStackOrder", () => {
  it("orders by zIndex when they differ", () => {
    expect(compareStackOrder({ zIndex: 5 }, 0, { zIndex: 2 }, 1)).toBeGreaterThan(0);
    expect(compareStackOrder({ zIndex: 2 }, 0, { zIndex: 5 }, 1)).toBeLessThan(0);
  });

  it("breaks equal zIndex ties by array index — later index wins", () => {
    expect(compareStackOrder({ zIndex: 0 }, 0, { zIndex: 0 }, 1)).toBeLessThan(0);
    expect(compareStackOrder({ zIndex: 0 }, 1, { zIndex: 0 }, 0)).toBeGreaterThan(0);
  });
});

describe("resolveHoveredCard", () => {
  const stageSize = { width: 1000, height: 1000 };

  function candidateFor(overrides: Partial<OverlayCard>, zIndex = 0): HoverCandidate {
    const testCard = card(overrides);
    return { card: testCard, quad: computeCardQuad(testCard, stageSize), zIndex };
  }

  it("returns null when no candidate contains the point", () => {
    const candidates = [candidateFor({ bounds: { x: 0, y: 0, width: 0.1, height: 0.1 } })];
    expect(resolveHoveredCard({ x: 900, y: 900 }, candidates)).toBeNull();
  });

  it("returns the single matching candidate", () => {
    const candidates = [candidateFor({ instanceId: "only", bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } })];
    expect(resolveHoveredCard({ x: 300, y: 300 }, candidates)?.instanceId).toBe("only");
  });

  it("picks the higher-stacked card where two overlap", () => {
    const lower = candidateFor({ instanceId: "lower", bounds: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } }, 0);
    const higher = candidateFor({ instanceId: "higher", bounds: { x: 0.3, y: 0.3, width: 0.3, height: 0.3 } }, 1);
    // Overlap region — both quads contain this point.
    expect(resolveHoveredCard({ x: 450, y: 450 }, [lower, higher])?.instanceId).toBe("higher");
  });

  it("resolves to the lower card in its exposed sliver, outside the higher card's quad", () => {
    const lower = candidateFor({ instanceId: "lower", bounds: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } }, 0);
    const higher = candidateFor({ instanceId: "higher", bounds: { x: 0.3, y: 0.3, width: 0.3, height: 0.3 } }, 1);
    // Top-left sliver of `lower`, not covered by `higher` (which starts further right/down).
    expect(resolveHoveredCard({ x: 220, y: 220 }, [lower, higher])?.instanceId).toBe("lower");
  });

  describe("blockingRegion", () => {
    const blockingRegion: CardQuad = computeRectQuad({ x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, stageSize);

    it("suppresses a background card whose winning point falls inside blockingRegion", () => {
      const background = candidateFor({
        instanceId: "background",
        fromDialog: false,
        bounds: { x: 0.25, y: 0.25, width: 0.3, height: 0.3 },
      });
      expect(resolveHoveredCard({ x: 350, y: 350 }, [background], blockingRegion)).toBeNull();
    });

    it("does not suppress a dialog card (fromDialog: true) at the same position", () => {
      const dialogCard = candidateFor({
        instanceId: "dialog-card",
        fromDialog: true,
        bounds: { x: 0.25, y: 0.25, width: 0.3, height: 0.3 },
      });
      expect(resolveHoveredCard({ x: 350, y: 350 }, [dialogCard], blockingRegion)?.instanceId).toBe("dialog-card");
    });

    it("a dialog card wins over an overlapping background card even when the background card has a much higher zIndex — the real live bug: detectDialogCards publishes a flat, low zIndex for every dialog card, so a naive single-pool zIndex comparison let an arbitrary background card behind it win the point", () => {
      const background = candidateFor(
        { instanceId: "background", fromDialog: false, bounds: { x: 0.25, y: 0.25, width: 0.3, height: 0.3 } },
        40
      );
      const dialogCard = candidateFor(
        { instanceId: "dialog-card", fromDialog: true, bounds: { x: 0.25, y: 0.25, width: 0.3, height: 0.3 } },
        1
      );
      expect(resolveHoveredCard({ x: 350, y: 350 }, [background, dialogCard], blockingRegion)?.instanceId).toBe("dialog-card");
    });

    it("does not suppress a background card outside blockingRegion", () => {
      const background = candidateFor({
        instanceId: "background",
        fromDialog: false,
        bounds: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
      });
      expect(resolveHoveredCard({ x: 700, y: 700 }, [background], blockingRegion)?.instanceId).toBe("background");
    });

    it("behaves exactly as today when no blockingRegion is passed", () => {
      const background = candidateFor({
        instanceId: "background",
        fromDialog: false,
        bounds: { x: 0.25, y: 0.25, width: 0.3, height: 0.3 },
      });
      expect(resolveHoveredCard({ x: 350, y: 350 }, [background])?.instanceId).toBe("background");
    });
  });
});
