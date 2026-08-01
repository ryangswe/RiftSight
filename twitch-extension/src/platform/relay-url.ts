import { RELAY_URL } from "@riftsight/protocol";

export interface ResolveRelayUrlOptions {
  isMock: boolean;
  /** The build-time-injected RIFTSIGHT_RELAY_URL value — empty string if unset. */
  configuredUrl: string;
  /** Whether the current page is a secure context (window.isSecureContext) — real Twitch pages always are; mock-mode localhost pages usually are too, but the mock branch never checks this. */
  isSecureContext: boolean;
}

/**
 * Decides which relay URL a Twitch-extension OverlayStateSource should
 * connect to. Pure — the actual globals (`__RIFTSIGHT_RELAY_URL__`,
 * `window.isSecureContext`) are read once at the call site and passed in,
 * so this can be unit-tested without a browser. Mirrors this repo's
 * established "pure logic tested, global-reading glue thin" pattern.
 *
 * - Mock mode always has somewhere sensible to connect: an explicit
 *   configured URL if given (rare, but not forbidden), otherwise
 *   RELAY_URL (localhost) for convenience — mock mode predates any of
 *   this and must keep working with zero configuration.
 * - Real Twitch mode never silently falls back to localhost: a missing
 *   configured URL is an error worth surfacing (nothing to connect to,
 *   not "quietly connect to a browser-inaccessible localhost address"),
 *   and in a secure context (real Twitch, always HTTPS) a `ws:` URL is
 *   rejected outright — mixed content the browser would block anyway,
 *   but failing fast here gives a much clearer diagnostic than a silent
 *   WebSocket connection failure.
 */
export function resolveRelayUrl(options: ResolveRelayUrlOptions): string {
  if (options.isMock) {
    return options.configuredUrl || RELAY_URL;
  }

  if (!options.configuredUrl) {
    throw new Error(
      "RIFTSIGHT_RELAY_URL is not configured — the Twitch viewer has no relay URL to connect to. Rebuild with RIFTSIGHT_RELAY_URL set to your public wss:// relay endpoint."
    );
  }

  if (options.isSecureContext && !options.configuredUrl.startsWith("wss:")) {
    throw new Error(
      `RIFTSIGHT_RELAY_URL must use wss: when served from a secure Twitch context — got "${options.configuredUrl}". A ws: URL would be blocked as mixed content anyway; this fails fast with a clearer diagnostic instead.`
    );
  }

  return options.configuredUrl;
}

/** Thin wrapper reading the real build-time/runtime globals — call this at the actual connection site, not resolveRelayUrl directly, so tests exercise the pure function instead. */
export function getConfiguredRelayUrl(isMock: boolean): string {
  return resolveRelayUrl({
    isMock,
    configuredUrl: __RIFTSIGHT_RELAY_URL__,
    isSecureContext: window.isSecureContext,
  });
}
