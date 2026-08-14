// Per-viewer YouTube overlay preferences — chrome.storage.local-backed,
// parsed with the same always-returns-something-safe contract as
// parseOverlayConfig. These are the VIEWER's own knobs (the gear control),
// deliberately separate from the broadcaster's wire config: delayMs null
// means "I haven't chosen — use the broadcaster's recommendation or the
// platform default" (see resolveViewerDelayMs).

export const STORAGE_KEY_VIEWER_PREFS = "riftsight.youtubeViewerPrefs";

/** Matches the Twitch config page's MAX_DELAY_MS rationale: the history buffer can only serve what it retains. YouTube's own latency modes top out well under this. */
export const MAX_VIEWER_DELAY_MS = 60_000;

/** Default when neither the viewer nor the broadcaster has said anything — YouTube "Normal latency" runs ~8-15s glass-to-glass; 12s lands the overlay near the video for the default case, and the slider exists because no fixed number is right for everyone. */
export const DEFAULT_YOUTUBE_DELAY_MS = 12_000;

export interface YouTubeViewerPrefs {
  enabled: boolean;
  /** null = no explicit choice; see resolveViewerDelayMs. */
  delayMs: number | null;
  outlines: boolean;
}

export const DEFAULT_VIEWER_PREFS: YouTubeViewerPrefs = {
  enabled: true,
  delayMs: null,
  outlines: false,
};

export function parseViewerPrefs(raw: unknown): YouTubeViewerPrefs {
  if (typeof raw !== "object" || raw === null) return DEFAULT_VIEWER_PREFS;
  const obj = raw as Record<string, unknown>;
  return {
    enabled: typeof obj["enabled"] === "boolean" ? obj["enabled"] : DEFAULT_VIEWER_PREFS.enabled,
    delayMs:
      typeof obj["delayMs"] === "number" && Number.isFinite(obj["delayMs"]) && obj["delayMs"] >= 0 && obj["delayMs"] <= MAX_VIEWER_DELAY_MS
        ? obj["delayMs"]
        : null,
    outlines: typeof obj["outlines"] === "boolean" ? obj["outlines"] : DEFAULT_VIEWER_PREFS.outlines,
  };
}
