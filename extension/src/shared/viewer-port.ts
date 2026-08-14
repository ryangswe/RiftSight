// The long-lived Port contract between a YouTube-tab content script and
// the background worker's ViewerRelayManager — typed in one shared module
// so the two sides can't drift. A port (chrome.runtime.connect) rather
// than one-shot messages because both directions need it: the content
// script re-announces its channel on SPA navigation, the background
// streams states back, and the port's own disconnect event IS the
// refcount-release signal when the tab closes or navigates away — no
// heartbeat or timeout bookkeeping needed.

import type { OverlayState, SubscribeRejectedReason } from "@riftsight/protocol";
import type { RelaySocketStatus } from "@riftsight/overlay-core";

export const YOUTUBE_VIEWER_PORT = "riftsight-youtube-viewer";

/** Content script -> background. channelId null = "this tab is no longer on a live watch page" (SPA-navigated away) without tearing the port down. */
export type ViewerPortMessageFromContent = { type: "watch-channel"; channelId: string | null };

/** Background -> content script. */
export type ViewerPortMessageToContent =
  | { type: "overlay-state"; state: OverlayState }
  | { type: "subscribe-rejected"; reason: SubscribeRejectedReason }
  | { type: "relay-status"; status: RelaySocketStatus };
