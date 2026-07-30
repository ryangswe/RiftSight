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
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  overlayEnabled: true,
  delayMs: 0,
  debugOutlines: false,
  sourceAspectRatio: undefined,
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
      typeof obj["delayMs"] === "number" && Number.isFinite(obj["delayMs"]) && obj["delayMs"] >= 0
        ? obj["delayMs"]
        : DEFAULT_OVERLAY_CONFIG.delayMs,
    debugOutlines: typeof obj["debugOutlines"] === "boolean" ? obj["debugOutlines"] : DEFAULT_OVERLAY_CONFIG.debugOutlines,
    sourceAspectRatio:
      typeof obj["sourceAspectRatio"] === "number" && Number.isFinite(obj["sourceAspectRatio"]) && obj["sourceAspectRatio"] > 0
        ? obj["sourceAspectRatio"]
        : undefined,
  };
}

export function serializeOverlayConfig(config: OverlayConfig): string {
  return JSON.stringify(config);
}
