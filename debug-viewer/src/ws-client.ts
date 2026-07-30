import { parseServerMessage, RELAY_URL, SubscribeMessageSchema, type OverlayState } from "@riftsight/protocol";

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

// parseServerMessage now lives in @riftsight/protocol (both this viewer and
// twitch-extension's mock relay client need the identical parsing/rejection
// behavior); re-exported here so nothing importing it from this module
// needs to change. The caller simply doesn't invoke onState when it
// returns undefined, which is why the viewer keeps rendering its last
// valid state on rejection — there's no separate "clear state" path to
// accidentally trigger.
export { parseServerMessage };

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
      const state = parseServerMessage(String(event.data));
      if (state) options.onState(state);
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
