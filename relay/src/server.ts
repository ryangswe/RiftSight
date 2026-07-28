// Local relay: accepts a producer connection (the extension's background
// worker) and any number of viewer connections per session, keeping only
// the latest OverlayState in memory. No auth, no persistence, no database —
// this is a local development prototype, not a production service.

import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ProducerMessageSchema, SubscribeMessageSchema, type OverlayState } from "@riftsight/protocol";

interface Session {
  producer: WebSocket | null;
  viewers: Set<WebSocket>;
  latestState: OverlayState | null;
}

export interface RelayServer {
  port: number;
  close(): Promise<void>;
}

export function createRelayServer(port: number): Promise<RelayServer> {
  return new Promise((resolve, reject) => {
    const sessions = new Map<string, Session>();
    const wss = new WebSocketServer({ port });

    function getSession(sessionId: string): Session {
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      const created: Session = { producer: null, viewers: new Set(), latestState: null };
      sessions.set(sessionId, created);
      return created;
    }

    function handleMessage(ws: WebSocket, raw: RawData): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        console.warn("[relay] dropped a non-JSON message");
        return;
      }

      const producerMessage = ProducerMessageSchema.safeParse(parsed);
      if (producerMessage.success) {
        const state = producerMessage.data.payload;
        const session = getSession(state.sessionId);
        // Last producer to send for a session wins — no arbitration between
        // multiple producers targeting the same session in this prototype.
        session.producer = ws;
        session.latestState = state;

        const encoded = JSON.stringify({ type: "overlay-state", payload: state });
        let delivered = 0;
        for (const viewer of session.viewers) {
          if (viewer.readyState === WebSocket.OPEN) {
            viewer.send(encoded);
            delivered += 1;
          }
        }
        console.log(
          `[relay] session "${state.sessionId}": seq=${state.sequence} (${state.cards.length} cards) -> ${delivered} viewer(s)`
        );
        return;
      }

      const subscribeMessage = SubscribeMessageSchema.safeParse(parsed);
      if (subscribeMessage.success) {
        const { sessionId } = subscribeMessage.data;
        const session = getSession(sessionId);
        session.viewers.add(ws);
        console.log(`[relay] viewer subscribed to session "${sessionId}" (${session.viewers.size} viewer(s) now)`);
        if (session.latestState) {
          ws.send(JSON.stringify({ type: "overlay-state", payload: session.latestState }));
        }
        return;
      }

      console.warn(
        "[relay] rejected a message that failed validation (malformed or unsupported protocol version)",
        producerMessage.error.issues.length <= subscribeMessage.error.issues.length
          ? producerMessage.error.issues
          : subscribeMessage.error.issues
      );
    }

    wss.on("connection", (ws) => {
      ws.on("message", (raw) => handleMessage(ws, raw));
      ws.on("close", () => {
        for (const session of sessions.values()) {
          if (session.producer === ws) session.producer = null;
          session.viewers.delete(ws);
        }
      });
    });

    wss.on("listening", () => {
      const address = wss.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      console.log(`[relay] listening on ws://localhost:${boundPort}`);
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => {
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });

    wss.on("error", reject);
  });
}
