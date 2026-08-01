import { SubscribeMessageSchema, type OverlayState } from "@riftsight/protocol";
import type { OverlayStateSource, ViewerPlatformContext } from "@riftsight/overlay-core";
import { RelaySocket, type RelaySocketStatus, type WebSocketLike } from "./relay-socket.js";

export type MockConnectionStatus = RelaySocketStatus;

/**
 * Dev-only OverlayStateSource for running the Twitch overlay UI outside
 * Twitch: connects straight to the local relay's existing unauthenticated
 * `subscribe` path, using the platform context's channelId as the relay
 * sessionId. `context.authToken` is accepted but unused here — it exists
 * on the interface for TwitchOverlayStateSource, not because the relay
 * checks anything on this path. Mock auth must never be confused with
 * real Twitch JWT validation (see twitch-state-source.ts).
 *
 * `relayUrl` is resolved by the caller (main.ts, via getConfiguredRelayUrl)
 * rather than read internally here — keeps this class free of any
 * browser-global dependency, so it stays constructible in plain Node
 * tests with an arbitrary string.
 */
export class MockOverlayStateSource implements OverlayStateSource {
  private channelId = "";
  private readonly socket: RelaySocket;

  constructor(
    relayUrl: string,
    onStatusChange: (status: MockConnectionStatus) => void = () => {},
    createSocket?: (url: string) => WebSocketLike
  ) {
    this.socket = new RelaySocket(
      relayUrl,
      () => SubscribeMessageSchema.parse({ type: "subscribe", sessionId: this.channelId }),
      onStatusChange,
      createSocket
    );
  }

  connect(context: ViewerPlatformContext): void {
    this.channelId = context.channelId;
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  subscribe(listener: (state: OverlayState) => void): () => void {
    return this.socket.subscribe(listener);
  }
}
