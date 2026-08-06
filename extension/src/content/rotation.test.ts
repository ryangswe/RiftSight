import { describe, expect, it } from "vitest";
import {
  composeRotations,
  normalizeDegrees,
  parseRotateFunction,
  parseStandaloneRotate,
  resolveElementRotationDeg,
  rotationFromMatrixString,
} from "./rotation.js";

describe("normalizeDegrees", () => {
  it("wraps 270 to its signed equivalent -90", () => {
    expect(normalizeDegrees(270)).toBe(-90);
  });

  it("wraps 450 down to 90", () => {
    expect(normalizeDegrees(450)).toBe(90);
  });

  it("wraps -270 to its signed equivalent 90", () => {
    expect(normalizeDegrees(-270)).toBe(90);
  });

  it("keeps 180 as 180 rather than -180", () => {
    expect(normalizeDegrees(180)).toBe(180);
  });

  it("rounds away tiny float noise", () => {
    expect(normalizeDegrees(89.999998)).toBe(90);
    expect(normalizeDegrees(-90.0000013)).toBe(-90);
  });
});

describe("parseRotateFunction", () => {
  it("extracts degrees from a rotate() token", () => {
    expect(parseRotateFunction("rotate(90deg)")).toBe(90);
    expect(parseRotateFunction("rotate(-90deg)")).toBe(-90);
  });

  it("finds rotate() combined with other transform functions", () => {
    expect(parseRotateFunction("translate(10px, 5px) rotate(180deg) scale(1.02)")).toBe(180);
  });

  it("returns undefined when there is no rotate() function", () => {
    expect(parseRotateFunction("none")).toBeUndefined();
    expect(parseRotateFunction("translate(10px, 5px)")).toBeUndefined();
  });
});

describe("parseStandaloneRotate", () => {
  it("parses a simple angle", () => {
    expect(parseStandaloneRotate("90deg")).toBe(90);
  });

  it("treats 'none' as unset", () => {
    expect(parseStandaloneRotate("none")).toBeUndefined();
    expect(parseStandaloneRotate("")).toBeUndefined();
  });
});

describe("rotationFromMatrixString", () => {
  it("returns undefined for 'none'", () => {
    expect(rotationFromMatrixString("none")).toBeUndefined();
  });

  it("decomposes a 2D matrix representing 90 degrees", () => {
    // matrix(cos90, sin90, -sin90, cos90, 0, 0) = matrix(0, 1, -1, 0, 0, 0)
    expect(rotationFromMatrixString("matrix(0, 1, -1, 0, 0, 0)")).toBeCloseTo(90);
  });

  it("decomposes a 2D matrix representing -90 degrees", () => {
    // matrix(cos(-90), sin(-90), -sin(-90), cos(-90), 0, 0) = matrix(0, -1, 1, 0, 0, 0)
    expect(rotationFromMatrixString("matrix(0, -1, 1, 0, 0, 0)")).toBeCloseTo(-90);
  });

  it("decomposes a matrix3d representing a 90 degree Z rotation", () => {
    // Column-major: column1=(cos90,sin90,0,0), column2=(-sin90,cos90,0,0), column3=(0,0,1,0), column4=(0,0,0,1)
    expect(rotationFromMatrixString("matrix3d(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)")).toBeCloseTo(90);
  });

  it("returns undefined for garbage input", () => {
    expect(rotationFromMatrixString("translate(10px, 5px)")).toBeUndefined();
  });
});

describe("resolveElementRotationDeg", () => {
  it("returns undefined (no rotation-related value at all) for a fully untransformed element", () => {
    const result = resolveElementRotationDeg({ computedRotate: "none", inlineTransform: "", computedTransform: "none" });
    expect(result).toBeUndefined();
  });

  it("prefers an inline rotate() over the computed matrix when both are present", () => {
    const result = resolveElementRotationDeg({
      computedRotate: "none",
      inlineTransform: "rotate(90deg)",
      computedTransform: "matrix(0, 1, -1, 0, 0, 0)",
    });
    expect(result).toBe(90);
  });

  it("falls back to decomposing the computed matrix when there's no exact string available", () => {
    const result = resolveElementRotationDeg({
      computedRotate: "none",
      inlineTransform: "",
      computedTransform: "matrix(0, 1, -1, 0, 0, 0)",
    });
    expect(result).toBe(90);
  });

  it("reproduces the live-captured Black Rose Dignitary case exactly", () => {
    // anchor (button): computedRotate "none", inlineTransform "(none)"->"", computedTransform "none"
    expect(
      resolveElementRotationDeg({ computedRotate: "none", inlineTransform: "", computedTransform: "none" })
    ).toBeUndefined();
    // ancestor[2]: inline "rotate(90deg)", computed "matrix(0, 1, -1, 0, 0, 0)", computedRotate "none"
    expect(
      resolveElementRotationDeg({
        computedRotate: "none",
        inlineTransform: "rotate(90deg)",
        computedTransform: "matrix(0, 1, -1, 0, 0, 0)",
      })
    ).toBe(90);
  });
});

describe("composeRotations", () => {
  it("returns 0 when no ancestor contributed a rotation at all", () => {
    expect(composeRotations([])).toBe(0);
  });

  it("returns a single contribution unchanged — the player's-own-side case, where only one ancestor ever carries a rotation", () => {
    expect(composeRotations([90])).toBe(90);
  });

  it("reproduces the live-captured opponent base-zone case: a 90deg landscape card inside RiftAtlas's 180deg opponent-perspective-correction wrapper composes to -90, not 180", () => {
    // Real captured ancestor chain, nearest-to-anchor first: the zone
    // wrapper's own standalone rotate:180deg is found one level nearer the
    // anchor than the card's own rotate(90deg) wrapper further out.
    // Stopping at the first contribution alone (the original bug) returns
    // 180 — and a rectangle rotated 180deg is visually indistinguishable
    // from one not rotated at all, which is exactly why the opponent's
    // landscape hitboxes looked "vertical" instead of "horizontal."
    expect(composeRotations([180, 90])).toBe(-90);
  });

  it("composition is order-independent", () => {
    expect(composeRotations([90, 180])).toBe(-90);
  });

  it("wraps a summed total back into (-180, 180]", () => {
    expect(composeRotations([90, 90])).toBe(180);
    expect(composeRotations([170, 170])).toBe(-20); // 340 -> -20
  });
});
