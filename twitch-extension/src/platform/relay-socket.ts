import { parseServerMessage, type OverlayState } from "@riftsight/protocol";

export type RelaySocketStatus = "connecting" | "connected" | "disconnected";

// Only the WebSocket surface RelaySocket actually touches — lets tests
// inject a fake without needing a real browser/jsdom WebSocket (Node has
// none, same reason debug-viewer's ws-client.ts was never unit-testable
// beyond its pure parseServerMessage). The default factory below only
// references the real `WebSocket` global inside a function body, so it's
// never evaluated (and can't throw) unless something actually calls
// connect() without overriding it.
export type WebSocketLike = Pick<WebSocket, "addEventListener" | "send" | "close">;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Shared reconnect/backoff/parse plumbing (mirrors debug-viewer's
 * ws-client.ts) for both MockOverlayStateSource and
 * TwitchOverlayStateSource — they differ only in what subscribe message
 * they send once connected, hence the buildSubscribeMessage callback
 * instead of a hardcoded message shape.
 */
export class RelaySocket {
  private socket: WebSocketLike | null = null;
  private listeners = new Set<(state: OverlayState) => void>();
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(
    private readonly relayUrl: string,
    private readonly buildSubscribeMessage: () => unknown,
    private readonly onStatusChange: (status: RelaySocketStatus) => void = () => {},
    private readonly createSocket: (url: string) => WebSocketLike = (url) => new WebSocket(url)
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    this.onStatusChange("connecting");

    const ws = this.createSocket(this.relayUrl);
    this.socket = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.onStatusChange("connected");
      ws.send(JSON.stringify(this.buildSubscribeMessage()));
    });

    ws.addEventListener("message", (event) => {
      const state = parseServerMessage(String((event as MessageEvent).data));
      if (!state) return;
      for (const listener of this.listeners) listener(state);
    });

    ws.addEventListener("close", () => {
      this.socket = null;
      if (this.stopped) return;
      this.onStatusChange("disconnected");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => ws.close());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  subscribe(listener: (state: OverlayState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
