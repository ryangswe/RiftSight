// Local ambient types for window.Twitch.ext (the Extensions JS Helper,
// loaded via a <script> tag pointing at
// https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js — see
// viewer.html). Twitch doesn't publish an official npm types package, so
// this covers only the fields/callbacks this app actually uses, sourced
// from https://dev.twitch.tv/docs/extensions/reference/ rather than `any`.
export {};

export interface TwitchAuthObject {
  /** Channel ID where the extension is embedded. */
  channelId: string;
  /** The extension's own client ID. */
  clientId: string;
  /** JWT for calls to our own backend (EBS). Refreshed periodically — onAuthorized fires again each time. */
  token: string;
  /** JWT for Twitch's own front-end API requests. Unused by this app so far. */
  helixToken: string;
  /** Opaque, per-viewer user id. */
  userId: string;
}

export interface TwitchExtensionContext {
  displayResolution?: string;
  videoResolution?: string;
  arePlayerControlsVisible?: boolean;
  isFullScreen?: boolean;
  isTheatreMode?: boolean;
  [key: string]: unknown;
}

export interface TwitchConfigurationSegment {
  version: string;
  content: string;
}

export interface TwitchConfigurationService {
  broadcaster?: TwitchConfigurationSegment;
  global?: TwitchConfigurationSegment;
  developer?: TwitchConfigurationSegment;
  set(segment: "broadcaster" | "developer", version: string, content: string): void;
  onChanged(callback: () => void): void;
}

export interface TwitchExtensionHelper {
  onAuthorized(callback: (auth: TwitchAuthObject) => void): void;
  onError(callback: (error: unknown) => void): void;
  onContext(callback: (context: TwitchExtensionContext, changedProperties: string[]) => void): void;
  onVisibilityChanged(callback: (isVisible: boolean, context?: TwitchExtensionContext) => void): void;
  configuration: TwitchConfigurationService;
}

declare global {
  interface Window {
    Twitch?: {
      ext: TwitchExtensionHelper;
    };
  }
}
