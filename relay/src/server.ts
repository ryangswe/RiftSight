// Relay: accepts a producer connection (the extension's background worker)
// and any number of viewer connections per session, keeping only the
// latest OverlayState in memory per channel/session.
//
// attachRelayWebSocketServer() attaches WebSocket handling to an existing
// node:http.Server — shared with the plain HTTP routes (OAuth, health,
// producer-credential endpoints; see http/server.ts) on one origin/port,
// which is what index.ts uses for a real deployment. createRelayServer()
// is a thin convenience wrapper around that for callers (mainly tests)
// that just want a standalone WS-only server without an HTTP router
// attached — it creates its own bare http.Server internally, exactly
// matching this module's pre-Stage-8 behavior, which is why every existing
// test call site (createRelayServer(port, config)) keeps working
// unmodified.

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ProducerMessageSchema,
  SubscribeMessageSchema,
  TwitchSubscribeMessageSchema,
  type OverlayState,
} from "@riftsight/protocol";
import { verifyTwitchJwt } from "./twitch-auth.js";
import type { DbClient } from "./db/client.js";
import { authenticateProducerUpgrade, isProducerUpgradePath } from "./ws/producer-auth.js";
import { logEvent } from "./logging.js";
import {
  createRateLimiter,
  isSlowConsumer,
  messageByteLength,
  MAX_CARDS_PER_SNAPSHOT,
  MAX_CONSECUTIVE_INVALID_MESSAGES,
  MAX_MESSAGE_BYTES,
  MAX_PRODUCER_UPDATES_PER_SECOND,
  MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET,
  type RateLimiter,
} from "./rate-limit.js";

interface Session {
  producer: WebSocket | null;
  viewers: Set<WebSocket>;
  latestState: OverlayState | null;
}

interface ProducerBinding {
  broadcasterId: number;
  twitchUserId: string;
}

/** Per-connection bookkeeping for the limits in rate-limit.ts — one instance per socket, created in the "connection" handler and read/mutated from handleMessage. */
interface ConnectionState {
  /** Only set for a socket that authenticated via /ws/producer — see bindAuthenticatedProducer. */
  producerBinding: ProducerBinding | undefined;
  /** Consecutive messages that failed validation (oversized, malformed JSON, schema mismatch, too many cards) — reset on any accepted message. Crosses MAX_CONSECUTIVE_INVALID_MESSAGES -> disconnect. */
  invalidMessageCount: number;
  /** subscribe/twitch-subscribe attempts this socket has made (successful or not) — crosses MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET -> disconnect. */
  subscribeAttempts: number;
  /** Scoped to this one connection (a fresh limiter per socket, not shared) — bounds accepted overlay-state messages per second from this producer. */
  producerUpdateLimiter: RateLimiter;
}

/** Application-defined WebSocket close codes (4000-4999 private-use range), distinct from any standard close code so a client could special-case them if it ever needs to. */
const CLOSE_CODE = {
  /** A previously-open producer socket replaced by a newer authenticated connection for the same channel. */
  PRODUCER_REPLACED: 4409,
  /** Too many consecutive messages failed validation. */
  TOO_MANY_INVALID_MESSAGES: 4400,
  /** Too many subscribe/twitch-subscribe attempts on one socket. */
  TOO_MANY_SUBSCRIBE_ATTEMPTS: 4401,
} as const;

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
  /**
   * Enables the authenticated /ws/producer endpoint. Omitted entirely in
   * development and twitch-local-test — the legacy, unauthenticated
   * bare-socket producer path (any socket, client-asserted sessionId)
   * keeps working exactly as it always has, byte-for-byte, which is also
   * why every existing test in server.test.ts never sets this and must
   * keep passing unmodified.
   */
  producerAuth?: {
    db: DbClient;
    /** closed-beta: true — plain unauthenticated overlay-state messages on the legacy bare-socket path are rejected outright rather than accepted with a client-asserted sessionId. */
    required: boolean;
  };
}

/**
 * Attaches producer/viewer WebSocket handling to an already-created
 * http.Server. Does not call server.listen() itself — the caller owns the
 * listen lifecycle (index.ts listens once, after also attaching the HTTP
 * router; createRelayServer below listens immediately since it owns its
 * own private server). Returns only a close() — there's no "port" to
 * report here since this function never bound one itself.
 */
