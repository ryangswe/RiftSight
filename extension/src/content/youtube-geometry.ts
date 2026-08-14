// Pure geometry/decision helpers for the YouTube viewer content script —
// extracted from the DOM glue (youtube-viewer.ts) so the math that
// determines where the overlay sits and how it behaves is unit-testable
// in plain Node, per this repo's established pattern (settle.ts,
// producer-url.ts, ...).

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the actual video CONTENT sits inside an element's box, contain-fit
 * (letterbox/pillarbox) — YouTube normally sizes its <video> element to
 * the content already, but not always (theater mode's fixed-height stage,
 * odd aspect sources), so the overlay always maps onto this rect rather
 * than trusting the element box. Zero/invalid intrinsic dimensions return
 * the container unchanged (nothing better to map onto before
 * loadedmetadata).
 */
export function computeContainedRect(container: RectLike, intrinsicWidth: number, intrinsicHeight: number): RectLike {
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0) || !(container.width > 0) || !(container.height > 0)) {
    return container;
  }
  const scale = Math.min(container.width / intrinsicWidth, container.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  return {
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  };
}

/** The delay the viewer actually gets: their own explicit setting wins; otherwise the broadcaster's recommendation off the wire; otherwise the platform default. */
export function resolveViewerDelayMs(
  viewerSettingMs: number | null,
  recommendedDelayMs: number | undefined,
  platformDefaultMs: number
): number {
  if (viewerSettingMs !== null && Number.isFinite(viewerSettingMs) && viewerSettingMs >= 0) return viewerSettingMs;
  if (recommendedDelayMs !== undefined && Number.isFinite(recommendedDelayMs) && recommendedDelayMs >= 0) return recommendedDelayMs;
  return platformDefaultMs;
}

/**
 * Responsive tooltip scaling: the base popup sizes (320/400px wide — see
 * overlay-core/tooltip.ts) assume a full-size stream canvas, and a
 * YouTube player is often a fraction of that. Same shape as the landing
 * demo's scaleForStage clamp, multiplied by the broadcaster's own
 * configured tooltipScale so their preference still applies
 * proportionally at any player size.
 */
export function scaleTooltipForStage(stageWidth: number, configTooltipScale: number): number {
  const responsive = Math.min(Math.max(stageWidth / 960, 0.45), 1.25);
  return responsive * configTooltipScale;
}
