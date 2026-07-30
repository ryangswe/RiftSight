import type { ViewerPlatformContext } from "@riftsight/overlay-core";
import type { TwitchAuthObject } from "../twitch-ext.js";

/**
 * Pure adaptation from Twitch's auth object to this app's own
 * platform-agnostic ViewerPlatformContext — channelId/token always come
 * from here, never from URL parsing. Kept separate from main.ts's
 * onAuthorized wiring (which does need window.Twitch) so this mapping is
 * unit-testable on its own.
 */
export function buildPlatformContext(auth: TwitchAuthObject, mode: ViewerPlatformContext["mode"] = "viewer"): ViewerPlatformContext {
  return {
    channelId: auth.channelId,
    authToken: auth.token,
    mode,
  };
}
