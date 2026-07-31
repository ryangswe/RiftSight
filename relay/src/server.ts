// Local relay: accepts a producer connection (the extension's background
// worker) and any number of viewer connections per session, keeping only
// the latest OverlayState in memory. No auth, no persistence, no database —
// this is a local development prototype, not a production service.

import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ProducerMessageSchema,
  SubscribeMessageSchema,
  TwitchSubscribeMessageSchema,
  type OverlayState,
} from "@riftsight/protocol";
import { verifyTwitchJwt } from "./twitch-auth.js";

interface Session {
  producer: WebSocket | null;
  viewers: Set<WebSocket>;
  latestState: OverlayState | null;
}

export interface RelayServer {
  port: number;
  close(): Promise<void>;
}

export interface RelayConfig {
  /** Twitch Extension client ID — currently only used for logging/diagnostics, not validation itself. */
  twitchExtensionClientId?: string;
  /** Base64-encoded Twitch Extension secret from the Developer Console. Required for `twitch-subscribe` to be accepted at all — without it, that path is refused outright rather than silently trusting an unverifiable token. */
  twitchExtensionSecret?: string;
  /** Whether the plain, unauthenticated `subscribe` path (local-debug / debug-viewer) is accepted. Defaults to true — set false for a posture closer to production, where only Twitch-authenticated subscriptions should be trusted. */
  allowLocalDebug?: boolean;
}

export function createRelayServer(port: number, config: RelayConfig = {}): Promise<RelayServer> {
  const allowLocalDebug = config.allowLocalDebug ?? true;

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

    // Shared by both the plain (local-debug) and Twitch-authenticated
    // subscribe paths once each has independently decided the request is
    // trusted — this function itself does no authorization, it only
    // admits.
    function admitViewer(ws: WebSocket, sessionId: string): void {
      const session = getSession(sessionId);
      session.viewers.add(ws);
      console.log(`[relay] viewer subscribed to session "${sessionId}" (${session.viewers.size} viewer(s) now)`);
      if (session.latestState) {
        ws.send(JSON.stringify({ type: "overlay-state", payload: session.latestState }));
      }
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
        if (!allowLocalDebug) {
          console.warn(
            `[relay] rejected an unauthenticated subscribe to session "${subscribeMessage.data.sessionId}" — local-debug mode is disabled (ALLOW_LOCAL_DEBUG=false)`
          );
          return;
        }
        admitViewer(ws, subscribeMessage.data.sessionId);
        return;
      }

      const twitchSubscribeMessage = TwitchSubscribeMessageSchema.safeParse(parsed);
      if (twitchSubscribeMessage.success) {
        const { channelId, token } = twitchSubscribeMessage.data;

        if (!config.twitchExtensionSecret) {
          console.warn(
            `[relay] rejected a twitch-subscribe for channel "${channelId}" — TWITCH_EXTENSION_SECRET is not configured`
          );
          return;
        }

        const verification = verifyTwitchJwt(token, config.twitchExtensionSecret);
        if ("error" in verification) {
          console.warn(`[relay] rejected a twitch-subscribe for channel "${channelId}": ${verification.error}`);
          return;
        }

        // Never trust the browser-supplied channelId on its own — only
        // the channel_id claim inside the *verified* JWT is authoritative
        // for which channel this viewer may actually subscribe to.
        if (verification.claims.channel_id !== channelId) {
          console.warn(
            `[relay] rejected a twitch-subscribe: JWT channel_id "${verification.claims.channel_id}" does not match requested channel "${channelId}"`
          );
          return;
        }

        admitViewer(ws, channelId);
        return;
      }

      console.warn(
        "[relay] rejected a message that failed validation (malformed or unsupported protocol version)",
        [producerMessage.error, subscribeMessage.error, twitchSubscribeMessage.error]
          .sort((a, b) => a.issues.length - b.issues.length)[0]?.issues
      );
    }

    wss.on("connection", (ws) => {
      console.log("[relay] socket connected");
      ws.on("message", (raw) => handleMessage(ws, raw));
      ws.on("close", () => {
        for (const [sessionId, session] of sessions) {
          if (session.producer === ws) {
            session.producer = null;
            console.log(`[relay] producer disconnected from session "${sessionId}"`);
          }
          if (session.viewers.delete(ws)) {
            console.log(`[relay] viewer disconnected from session "${sessionId}" (${session.viewers.size} viewer(s) remaining)`);
          }
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
