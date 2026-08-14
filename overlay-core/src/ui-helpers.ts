import type { SourceRegion } from "./source-region.js";

// Pure UI-boundary helpers for the config page's redesigned controls — kept
// separate from main.ts (thin DOM glue, not unit-tested, same convention as
// the rest of this codebase) so the actual decision logic behind the
// preset/delay/scale controls is directly testable.

/** The four fixed delay presets shown as pills, in ms — anything else is "custom". */
export const DELAY_PRESETS_MS: readonly number[] = [0, 2000, 5000, 10000];

/** Which delay preset pill (if any) the given delayMs exactly matches. */
export function matchDelayPreset(delayMs: number): number | "custom" {
  return DELAY_PRESETS_MS.includes(delayMs) ? delayMs : "custom";
}

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function msToSeconds(ms: number): number {
  return ms / 1000;
}

/**
 * Which named region preset (if any) the given region exactly matches —
 * drives which preset pill shows as pressed. Exact equality is correct
 * here (not a tolerance check): presets are exact constants, and any
 * region reached via drag/resize goes through clampSourceRegion's
 * arithmetic, which won't spuriously land on exactly the same floats.
 */
export function matchRegionPreset<K extends string>(
  region: SourceRegion,
  presets: Record<K, SourceRegion>
): K | "custom" {
  for (const key in presets) {
    const preset = presets[key];
    if (region.x === preset.x && region.y === preset.y && region.width === preset.width && region.height === preset.height) {
      return key;
    }
  }
  return "custom";
}

/** Bucketed, human-readable label for the popup-size slider's current value (drives aria-valuetext). */
export function describeTooltipScale(scale: number): "Smaller" | "Default" | "Larger" {
  if (scale < 0.85) return "Smaller";
  if (scale > 1.15) return "Larger";
  return "Default";
}

/** A side of the region rectangle a resize handle can drag. Corner handles drag two at once. */
export type RegionEdge = "left" | "right" | "top" | "bottom";

/** Smallest width/height a region can be dragged down to — small enough to be unintrusive, large enough to stay grabbable. */
export const MIN_REGION_SIZE = 0.02;

/**
 * Resizes a region by dragging one or two of its edges — the general form
 * of the calibration preview's resize handles (a corner handle drags two
 * adjacent edges, a mid-edge handle drags just one). Edges not included in
 * `edges` stay exactly where they started, which is what makes this
 * different from just clamping the final x/y/width/height as a whole:
 * dragging the left edge inward must never move the right edge, even once
 * the region hits its minimum width or the frame boundary.
 */
export function applyEdgeDrag(start: SourceRegion, edges: readonly RegionEdge[], fracDx: number, fracDy: number): SourceRegion {
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  if (edges.includes("left")) {
    left = Math.min(Math.max(left + fracDx, 0), right - MIN_REGION_SIZE);
  }
  if (edges.includes("right")) {
    right = Math.max(Math.min(right + fracDx, 1), left + MIN_REGION_SIZE);
  }
  if (edges.includes("top")) {
    top = Math.min(Math.max(top + fracDy, 0), bottom - MIN_REGION_SIZE);
  }
  if (edges.includes("bottom")) {
    bottom = Math.max(Math.min(bottom + fracDy, 1), top + MIN_REGION_SIZE);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
