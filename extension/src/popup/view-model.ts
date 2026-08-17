// Pure view-model builders for the popup's Watch and Stream views — every
// meaningful UI state is computed here from raw statuses, DOM-free and
// unit-tested, so the popup's main.ts stays thin render glue (the repo's
// established pure-logic/thin-glue split). Copy lives here too: the popup
// speaks user concepts (Watch, Stream, Publishing, Connected), never
// implementation ones (producer, session, relay, claim).

import type { LinkState } from "../background/link-state.js";
import { LINK_STATUS_LABEL } from "../background/link-state.js";
import { idlePublishingMessage, type PresenceStatus } from "../background/presence.js";
import { describeStreamerError } from "../background/error-messages.js";
import type { WatchPageStatus } from "../shared/viewer-port.js";

/** Visual tone of a status line: ● on (green), ◐ waiting (yellow), ○ off (gray), ⚠ warn (amber text). */
export type StatusTone = "on" | "waiting" | "off" | "warn";

export interface StatusLine {
  tone: StatusTone;
  text: string;
}

// ---------------------------------------------------------------------------
// Watch view
// ---------------------------------------------------------------------------

export type WatchViewModel =
  | { kind: "enable" } // permission not granted: one clean CTA, nothing else
  | { kind: "status"; overlaysOn: boolean; page: StatusLine };

export interface WatchViewInput {
  permissionGranted: boolean;
  overlaysEnabled: boolean;
  /** The active tab's self-reported page status, or null when no RiftSight content script is there (not a YouTube tab). */
  page: WatchPageStatus | null;
}

export function buildWatchView(input: WatchViewInput): WatchViewModel {
  if (!input.permissionGranted) return { kind: "enable" };

  if (!input.overlaysEnabled) {
    return { kind: "status", overlaysOn: false, page: { tone: "off", text: "Overlays are off. Turn them on to use RiftSight." } };
  }

  const page = input.page;
  if (!page || page.pageKind === "other") {
    return { kind: "status", overlaysOn: true, page: { tone: "off", text: "Open a supported YouTube live stream to use RiftSight." } };
  }
  if (page.pageKind === "vod-watch") {
    return { kind: "status", overlaysOn: true, page: { tone: "off", text: "RiftSight overlays currently support live streams." } };
  }
  // live-watch
  switch (page.session) {
    case "active":
      return { kind: "status", overlaysOn: true, page: { tone: "on", text: "RiftSight active on this stream" } };
    case "waiting":
      return { kind: "status", overlaysOn: true, page: { tone: "waiting", text: "Ready — waiting for the streamer's game" } };
    case "unavailable":
    case "idle":
      // Quiet, not scary — most live streams simply aren't RiftSight streams.
      return { kind: "status", overlaysOn: true, page: { tone: "off", text: "RiftSight isn't available on this stream." } };
  }
}

// ---------------------------------------------------------------------------
// Stream view
// ---------------------------------------------------------------------------

export type PlatformRowState = "connected" | "not-connected" | "busy" | "coming-soon";

export interface PlatformRowModel {
  state: PlatformRowState;
  /** Display name / channel when connected; short helper otherwise. */
  detail: string | null;
  /** Whether a Connect action is offered on this row. */
  connectable: boolean;
}

export interface StreamViewModel {
  linked: boolean;
  atlas: StatusLine;
  publishing: StatusLine;
  primary: { label: string; action: "start" | "stop"; enabled: boolean };
  twitch: PlatformRowModel;
  youtube: PlatformRowModel;
  /** One warn/notice line under everything, or null — never a raw backend error string. */
  notice: string | null;
}

export interface StreamViewInput {
  link: LinkState;
  presence: PresenceStatus;
  publishingIntent: boolean;
  relayStatus: "connecting" | "connected" | "disconnected";
  producerReplaced: boolean;
  viewerCount: number | undefined;
  /** The streamer's linked YouTube channel per the backend claim endpoint; "unknown" while loading/unreachable. */
  youtubeClaim: { channelId: string | null; displayName: string | null } | "unknown";
}

const LINKING_IN_FLIGHT = new Set(["connecting", "waiting-for-authorization"]);

export function buildStreamView(input: StreamViewInput): StreamViewModel {
  const { link } = input;
  const linked = link.status === "connected" || link.status === "credential-expired" || link.status === "backend-unavailable";
  const linkBusy = LINKING_IN_FLIGHT.has(link.status);

  // Platform rows — independent axes, per the product model. The linked
  // account came in through ONE platform's door (link.platform); the other
  // platform is its own row with its own state.
  const twitch: PlatformRowModel =
    linked && link.platform === "twitch"
      ? { state: "connected", detail: link.displayName ?? null, connectable: false }
      : linked
        ? // Linked via YouTube: attaching Twitch to an existing account isn't wired yet (honest, not hidden).
          { state: "coming-soon", detail: "Linking to an existing account is coming soon", connectable: false }
        : linkBusy && link.platform === "twitch"
          ? { state: "busy", detail: "Waiting for authorization…", connectable: false }
          : { state: "not-connected", detail: null, connectable: !linkBusy };

  const youtubeFromLink = linked && link.platform === "youtube";
  const claim = input.youtubeClaim;
  const youtube: PlatformRowModel = youtubeFromLink
    ? { state: "connected", detail: link.displayName ?? null, connectable: false }
    : linked
      ? claim === "unknown"
        ? { state: "busy", detail: "Checking…", connectable: false }
        : claim.channelId
          ? { state: "connected", detail: claim.displayName ?? claim.channelId, connectable: false }
          : { state: "not-connected", detail: "Link in Settings", connectable: false }
      : linkBusy && link.platform === "youtube"
        ? { state: "busy", detail: "Waiting for authorization…", connectable: false }
        : { state: "not-connected", detail: null, connectable: !linkBusy };

  const atlas: StatusLine =
    input.presence === "active"
      ? { tone: "on", text: "Game detected" }
      : input.presence === "present-no-board"
        ? { tone: "waiting", text: "Rift Atlas open — waiting for a game" }
        : input.presence === "stale"
          ? { tone: "waiting", text: "Lost contact with Rift Atlas — reconnecting" }
          : { tone: "off", text: "Waiting for a game — open Rift Atlas" };

  let publishing: StatusLine;
  if (!input.publishingIntent) {
    publishing = { tone: "off", text: "Off" };
  } else if (input.producerReplaced) {
    publishing = { tone: "warn", text: "Publishing from another device took over" };
  } else if (input.presence !== "active") {
    publishing = { tone: "waiting", text: idlePublishingMessage(input.presence) };
  } else if (input.relayStatus === "connected") {
    const viewers = input.viewerCount === undefined ? "" : ` — ${input.viewerCount} viewer${input.viewerCount === 1 ? "" : "s"}`;
    publishing = { tone: "on", text: `Live${viewers}` };
  } else {
    publishing = { tone: "waiting", text: "Reconnecting…" };
  }

  const primary: StreamViewModel["primary"] = input.publishingIntent
    ? { label: "Stop publishing", action: "stop", enabled: true }
    : { label: "Start publishing", action: "start", enabled: linked };

  let notice: string | null = null;
  if (link.status === "not-in-beta" || link.status === "credential-expired" || link.status === "backend-unavailable") {
    notice = LINK_STATUS_LABEL[link.status];
  } else if (input.producerReplaced) {
    notice = describeStreamerError("producer-replaced");
  } else if (input.publishingIntent && input.relayStatus === "disconnected" && input.presence === "active") {
    notice = describeStreamerError("relay-reconnecting");
  }

  return { linked, atlas, publishing, primary, twitch, youtube, notice };
}
