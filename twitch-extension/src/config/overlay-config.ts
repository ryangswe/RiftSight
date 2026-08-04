import { FULL_FRAME_SOURCE_REGION, parseSourceRegion, type SourceRegion } from "@riftsight/overlay-core";

// The broadcaster-configurable overlay settings, and their defaults.
// Deliberately minimal (see the milestone's "minimal broadcaster
// configuration page" scope) — content is a JSON string stored via
// Twitch's configuration.set("broadcaster", OVERLAY_CONFIG_VERSION,
// content), read back via configuration.broadcaster.content. Applies to
// every viewer of the channel (Twitch's broadcaster config segment isn't
// per-viewer) — debugOutlines being off by default here is what keeps
// debug mode off for normal viewers unless the broadcaster explicitly
// turns it on for their own testing.
export const OVERLAY_CONFIG_VERSION = "1";

export interface OverlayConfig {
  overlayEnabled: boolean;
  delayMs: number;
  debugOutlines: boolean;
  /** width/height, e.g. 1.778 for 16:9. Undefined = derive from each state's own sourceViewport instead of a fixed broadcaster override. */
  sourceAspectRatio: number | undefined;
  /** Where RiftAtlas sits within the final stream canvas — see overlay-core/src/source-region.ts. Always present (never optional) so every consumer can rely on it without an extra undefined-check; a config saved before this field existed parses to FULL_FRAME_SOURCE_REGION, preserving the old full-frame-only behavior exactly. */
  sourceRegion: SourceRegion;
  /**
   * Multiplier applied uniformly to both the portrait and landscape
   * tooltip base sizes (see overlay-core/src/tooltip.ts's
   * computeTooltipMaxSize) — a single scale rather than two independent
   * sizes, so the existing portrait/landscape size relationship stays
   * intact. 1 = today's default sizes, unchanged. Always present (never
   * optional), same reasoning as sourceRegion above — a config saved
   * before this field existed parses to 1, preserving old behavior
   * exactly.
   */
  tooltipScale: number;
}

/** Inclusive bounds a saved tooltipScale must fall within, or it's rejected back to the default — small enough to stay legible, large enough to be a meaningfully bigger popup without dwarfing the stream. */
export const MIN_TOOLTIP_SCALE = 0.5;
export const MAX_TOOLTIP_SCALE = 2;

/**
 * Upper bound a saved delayMs must fall within, or it's rejected back to
 * the default. This isn't an arbitrary UX limit — it exists because the
 * viewer's TimeWindowBuffer (see viewer/main.ts) can only serve a delayed
 * lookup as far back as it has actually retained history for. A real
 * incident: with no bound here and the buffer's own 60s default retention,
 * a broadcaster setting a delay above ~60s (not unusual — 2-3 minute
 * anti-stream-sniping delays are common for competitive games) got a
 * permanently blank overlay with no error surfaced to anyone, since
 * findAtOrBefore() would never find a state old enough. 5 minutes
 * comfortably covers realistic anti-snipe/moderation delay use cases while
 * keeping the buffer's memory footprint bounded; viewer/main.ts's
 * TimeWindowBuffer is constructed with matching retention (plus a small
 * margin — see its own comment) specifically so this bound is never a lie.
 */
export const MAX_DELAY_MS = 5 * 60 * 1000;

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  overlayEnabled: true,
  delayMs: 0,
  debugOutlines: false,
  sourceAspectRatio: undefined,
  sourceRegion: FULL_FRAME_SOURCE_REGION,
  tooltipScale: 1,
};

/**
 * Parses a stored configuration.broadcaster.content string, falling back
 * to defaults for anything missing, malformed, or out of range — a
 * broadcaster's bad/stale config must never crash the overlay for every
 * viewer of that channel.
 */
export function parseOverlayConfig(content: string | undefined): OverlayConfig {
  if (!content) return DEFAULT_OVERLAY_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return DEFAULT_OVERLAY_CONFIG;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_OVERLAY_CONFIG;
  const obj = raw as Record<string, unknown>;

  return {
    overlayEnabled: typeof obj["overlayEnabled"] === "boolean" ? obj["overlayEnabled"] : DEFAULT_OVERLAY_CONFIG.overlayEnabled,
    delayMs:
      typeof obj["delayMs"] === "number" &&
      Number.isFinite(obj["delayMs"]) &&
      obj["delayMs"] >= 0 &&
      obj["delayMs"] <= MAX_DELAY_MS
        ? obj["delayMs"]
        : DEFAULT_OVERLAY_CONFIG.delayMs,
    debugOutlines: typeof obj["debugOutlines"] === "boolean" ? obj["debugOutlines"] : DEFAULT_OVERLAY_CONFIG.debugOutlines,
    sourceAspectRatio:
      typeof obj["sourceAspectRatio"] === "number" && Number.isFinite(obj["sourceAspectRatio"]) && obj["sourceAspectRatio"] > 0
        ? obj["sourceAspectRatio"]
        : undefined,
    // parseSourceRegion already has its own complete "always return
    // something safe" fallback (undefined input -> full frame), so a
    // config saved before sourceRegion existed migrates transparently.
    sourceRegion: parseSourceRegion(obj["sourceRegion"]),
    tooltipScale:
      typeof obj["tooltipScale"] === "number" &&
      Number.isFinite(obj["tooltipScale"]) &&
      obj["tooltipScale"] >= MIN_TOOLTIP_SCALE &&
      obj["tooltipScale"] <= MAX_TOOLTIP_SCALE
        ? obj["tooltipScale"]
        : DEFAULT_OVERLAY_CONFIG.tooltipScale,
  };
}

export function serializeOverlayConfig(config: OverlayConfig): string {
  return JSON.stringify(config);
}
