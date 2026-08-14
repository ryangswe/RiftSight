// Normalizes whatever a streamer pastes into the popup's "YouTube
// channel" field down to a canonical UC... id, or null if it can't be
// done unambiguously. Accepts the two forms a streamer can actually
// copy from YouTube Studio / a channel page URL bar: the bare id, or any
// URL containing /channel/UC... . Handles (@name) and custom URLs are
// deliberately rejected rather than guessed at — resolving them requires
// a YouTube API call this extension doesn't make (see the milestone's
// out-of-scope list), and the popup's helper text tells the streamer
// where to find the real id.

import { YOUTUBE_CHANNEL_ID_PATTERN } from "@riftsight/protocol";

export function parseYouTubeChannelInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (YOUTUBE_CHANNEL_ID_PATTERN.test(trimmed)) return trimmed;

  // URL form — tolerate a missing scheme ("www.youtube.com/channel/UC...").
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    const match = url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?:$|[/?#])/);
    if (match?.[1] && YOUTUBE_CHANNEL_ID_PATTERN.test(match[1])) return match[1];
  } catch {
    // fall through — not a URL either
  }
  return null;
}
