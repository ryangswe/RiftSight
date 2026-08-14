// Background-owned viewer subscriptions for YouTube tabs. Content scripts
// never touch the socket themselves (same division of labor as the
// producer side, and additionally load-bearing here: an MV3 content
// script's network requests are subject to the page's own CSP, and
// youtube.com's connect-src is not something this extension controls —
// the background worker's aren't). One RelaySocket per distinct channel,
// refcounted across however many YouTube tabs are watching it, torn down
// when the last tab leaves.
//
// Pure with respect to chrome.* — sockets come from the injectable factory
// (tests pass fakes; background.ts passes nothing and gets real
// WebSockets), and events go out through the constructor's callbacks.
// background.ts owns wiring those to ports.

import { RelaySocket, type RelaySocketStatus, type WebSocketLike } from "@riftsight/overlay-core";
import type { OverlayState, SubscribeRejectedReason } from "@riftsight/protocol";

export interface ViewerChannelEvents {
  onState(channelId: string, state: OverlayState): void;
  onRejected(channelId: string, reason: SubscribeRejectedReason): void;
  onStatusChange(channelId: string, status: RelaySocketStatus): void;
}

interface ChannelEntry {
  refCount: number;
  socket: RelaySocket;
  lastState: OverlayState | undefined;
  /** Set when the relay explicitly rejected this channel's subscribe — the socket is disconnected (standing down, not hammering) until reconcile() gives it another chance. */
  rejectedReason: SubscribeRejectedReason | undefined;
}

export class ViewerRelayManager {
  private readonly channels = new Map<string, ChannelEntry>();

  constructor(
    private readonly relayUrl: string,
    /** Which subscribe message this build speaks — {type:"youtube-subscribe"} in real builds, the dev-mode plain {type:"subscribe"} fallback against a local relay (see background.ts). */
    private readonly buildSubscribeMessage: (channelId: string) => unknown,
    private readonly events: ViewerChannelEvents,
    private readonly createSocket?: (url: string) => WebSocketLike
  ) {}

  /**
   * A tab started watching `channelId`. Opens the channel's socket on the
   * first acquire; later acquires just bump the refcount. Returns the
   * channel's last delivered state (if any) so a second tab joining an
   * already-live channel can render immediately instead of waiting for the
   * next producer tick.
   */
  acquire(channelId: string): { lastState: OverlayState | undefined } {
    const existing = this.channels.get(channelId);
    if (existing) {
      existing.refCount += 1;
      return { lastState: existing.lastState };
    }

    const entry: ChannelEntry = { refCount: 1, socket: this.createChannelSocket(channelId), lastState: undefined, rejectedReason: undefined };
    this.channels.set(channelId, entry);
    entry.socket.connect();
    return { lastState: undefined };
  }

  /** A tab stopped watching `channelId` (navigated away, closed, or switched channels). Disconnects and forgets the channel when the last tab leaves — no idle sockets held for pages nobody has open. */
  release(channelId: string): void {
    const entry = this.channels.get(channelId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.socket.disconnect();
    this.channels.delete(channelId);
  }

  lastStateFor(channelId: string): OverlayState | undefined {
    return this.channels.get(channelId)?.lastState;
  }

  /**
   * Alarm-driven second chance for rejected channels: a subscribe rejected
   * with unknown-channel stands the socket down (see onServerEvent below)
   * rather than retrying on RelaySocket's fast backoff — but "the streamer
   * hasn't claimed their channel YET" is recoverable mid-stream, so each
   * reconcile (once a minute, riding the existing reconnect-check alarm)
   * re-attempts every still-watched rejected channel once.
   */
  reconcile(): void {
    for (const entry of this.channels.values()) {
      if (entry.refCount <= 0 || entry.rejectedReason === undefined) continue;
      entry.rejectedReason = undefined;
      entry.socket.connect();
    }
  }

  /** Test/diagnostic-only, mirroring the relay's debugSessionCount pattern. */
  debugChannelCount(): number {
    return this.channels.size;
  }

  private createChannelSocket(channelId: string): RelaySocket {
    return new RelaySocket(
      this.relayUrl,
      () => this.buildSubscribeMessage(channelId),
      (status) => this.events.onStatusChange(channelId, status),
      this.createSocket,
      (event) => {
        const entry = this.channels.get(channelId);
        if (!entry) return;
        if (event.kind === "state") {
          entry.lastState = event.state;
          this.events.onState(channelId, event.state);
          return;
        }
        if (event.kind === "rejected") {
          entry.rejectedReason = event.reason;
          // Stand down instead of letting the socket sit subscribed-to-
          // nothing (or worse, retry-hammering a channel with no mapping).
          // reconcile() owns the slow retry.
          entry.socket.disconnect();
          this.events.onRejected(channelId, event.reason);
          return;
        }
        // "ping": nothing to do — receiving it at all is its job (MV3
        // service-worker lifetime, see protocol's PingMessageSchema).
      }
    );
  }
}
