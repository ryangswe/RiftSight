import { describe, expect, it } from "vitest";
import type { OverlayCard } from "@riftsight/protocol";
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

  it("applies a rotate() transform for a rotated card", () => {
    expect(computeHitboxStyle(card({ rotation: 90 })).transform).toBe("rotate(90deg)");
  });

  it("omits the transform for an unrotated card", () => {
    expect(computeHitboxStyle(card({ rotation: 0 })).transform).toBe("");
  });

  it("defaults zIndex to 0 when the card has none", () => {
    expect(computeHitboxStyle(card()).zIndex).toBe("0");
  });

  it("passes through an explicit zIndex", () => {
    expect(computeHitboxStyle(card({ zIndex: 42 })).zIndex).toBe("42");
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

  it("places the tooltip just above the target when there's room", () => {
    const target = { left: 200, top: 300, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.top).toBe(300 - 100 - 8);
    expect(position.left).toBe(200);
  });

  it("flips below the target when there isn't enough room above", () => {
    const target = { left: 200, top: 50, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.top).toBe(50 + 170 + 8);
  });

  it("clamps left so the tooltip never overflows the right edge", () => {
    const target = { left: 950, top: 300, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(viewport.width - tooltipSize.width - 4);
  });

  it("clamps left so the tooltip never overflows the left edge", () => {
    const target = { left: -50, top: 300, width: 120, height: 170 };
    const position = computeTooltipPosition(target, tooltipSize, viewport);
    expect(position.left).toBe(4);
  });
});
