import { describe, expect, it } from "vitest";
import {
  FULL_FRAME_SOURCE_REGION,
  SOURCE_REGION_PRESETS,
  isValidSourceRegion,
  mapBoundsToSourceRegion,
  mapSizeToSourceRegion,
  parseSourceRegion,
  type SourceRegion,
} from "./source-region.js";

describe("mapBoundsToSourceRegion", () => {
  it("is an identity mapping for the full-frame region", () => {
    const bounds = { x: 0.25, y: 0.4, width: 0.1, height: 0.15 };
    expect(mapBoundsToSourceRegion(bounds, FULL_FRAME_SOURCE_REGION)).toEqual(bounds);
  });

  it("maps into a preset region (sanity check that presets are wired to the same generic offset+scale formula)", () => {
    const bounds = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }; // dead center of RiftAtlas
    expect(mapBoundsToSourceRegion(bounds, SOURCE_REGION_PRESETS.leftHalf)).toEqual({
      x: 0.25, // 0 + 0.5 * 0.5
      y: 0.5, // 0 + 0.5 * 1
      width: 0.1, // 0.2 * 0.5
      height: 0.2, // 0.2 * 1
    });
  });

  it("maps with a custom offset and scale", () => {
    const region: SourceRegion = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
    const bounds = { x: 0.5, y: 0.5, width: 0.1, height: 0.05 };
    expect(mapBoundsToSourceRegion(bounds, region)).toEqual({
      x: 0.2 + 0.5 * 0.6,
      y: 0.1 + 0.5 * 0.7,
      width: 0.1 * 0.6,
      height: 0.05 * 0.7,
    });
  });

  it("maps a card touching all four RiftAtlas-relative edges correctly", () => {
    const region: SourceRegion = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    // top-left corner card
    expect(mapBoundsToSourceRegion({ x: 0, y: 0, width: 0.1, height: 0.1 }, region)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.05,
      height: 0.05,
    });
    // bottom-right corner card (x+width=1, y+height=1)
    expect(mapBoundsToSourceRegion({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, region)).toEqual({
      x: 0.25 + 0.9 * 0.5,
      y: 0.25 + 0.9 * 0.5,
      width: 0.05,
      height: 0.05,
    });
    // spans the full left edge (x=0, width=1 relative to RiftAtlas... use full row)
    expect(mapBoundsToSourceRegion({ x: 0, y: 0.5, width: 1, height: 0.1 }, region).x).toBe(0.25);
    // spans the full top edge
    expect(mapBoundsToSourceRegion({ x: 0.5, y: 0, width: 0.1, height: 1 }, region).y).toBe(0.25);
  });

  it("does not read or alter rotation — only x/y/width/height are part of its input/output", () => {
    // A rotated card's `bounds` is still just an axis-aligned box; rotation
    // is a separate field applied downstream as a CSS transform. This
    // mapping only ever touches bounds, so passing a "rotated" bounds
    // object (indistinguishable from a non-rotated one at this layer)
    // proves rotation composes independently rather than needing any
    // special-casing here.
    const bounds = { x: 0.4, y: 0.4, width: 0.2, height: 0.3 };
    const region = SOURCE_REGION_PRESETS.centered;
    const mapped = mapBoundsToSourceRegion(bounds, region);
    expect(mapped).toEqual({
      x: region.x + bounds.x * region.width,
      y: region.y + bounds.y * region.height,
      width: bounds.width * region.width,
      height: bounds.height * region.height,
    });
  });

  it("returns a new object, never mutating its inputs", () => {
    const bounds = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
    const region = { ...SOURCE_REGION_PRESETS.centered };
    const boundsCopy = { ...bounds };
    const regionCopy = { ...region };
    mapBoundsToSourceRegion(bounds, region);
    expect(bounds).toEqual(boundsCopy);
    expect(region).toEqual(regionCopy);
  });
});

