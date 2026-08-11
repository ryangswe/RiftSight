// Pure account-linking state machine — deliberately DOM/chrome.*-free so
// it's directly unit-testable, matching this repo's established "pure
// logic tested, browser glue thin" pattern. auth.ts (the chrome.storage/
// fetch/chrome.tabs glue) is the only caller; it translates real events
// (poll responses, tab lifecycle) into LinkEvents and applies them here.

export type LinkStatus =
  | "not-connected"
  | "connecting"
  | "waiting-for-authorization"
  | "connected"
  | "credential-expired"
  | "backend-unavailable"
  | "not-in-beta";

export interface LinkState {
  status: LinkStatus;
  /** Set once status is "connected" (and retained through a later credential-expired/backend-unavailable, so the UI can still say "connected as X, but..."). */
  displayName: string | undefined;
}

export const INITIAL_LINK_STATE: LinkState = { status: "not-connected", displayName: undefined };

export type LinkEvent =
  | { type: "start-link" }
  | { type: "poll-pending" }
  | { type: "poll-ready"; displayName: string }
  | { type: "poll-not-found" }
  | { type: "poll-rejected" }
  | { type: "poll-error" }
  | { type: "disconnect" }
  | { type: "credential-rejected" };

export function reduceLinkState(current: LinkState, event: LinkEvent): LinkState {
  switch (event.type) {
    case "start-link":
      return { status: "connecting", displayName: undefined };
    case "poll-pending":
      return { status: "waiting-for-authorization", displayName: undefined };
    case "poll-ready":
      return { status: "connected", displayName: event.displayName };
    case "poll-not-found":
      // The link attempt expired or was never valid (e.g. the user closed
      // the Twitch tab without authorizing) — back to square one, not an
      // error state, since nothing was ever connected.
      return { status: "not-connected", displayName: undefined };
    case "poll-rejected":
      // The backend explicitly determined this Twitch account isn't on the
      // closed-beta allowlist (relay's auth-twitch.ts) — distinct from
      // poll-not-found (link attempt merely expired/abandoned) so the UI
      // can say exactly what happened instead of silently reverting to
      // "not connected" after a multi-minute poll timeout.
      return { status: "not-in-beta", displayName: undefined };
    case "poll-error":
      return { status: "backend-unavailable", displayName: current.displayName };
    case "disconnect":
      return { status: "not-connected", displayName: undefined };
    case "credential-rejected":
      // The relay refused our stored credential (revoked, e.g. removed
      // from the beta allowlist, or otherwise no longer valid) — distinct
      // from never having linked at all, so the UI can say "reconnect"
      // rather than "connect for the first time".
      return { status: "credential-expired", displayName: current.displayName };
    default:
      return current;
  }
}

export const LINK_STATUS_LABEL: Record<LinkStatus, string> = {
  "not-connected": "Not connected to Twitch",
  connecting: "Opening Twitch authorization…",
  "waiting-for-authorization": "Waiting for authorization to complete…",
  connected: "Connected", // callers append "as <displayName>" themselves
  "credential-expired": "Producer credential expired — reconnect to Twitch",
  "backend-unavailable": "RiftSight backend unavailable — try again shortly",
  "not-in-beta": "This Twitch account isn't part of the RiftSight closed beta yet. Email riftsight.support@gmail.com to request access.",
};
