import { describe, expect, it } from "vitest";
import { boundsToCssPercent, normalizeBounds } from "./coordinates.js";

describe("normalizeBounds", () => {
  const viewport = { width: 1000, height: 500 };

  it("converts a fully on-screen rect to 0..1 fractions", () => {
    expect(normalizeBounds({ x: 100, y: 50, width: 200, height: 100 }, viewport)).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    });
  });

  it("clamps a rect that partially overflows the top-left edge", () => {
    const result = normalizeBounds({ x: -50, y: -20, width: 150, height: 100 }, viewport);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
    expect(result!.width).toBeCloseTo(0.1); // right edge stays at 100/1000
    expect(result!.height).toBeCloseTo(0.16); // bottom edge stays at 80/500
  });

  it("rejects a rect that is entirely off-screen", () => {
    expect(normalizeBounds({ x: -500, y: 0, width: 100, height: 100 }, viewport)).toBeNull();
  });

  it("rejects a degenerate (zero-size) card", () => {
    expect(normalizeBounds({ x: 0, y: 0, width: 0, height: 50 }, viewport)).toBeNull();
  });

  it("rejects a degenerate (zero-size) viewport", () => {
    expect(normalizeBounds({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 500 })).toBeNull();
  });
});

describe("boundsToCssPercent", () => {
  it("formats normalized bounds as percentage strings", () => {
    expect(boundsToCssPercent({ x: 0.25, y: 0.5, width: 0.1, height: 0.2 })).toEqual({
      left: "25%",
      top: "50%",
      width: "10%",
      height: "20%",
    });
  });
});