export function attachRelayWebSocketServer(httpServer: HttpServer, config: RelayConfig = {}): { close(): Promise<void> } {
  const allowLocalDebug = config.allowLocalDebug ?? true;
  const sessions = new Map<string, Session>();
  // Set during verifyClient (upgrade time), consumed once in the
  // "connection" handler for the same request — this is how the resolved
  // identity crosses from the async pre-accept check into the now-accepted
  // socket, since ws's verifyClient and connection handlers don't
  // otherwise share a channel.
  const pendingProducerAuth = new WeakMap<IncomingMessage, ProducerBinding>();
  const connectionStates = new WeakMap<WebSocket, ConnectionState>();

  function getSession(sessionId: string): Session {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: Session = { producer: null, viewers: new Set(), latestState: null };
    sessions.set(sessionId, created);
    return created;
  }

  function bindAuthenticatedProducer(ws: WebSocket, state: ConnectionState, binding: ProducerBinding): void {
    state.producerBinding = binding;
    const session = getSession(binding.twitchUserId);
    if (session.producer && session.producer !== ws && session.producer.readyState === WebSocket.OPEN) {
      logEvent("producer_replaced", { channelId: binding.twitchUserId, broadcasterId: binding.broadcasterId });
      session.producer.close(CLOSE_CODE.PRODUCER_REPLACED, "replaced-by-new-producer-connection");
    }
    session.producer = ws;
    logEvent("producer_connected", { channelId: binding.twitchUserId, broadcasterId: binding.broadcasterId });
  }

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: config.producerAuth
      ? ({ req }, callback) => {
          if (!isProducerUpgradePath(req.url ?? "/")) {
            callback(true); // not a producer upgrade — legacy/viewer traffic is unaffected
            return;
          }
          void authenticateProducerUpgrade(req, config.producerAuth!.db).then((result) => {
            if (!result.authenticated) {
              logEvent("producer_rejected", { reason: result.reason });
              callback(false, 401, "Unauthorized");
              return;
            }
            pendingProducerAuth.set(req, { broadcasterId: result.broadcasterId, twitchUserId: result.twitchUserId });
            callback(true);
          });
        }
      : undefined,
  });

  // Shared by both the plain (local-debug) and Twitch-authenticated
  // subscribe paths once each has independently decided the request is
  // trusted — this function itself does no authorization, it only admits.
  function admitViewer(ws: WebSocket, sessionId: string): void {
    const session = getSession(sessionId);
    session.viewers.add(ws);
    logEvent("viewer_admitted", { sessionId, viewers: session.viewers.size });
    if (session.latestState) {
      ws.send(JSON.stringify({ type: "overlay-state", payload: session.latestState }));
    }
  }

  function markInvalid(ws: WebSocket, state: ConnectionState, reason: string, extra: Record<string, string | number> = {}): void {
    logEvent("validation_failure", { reason, ...extra });
    state.invalidMessageCount += 1;
    if (state.invalidMessageCount >= MAX_CONSECUTIVE_INVALID_MESSAGES) {
      logEvent("connection_disconnected", { reason: "too-many-invalid-messages", count: state.invalidMessageCount });
      ws.close(CLOSE_CODE.TOO_MANY_INVALID_MESSAGES, "too-many-invalid-messages");
    }
  }

  function handleMessage(ws: WebSocket, raw: RawData, state: ConnectionState): void {
    const text = raw.toString();
    const bytes = messageByteLength(text);
    if (bytes > MAX_MESSAGE_BYTES) {
      markInvalid(ws, state, "oversized-message", { bytes });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      markInvalid(ws, state, "malformed-json");
      return;
    }

    const producerMessage = ProducerMessageSchema.safeParse(parsed);
    if (producerMessage.success) {
      const cardCount = producerMessage.data.payload.cards.length;
      if (cardCount > MAX_CARDS_PER_SNAPSHOT) {
        markInvalid(ws, state, "too-many-cards", { cards: cardCount });
        return;
      }

      const binding = state.producerBinding;
      if (config.producerAuth?.required && !binding) {
        logEvent("producer_rejected", { reason: "unauthenticated-producer-not-permitted" });
        return; // well-formed, just not permitted — not counted as an invalid message
      }

      if (!state.producerUpdateLimiter.tryConsume("producer")) {
        logEvent("producer_rejected", { reason: "update-rate-exceeded" });
        return; // dropped, not counted as invalid — a fast producer isn't malformed
      }

      state.invalidMessageCount = 0;

      // An authenticated producer's channel is resolved once, server-side,
      // from its credential — the message's own sessionId is never
      // trusted for that socket, exactly mirroring the viewer JWT path's
      // channel_id-claim-over-client-value discipline. Unauthenticated
      // (legacy/dev) producers keep today's behavior unchanged: whatever
      // sessionId the message itself claims.
      const overlayState = binding ? { ...producerMessage.data.payload, sessionId: binding.twitchUserId } : producerMessage.data.payload;
      const session = getSession(overlayState.sessionId);
      // Last producer to send for a session wins — no arbitration between
      // multiple producers targeting the same *unauthenticated* session.
      // Authenticated producers are arbitrated earlier, at connection time,
      // by bindAuthenticatedProducer's replace-on-reconnect.
      session.producer = ws;
      session.latestState = overlayState;

      const encoded = JSON.stringify({ type: "overlay-state", payload: overlayState });
      let delivered = 0;
      for (const viewer of session.viewers) {
        if (viewer.readyState !== WebSocket.OPEN) continue;
        if (isSlowConsumer(viewer.bufferedAmount)) {
          logEvent("connection_disconnected", {
            reason: "slow-consumer",
            sessionId: overlayState.sessionId,
            bytes: viewer.bufferedAmount,
          });
          viewer.terminate();
          continue;
        }
        viewer.send(encoded);
        delivered += 1;
      }
      logEvent("state_broadcast", {
        sessionId: overlayState.sessionId,
        sequence: overlayState.sequence,
        cards: overlayState.cards.length,
        viewers: delivered,
        bytes,
      });
      return;
    }

    const subscribeMessage = SubscribeMessageSchema.safeParse(parsed);
    if (subscribeMessage.success) {
      state.subscribeAttempts += 1;
      if (state.subscribeAttempts > MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET) {
        logEvent("connection_disconnected", { reason: "too-many-subscribe-attempts", count: state.subscribeAttempts });
        ws.close(CLOSE_CODE.TOO_MANY_SUBSCRIBE_ATTEMPTS, "too-many-subscribe-attempts");
        return;
      }
      if (!allowLocalDebug) {
        logEvent("viewer_rejected", { reason: "local-debug-disabled", sessionId: subscribeMessage.data.sessionId });
        return;
      }
      state.invalidMessageCount = 0;
      admitViewer(ws, subscribeMessage.data.sessionId);
      return;
    }

    const twitchSubscribeMessage = TwitchSubscribeMessageSchema.safeParse(parsed);
    if (twitchSubscribeMessage.success) {
      const { channelId, token } = twitchSubscribeMessage.data;
      state.subscribeAttempts += 1;
      if (state.subscribeAttempts > MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET) {
        logEvent("connection_disconnected", { reason: "too-many-subscribe-attempts", count: state.subscribeAttempts });
        ws.close(CLOSE_CODE.TOO_MANY_SUBSCRIBE_ATTEMPTS, "too-many-subscribe-attempts");
        return;
      }

      if (!config.twitchExtensionSecret) {
        logEvent("viewer_rejected", { reason: "twitch-extension-secret-not-configured", channelId });
        return;
      }

      const verification = verifyTwitchJwt(token, config.twitchExtensionSecret);
      if ("error" in verification) {
        logEvent("viewer_rejected", { reason: "invalid-twitch-jwt", channelId });
        return;
      }

      // Never trust the browser-supplied channelId on its own — only the
      // channel_id claim inside the *verified* JWT is authoritative for
      // which channel this viewer may actually subscribe to.
      if (verification.claims.channel_id !== channelId) {
        logEvent("viewer_rejected", { reason: "channel-id-mismatch", channelId });
        return;
      }

      state.invalidMessageCount = 0;
      admitViewer(ws, channelId);
      return;
    }

    markInvalid(ws, state, "schema-validation-failed");
  }

  wss.on("connection", (ws, req) => {
    const state: ConnectionState = {
      producerBinding: undefined,
      invalidMessageCount: 0,
      subscribeAttempts: 0,
      producerUpdateLimiter: createRateLimiter({ maxEvents: MAX_PRODUCER_UPDATES_PER_SECOND, windowMs: 1000 }),
    };
    connectionStates.set(ws, state);

    const binding = pendingProducerAuth.get(req);
    if (binding) {
      pendingProducerAuth.delete(req);
      bindAuthenticatedProducer(ws, state, binding);
    }

    ws.on("message", (raw) => handleMessage(ws, raw, state));
    ws.on("close", () => {
      for (const [sessionId, session] of sessions) {
        if (session.producer === ws) {
          session.producer = null;
          logEvent("producer_disconnected", { channelId: sessionId });
        }
        if (session.viewers.delete(ws)) {
          logEvent("viewer_disconnected", { sessionId, viewers: session.viewers.size });
        }
      }
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // wss.close() with an external server attached does NOT close that
        // server itself — only its own internal state and open sockets.
        // The caller (createRelayServer below, or index.ts) owns closing
        // the underlying http.Server.
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Standalone convenience wrapper: creates its own private http.Server (no HTTP routes attached, matching this module's behavior before Stage 8 introduced the shared HTTP+WS server), attaches WS handling, and listens. Used by every test in this workspace and remains behaviorally identical to before for all of them. */
export function createRelayServer(port: number, config: RelayConfig = {}): Promise<RelayServer> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    const { close: closeWs } = attachRelayWebSocketServer(httpServer, config);

    httpServer.on("error", reject);
    httpServer.listen(port, () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      console.log(`[relay] listening on ws://localhost:${boundPort}`);
      resolve({
        port: boundPort,
        close: async () => {
          await closeWs();
          await new Promise<void>((res, rej) => {
            httpServer.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
