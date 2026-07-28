import { RELAY_URL, ServerMessageSchema, SubscribeMessageSchema, type OverlayState } from "@riftsight/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ViewerClientOptions {
  sessionId: string;
  onStatusChange: (status: ConnectionStatus) => void;
  onState: (state: OverlayState) => void;
}

export interface ViewerClient {
  disconnect(): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export function connectViewer(options: ViewerClientOptions): ViewerClient {
  let socket: WebSocket | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleReconnect(): void {
    if (reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function connect(): void {
    if (stopped) return;
    options.onStatusChange("connecting");

    const ws = new WebSocket(RELAY_URL);
    socket = ws;

    ws.addEventListener("open", () => {
      backoffMs = INITIAL_BACKOFF_MS;
      options.onStatusChange("connected");
      ws.send(JSON.stringify(SubscribeMessageSchema.parse({ type: "subscribe", sessionId: options.sessionId })));
    });

    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // Defense in depth (the third privacy/validation boundary, after the
      // detector and the serializer): validate every incoming message
      // before trusting it, even though the relay should only ever forward
      // already-valid states.
      const result = ServerMessageSchema.safeParse(parsed);
      if (result.success) options.onState(result.data.payload);
    });

    ws.addEventListener("close", () => {
      socket = null;
      if (stopped) return;
      options.onStatusChange("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => ws.close());
  }

  connect();

  return {
    disconnect(): void {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
