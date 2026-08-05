import { describe, expect, it } from "vitest";
import { classifyFaceFacing, extractYRotationDeg } from "./face-transform.js";

const IDENTITY_MATRIX3D = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)";
// The exact matrix captured live from RiftAtlas's own rotateY(180deg) cardback wrapper.
const ROTATE_180_MATRIX3D = "matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)";

function rotateYMatrix3d(deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return `matrix3d(${cos}, 0, ${-sin}, 0, 0, 1, 0, 0, ${sin}, 0, ${cos}, 0, 0, 0, 0, 1)`;
}

describe("extractYRotationDeg", () => {
  it("treats 'none' as 0deg", () => {
    expect(extractYRotationDeg("none")).toBe(0);
  });

  it("treats an empty string as 0deg", () => {
    expect(extractYRotationDeg("")).toBe(0);
  });

  it("treats an identity 2D matrix() as 0deg", () => {
    expect(extractYRotationDeg("matrix(1, 0, 0, 1, 0, 0)")).toBe(0);
  });

  it("treats a translating 2D matrix() as 0deg — a 2D matrix carries no Y-rotation regardless of translation", () => {
    expect(extractYRotationDeg("matrix(1, 0, 0, 1, 120, -45)")).toBe(0);
  });

  it("treats an identity matrix3d() as 0deg", () => {
    expect(extractYRotationDeg(IDENTITY_MATRIX3D)).toBe(0);
  });

  it("recovers 180deg from the real captured rotateY(180deg) matrix", () => {
    expect(extractYRotationDeg(ROTATE_180_MATRIX3D)).toBeCloseTo(180);
  });

  it("recovers an arbitrary intermediate angle from a synthesized rotateY matrix", () => {
    expect(extractYRotationDeg(rotateYMatrix3d(90))).toBeCloseTo(90);
    expect(extractYRotationDeg(rotateYMatrix3d(-45))).toBeCloseTo(-45);
  });

  it("returns undefined for a malformed matrix3d value", () => {
    expect(extractYRotationDeg("matrix3d(not, a, real, matrix)")).toBeUndefined();
  });

  it("returns undefined for a matrix3d with the wrong number of values", () => {
    expect(extractYRotationDeg("matrix3d(1, 0, 0, 1)")).toBeUndefined();
  });

  it("returns undefined for a matrix3d whose cos/sin pair isn't on the unit circle (scale composed in)", () => {
    expect(extractYRotationDeg("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1)")).toBeUndefined();
  });

  it("returns undefined for a completely unrecognized transform string", () => {
    expect(extractYRotationDeg("perspective(500px) rotateX(45deg)")).toBeUndefined();
  });
});

describe("classifyFaceFacing", () => {
  it("classifies 'none' as front", () => {
    expect(classifyFaceFacing("none")).toBe("front");
  });

  it("classifies the identity matrix3d as front", () => {
    expect(classifyFaceFacing(IDENTITY_MATRIX3D)).toBe("front");
  });

  it("classifies the real captured rotateY(180deg) matrix as back", () => {
    expect(classifyFaceFacing(ROTATE_180_MATRIX3D)).toBe("back");
  });

  it("classifies a 180deg matrix with small floating-point noise as back", () => {
    // cos(179.5deg) and sin(179.5deg) rather than exact -1/0 — the kind of
    // noise a browser's own matrix decomposition could plausibly produce.
    expect(classifyFaceFacing(rotateYMatrix3d(179.5))).toBe("back");
    expect(classifyFaceFacing(rotateYMatrix3d(-179.5))).toBe("back");
  });

  it("classifies just inside the front tolerance window as front", () => {
    expect(classifyFaceFacing(rotateYMatrix3d(14))).toBe("front");
    expect(classifyFaceFacing(rotateYMatrix3d(-14))).toBe("front");
  });

  it("classifies just inside the back tolerance window as back", () => {
    expect(classifyFaceFacing(rotateYMatrix3d(166))).toBe("back");
    expect(classifyFaceFacing(rotateYMatrix3d(-166))).toBe("back");
  });

  it("classifies just outside both tolerance windows as intermediate", () => {
    expect(classifyFaceFacing(rotateYMatrix3d(16))).toBe("intermediate");
    expect(classifyFaceFacing(rotateYMatrix3d(164))).toBe("intermediate");
  });

  it("classifies a genuine mid-flip angle (90deg) as intermediate", () => {
    expect(classifyFaceFacing(rotateYMatrix3d(90))).toBe("intermediate");
  });

  it("classifies a malformed transform as unsupported", () => {
    expect(classifyFaceFacing("garbage")).toBe("unsupported");
  });

  it("classifies a transform with an unsupported composed scale as unsupported", () => {
    expect(classifyFaceFacing("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1)")).toBe("unsupported");
  });
});
