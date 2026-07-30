import type { OverlayState } from "@riftsight/protocol";

// The seam between "how do I get an authenticated stream of OverlayState"
// (platform-specific: a plain local-relay client, a Twitch JWT-authed
// client, a mock adapter for dev) and "how do I turn OverlayState into
// hitboxes + tooltips" (render.ts/tooltip.ts/mode.ts below, which never
// need to know which platform they're running under).

export interface ViewerPlatformContext {
  channelId: string;
  authToken: string;
  mode: "viewer" | "dashboard" | "config";
}

export interface OverlayStateSource {
  connect(context: ViewerPlatformContext): void;
  disconnect(): void;
  /** Returns an unsubscribe function, mirroring DOM/observable convention. */
  subscribe(listener: (state: OverlayState) => void): () => void;
}
