import { describe, expect, it } from "vitest";
import { computeContainedRect, resolveViewerDelayMs, scaleTooltipForStage } from "./youtube-geometry.js";
import { parseViewerPrefs, DEFAULT_VIEWER_PREFS, MAX_VIEWER_DELAY_MS } from "./youtube-prefs.js";

describe("computeContainedRect", () => {
  it("returns the container unchanged when aspect ratios match", () => {
    const container = { x: 10, y: 20, width: 1280, height: 720 };
    expect(computeContainedRect(container, 1920, 1080)).toEqual(container);
  });

  it("letterboxes a wide video in a tall container (bars top and bottom)", () => {
    const rect = computeContainedRect({ x: 0, y: 0, width: 1000, height: 1000 }, 1920, 1080);
    expect(rect.width).toBeCloseTo(1000);
    expect(rect.height).toBeCloseTo(562.5);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo((1000 - 562.5) / 2);
  });

  it("pillarboxes a tall video in a wide container (bars left and right)", () => {
    const rect = computeContainedRect({ x: 100, y: 0, width: 1920, height: 1080 }, 1080, 1920);
    expect(rect.height).toBe(1080);
    expect(rect.width).toBeCloseTo(607.5);
    expect(rect.x).toBeCloseTo(100 + (1920 - 607.5) / 2);
  });

  it("falls back to the container itself before metadata (zero intrinsic dimensions)", () => {
    const container = { x: 0, y: 0, width: 800, height: 450 };
    expect(computeContainedRect(container, 0, 0)).toEqual(container);
    expect(computeContainedRect(container, NaN, 1080)).toEqual(container);
  });
});

describe("resolveViewerDelayMs", () => {
  it("the viewer's explicit setting wins over everything", () => {
    expect(resolveViewerDelayMs(3000, 9000, 12000)).toBe(3000);
    expect(resolveViewerDelayMs(0, 9000, 12000)).toBe(0); // zero is a real choice, not "unset"
  });

  it("falls back to the broadcaster's recommendation, then the platform default", () => {
    expect(resolveViewerDelayMs(null, 9000, 12000)).toBe(9000);
    expect(resolveViewerDelayMs(null, undefined, 12000)).toBe(12000);
  });

  it("ignores invalid values at each level", () => {
    expect(resolveViewerDelayMs(-5, 9000, 12000)).toBe(9000);
    expect(resolveViewerDelayMs(null, -1, 12000)).toBe(12000);
  });
});

describe("scaleTooltipForStage", () => {
  it("is the configured scale at reference width and clamps at both ends", () => {
    expect(scaleTooltipForStage(960, 1)).toBe(1);
    expect(scaleTooltipForStage(100, 1)).toBe(0.45); // floor
    expect(scaleTooltipForStage(5000, 1)).toBe(1.25); // ceiling
  });

  it("multiplies the broadcaster's configured scale", () => {
    expect(scaleTooltipForStage(960, 1.2)).toBeCloseTo(1.2);
    expect(scaleTooltipForStage(480, 1.2)).toBeCloseTo(0.6);
  });
});

describe("parseViewerPrefs", () => {
  it("returns defaults for garbage", () => {
    expect(parseViewerPrefs(undefined)).toEqual(DEFAULT_VIEWER_PREFS);
    expect(parseViewerPrefs("nope")).toEqual(DEFAULT_VIEWER_PREFS);
    expect(parseViewerPrefs(null)).toEqual(DEFAULT_VIEWER_PREFS);
  });

  it("keeps valid fields and repairs invalid ones independently", () => {
    expect(parseViewerPrefs({ enabled: false, delayMs: 5000, outlines: true })).toEqual({ enabled: false, delayMs: 5000, outlines: true });
    expect(parseViewerPrefs({ enabled: "yes", delayMs: MAX_VIEWER_DELAY_MS + 1, outlines: false })).toEqual({
      enabled: true,
      delayMs: null,
      outlines: false,
    });
  });
});
