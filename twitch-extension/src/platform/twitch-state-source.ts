import { TwitchSubscribeMessageSchema, type OverlayState, type TwitchSubscribeMessage } from "@riftsight/protocol";
import type { OverlayStateSource, ViewerPlatformContext } from "@riftsight/overlay-core";
import { RelaySocket, type RelaySocketStatus, type WebSocketLike } from "./relay-socket.js";

export type TwitchConnectionStatus = RelaySocketStatus;

/**
 * Real Twitch-authenticated OverlayStateSource. Never touches
 * window.Twitch itself — main.ts's onAuthorized handler is what builds
 * the ViewerPlatformContext (channelId + JWT) and calls connect() here,
 * keeping this class just as portable/testable as MockOverlayStateSource.
 * Sends a `twitch-subscribe` { channelId, token } message that the relay
 * verifies against the extension secret and the JWT's own channel_id
 * claim (see relay/src/twitch-auth.ts) before admitting the viewer.
 */
export class TwitchOverlayStateSource implements OverlayStateSource {
  private channelId = "";
  private token = "";
  private readonly socket: RelaySocket;

  constructor(
    onStatusChange: (status: TwitchConnectionStatus) => void = () => {},
    createSocket?: (url: string) => WebSocketLike
  ) {
    this.socket = new RelaySocket(() => this.buildSubscribeMessage(), onStatusChange, createSocket);
  }

  private buildSubscribeMessage(): TwitchSubscribeMessage {
    return TwitchSubscribeMessageSchema.parse({ type: "twitch-subscribe", channelId: this.channelId, token: this.token });
  }

  /** Exposed for testing — the message this source would send on its next subscribe attempt, without needing a live connection (RelaySocket's actual socket lifecycle needs a real/fake WebSocket to exercise). */
  getPendingSubscribeMessage(): TwitchSubscribeMessage {
    return this.buildSubscribeMessage();
  }

  connect(context: ViewerPlatformContext): void {
    this.channelId = context.channelId;
    this.token = context.authToken;
    this.socket.connect();
  }

  /**
   * onAuthorized fires again every time Twitch refreshes the JWT — this
   * just retains the newest token for the *next* subscribe attempt
   * (reconnect after a drop) rather than tearing down an already-open,
   * already-validated connection over a routine refresh.
   */
  updateToken(token: string): void {
    this.token = token;
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  subscribe(listener: (state: OverlayState) => void): () => void {
    return this.socket.subscribe(listener);
  }
}
