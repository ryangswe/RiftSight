// Maps technical failure signals to concise, actionable streamer-facing
// text — detailed diagnostics stay in the console/background-worker logs;
// this module is the only thing a streamer actually reads. Pure lookup, no
// side effects, so it also doubles as the onboarding doc's source of truth
// for the technical->friendly mapping (see README's "Streamer-facing error
// handling" table, which mirrors this file's keys).
//
// Deliberately does NOT cover link-state.ts's own states (not-connected,
// connecting, waiting-for-authorization, connected, credential-expired,
// backend-unavailable) — those already have friendly labels in
// LINK_STATUS_LABEL. This module covers producer-connection failures that
// can happen after linking has already succeeded.

export type StreamerErrorCode = "backend-unreachable" | "producer-replaced" | "relay-reconnecting";

export const STREAMER_ERROR_MESSAGE: Record<StreamerErrorCode, string> = {
  "backend-unreachable":
    "Can't reach the RiftSight backend right now. Check your internet connection — RiftSight will keep retrying automatically.",
  "producer-replaced":
    "Another RiftSight connection took over publishing for your channel. If that wasn't you, reconnect Twitch to get a new producer credential.",
  "relay-reconnecting": "Lost connection to the RiftSight backend — reconnecting automatically.",
};

export function describeStreamerError(code: StreamerErrorCode): string {
  return STREAMER_ERROR_MESSAGE[code];
}
