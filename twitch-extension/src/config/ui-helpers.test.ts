import { SOURCE_REGION_PRESETS } from "@riftsight/overlay-core";
import { describe, expect, it } from "vitest";
import {
  DELAY_PRESETS_MS,
  MIN_REGION_SIZE,
  applyEdgeDrag,
  describeTooltipScale,
  matchDelayPreset,
  matchRegionPreset,
  msToSeconds,
  secondsToMs,
} from "./ui-helpers.js";

describe("matchDelayPreset", () => {
  it("matches each of the four fixed presets", () => {
    for (const ms of DELAY_PRESETS_MS) {
      expect(matchDelayPreset(ms)).toBe(ms);
    }
  });

  it("returns 'custom' for a value that matches no preset", () => {
    expect(matchDelayPreset(3000)).toBe("custom");
    expect(matchDelayPreset(1)).toBe("custom");
  });
});

describe("secondsToMs / msToSeconds", () => {
  it("round-trips whole seconds", () => {
    expect(secondsToMs(5)).toBe(5000);
    expect(msToSeconds(5000)).toBe(5);
  });

  it("rounds fractional seconds to the nearest millisecond", () => {
    expect(secondsToMs(2.5)).toBe(2500);
    expect(secondsToMs(0.1)).toBe(100);
  });

  it("msToSeconds preserves fractional precision", () => {
    expect(msToSeconds(2500)).toBe(2.5);
    expect(msToSeconds(100)).toBe(0.1);
  });
});

describe("matchRegionPreset", () => {
  it("matches each named preset", () => {
    for (const key of Object.keys(SOURCE_REGION_PRESETS) as Array<keyof typeof SOURCE_REGION_PRESETS>) {
      expect(matchRegionPreset(SOURCE_REGION_PRESETS[key], SOURCE_REGION_PRESETS)).toBe(key);
    }
  });

  it("returns 'custom' for a dragged/resized region that matches no preset", () => {
    expect(matchRegionPreset({ x: 0.12, y: 0.07, width: 0.6, height: 0.6 }, SOURCE_REGION_PRESETS)).toBe("custom");
  });

  it("returns to a preset's name once a custom region is dragged back to exactly match it", () => {
    // Simulates the real UI flow: drag to custom, then drag back until it
    // lands exactly on "centered" again — the preset pill should reactivate.
    const custom = { x: 0.12, y: 0.07, width: 0.6, height: 0.6 };
    expect(matchRegionPreset(custom, SOURCE_REGION_PRESETS)).toBe("custom");
    expect(matchRegionPreset(SOURCE_REGION_PRESETS.centered, SOURCE_REGION_PRESETS)).toBe("centered");
  });
});

describe("describeTooltipScale", () => {
  it("labels the default scale (1.0) as Default", () => {
    expect(describeTooltipScale(1)).toBe("Default");
  });

  it("labels values just inside the default band as Default", () => {
    expect(describeTooltipScale(0.85)).toBe("Default");
    expect(describeTooltipScale(1.15)).toBe("Default");
  });

  it("labels values below the default band as Smaller", () => {
    expect(describeTooltipScale(0.5)).toBe("Smaller");
    expect(describeTooltipScale(0.84)).toBe("Smaller");
  });

  it("labels values above the default band as Larger", () => {
    expect(describeTooltipScale(2)).toBe("Larger");
    expect(describeTooltipScale(1.16)).toBe("Larger");
  });
});

describe("applyEdgeDrag", () => {
  const region = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 };

  it("dragging the right edge outward grows width only, x/y/height unchanged", () => {
    expect(applyEdgeDrag(region, ["right"], 0.1, 0)).toEqual({ x: 0.2, y: 0.3, width: 0.5, height: 0.3 });
  });

  it("dragging the left edge inward shrinks width and moves x, keeping the right edge exactly fixed", () => {
    const result = applyEdgeDrag(region, ["left"], 0.1, 0);
    expect(result.x).toBeCloseTo(0.3, 10);
    expect(result.width).toBeCloseTo(0.3, 10);
    expect(result.x + result.width).toBeCloseTo(region.x + region.width, 10); // right edge unmoved
  });

  it("dragging the bottom-right corner (two edges) reproduces the original single-handle resize behavior", () => {
    const result = applyEdgeDrag(region, ["right", "bottom"], 0.1, 0.05);
    expect(result.x).toBe(0.2);
    expect(result.y).toBe(0.3);
    expect(result.width).toBeCloseTo(0.5, 10);
    expect(result.height).toBeCloseTo(0.35, 10);
  });

  it("dragging the top edge moves y and shrinks height, keeping the bottom edge fixed", () => {
    const result = applyEdgeDrag(region, ["top"], 0, 0.1);
    expect(result.y).toBeCloseTo(0.4, 10);
    expect(result.height).toBeCloseTo(0.2, 10);
    expect(result.y + result.height).toBeCloseTo(region.y + region.height, 10);
  });

  it("dragging the bottom edge upward shrinks height only, y unchanged", () => {
    const result = applyEdgeDrag(region, ["bottom"], 0, -0.1);
    expect(result.y).toBe(0.3);
    expect(result.height).toBeCloseTo(0.2, 10);
  });

  it("never shrinks a dragged edge past MIN_REGION_SIZE, pinning the opposite edge", () => {
    const result = applyEdgeDrag(region, ["right"], -10, 0); // an absurd inward drag
    expect(result.width).toBeCloseTo(MIN_REGION_SIZE, 10);
    expect(result.x).toBe(0.2); // left edge (not being dragged) stays put
  });

  it("never drags an edge past the frame boundary [0, 1]", () => {
    const wide = applyEdgeDrag(region, ["right"], 10, 0);
    expect(wide.x + wide.width).toBeCloseTo(1, 10);

    const farLeft = applyEdgeDrag(region, ["left"], -10, 0);
    expect(farLeft.x).toBe(0);
  });

  it("a corner drag with edges on both axes moves both independently", () => {
    const result = applyEdgeDrag(region, ["left", "top"], -0.05, -0.05);
    expect(result.x).toBeCloseTo(0.15, 10);
    expect(result.y).toBeCloseTo(0.25, 10);
    expect(result.x + result.width).toBeCloseTo(region.x + region.width, 10);
    expect(result.y + result.height).toBeCloseTo(region.y + region.height, 10);
  });
});