describe("mapSizeToSourceRegion", () => {
  it("is an identity mapping for the full-frame region", () => {
    const size = { width: 0.1, height: 0.15 };
    expect(mapSizeToSourceRegion(size, FULL_FRAME_SOURCE_REGION)).toEqual(size);
  });

  it("scales each axis independently, with no x/y translation applied (unlike bounds)", () => {
    const size = { width: 0.2, height: 0.4 };
    const region: SourceRegion = { x: 0.3, y: 0.1, width: 0.5, height: 0.25 };
    expect(mapSizeToSourceRegion(size, region)).toEqual({
      width: 0.2 * 0.5,
      height: 0.4 * 0.25,
    });
  });

  it("applies the same per-axis scale factors mapBoundsToSourceRegion uses for width/height", () => {
    const bounds = { x: 0.4, y: 0.4, width: 0.2, height: 0.3 };
    const region = SOURCE_REGION_PRESETS.leftHalf;
    const mappedBounds = mapBoundsToSourceRegion(bounds, region);
    const mappedSize = mapSizeToSourceRegion({ width: bounds.width, height: bounds.height }, region);
    expect(mappedSize).toEqual({ width: mappedBounds.width, height: mappedBounds.height });
  });
});

describe("isValidSourceRegion", () => {
  it("accepts the full-frame region and all presets", () => {
    expect(isValidSourceRegion(FULL_FRAME_SOURCE_REGION)).toBe(true);
    for (const preset of Object.values(SOURCE_REGION_PRESETS)) {
      expect(isValidSourceRegion(preset)).toBe(true);
    }
  });

  it("rejects non-finite values", () => {
    expect(isValidSourceRegion({ x: Infinity, y: 0, width: 0.5, height: 0.5 })).toBe(false);
    expect(isValidSourceRegion({ x: 0, y: NaN, width: 0.5, height: 0.5 })).toBe(false);
    expect(isValidSourceRegion({ x: 0, y: 0, width: -Infinity, height: 0.5 })).toBe(false);
  });

  it("rejects non-positive width/height", () => {
    expect(isValidSourceRegion({ x: 0, y: 0, width: 0, height: 0.5 })).toBe(false);
    expect(isValidSourceRegion({ x: 0, y: 0, width: 0.5, height: -0.1 })).toBe(false);
  });

  it("rejects negative x/y", () => {
    expect(isValidSourceRegion({ x: -0.01, y: 0, width: 0.5, height: 0.5 })).toBe(false);
    expect(isValidSourceRegion({ x: 0, y: -0.5, width: 0.5, height: 0.5 })).toBe(false);
  });

  it("rejects x + width exceeding 1", () => {
    expect(isValidSourceRegion({ x: 0.6, y: 0, width: 0.5, height: 0.5 })).toBe(false);
  });

  it("rejects y + height exceeding 1", () => {
    expect(isValidSourceRegion({ x: 0, y: 0.6, width: 0.5, height: 0.5 })).toBe(false);
  });

  it("tolerates float rounding right at the edge (e.g. thirds summing to just over 1)", () => {
    const region = { x: 1 / 3, y: 0, width: 2 / 3, height: 1 }; // sums to 1.0000000000000002
    expect(isValidSourceRegion(region)).toBe(true);
  });

  it("still rejects a sum meaningfully over 1, not just at float-rounding scale", () => {
    expect(isValidSourceRegion({ x: 0.5, y: 0, width: 0.6, height: 0.5 })).toBe(false);
  });

  it("accepts a region touching the frame's exact edges (x+width===1, y+height===1)", () => {
    expect(isValidSourceRegion({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toBe(true);
  });
});

describe("parseSourceRegion", () => {
  it("returns full frame for undefined/null/non-object input", () => {
    expect(parseSourceRegion(undefined)).toEqual(FULL_FRAME_SOURCE_REGION);
    expect(parseSourceRegion(null)).toEqual(FULL_FRAME_SOURCE_REGION);
    expect(parseSourceRegion("not an object")).toEqual(FULL_FRAME_SOURCE_REGION);
    expect(parseSourceRegion(42)).toEqual(FULL_FRAME_SOURCE_REGION);
  });

  it("returns full frame when fields are missing or the wrong type", () => {
    expect(parseSourceRegion({ x: 0.1, y: 0.1 })).toEqual(FULL_FRAME_SOURCE_REGION);
    expect(parseSourceRegion({ x: "0.1", y: 0.1, width: 0.5, height: 0.5 })).toEqual(FULL_FRAME_SOURCE_REGION);
  });

  it("returns full frame for a structurally-complete but invalid region", () => {
    expect(parseSourceRegion({ x: 0.9, y: 0, width: 0.5, height: 0.5 })).toEqual(FULL_FRAME_SOURCE_REGION);
    expect(parseSourceRegion({ x: 0, y: 0, width: Infinity, height: 0.5 })).toEqual(FULL_FRAME_SOURCE_REGION);
  });

  it("parses a valid region as-is", () => {
    const region = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
    expect(parseSourceRegion(region)).toEqual(region);
  });
});
