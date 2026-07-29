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

/**
 * Pure message-parsing boundary — the viewer's own defense in depth, after
 * the detector's visibility classification, protocol's toOverlayCard()
 * serializer, and the relay's own schema check. Returns undefined for
 * anything that fails to parse as JSON or fails ServerMessageSchema
 * validation (malformed JSON, missing payload, unsupported protocol
 * version, invalid bounds/viewport, unknown enum values, a hidden card
 * carrying identity fields, ...) — logging a concise reason (zod's
 * `.issues`, never the raw payload) so a rejected message is visible in
 * the console without risking a sensitive or oversized dump. The caller
 * simply doesn't invoke onState when this returns undefined, which is why
 * the viewer keeps rendering its last valid state on rejection — there's
 * no separate "clear state" path to accidentally trigger.
 */
export function parseServerMessage(raw: string): OverlayState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[viewer] dropped a non-JSON message");
    return undefined;
  }

  const result = ServerMessageSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[viewer] rejected an invalid message", result.error.issues);
    return undefined;
  }

  return result.data.payload;
}

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
