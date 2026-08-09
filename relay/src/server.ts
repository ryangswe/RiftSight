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
import { randomUUID } from "node:crypto";
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
import { createLocalStateBus, type StateBus } from "./state-bus.js";
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
  /** Set whenever latestState is — either a real producer update or the synthesized empty-cards state the TTL sweep below broadcasts. Drives both admitViewer's "don't hand a new viewer stale hitboxes" gate and the sweep's own "has this crossed STATE_TTL_MS" check. */
  lastUpdatedAt: number;
  /**
   * True only once THIS instance has genuinely held this session's producer
   * socket — decoupled from `producer`/`latestState` because, once state can
   * arrive via a shared StateBus instead of only a local producer write, an
   * instance that has never held the producer would otherwise have
   * `producer === null` and `latestState !== null` simultaneously, a
   * combination that (pre-StateBus) could only mean "this instance's
   * producer disconnected." Without this gate, every instance without the
   * producer would independently judge a perfectly healthy session stale
   * once it's been quiet past STATE_TTL_MS (a static board is a normal,
   * frequent case), each firing its own spurious empty-state clear — see
   * sweepStaleSessions' use of this field. Set true when this instance
   * claims the producer socket (see the "producer-claimed" StateBus
   * message); set false when a *different* instance claims it instead —
   * producer sockets aren't sticky to one instance, so authority has to be
   * explicitly handed off, not inferred.
   */
  hasLocalProducerAuthority: boolean;
}

/**
 * Defense in depth for when publisher.ts's explicit clear-on-stop never
 * arrives (extension crash, force-quit, network drop mid-close) — without
 * this, a session's last real snapshot would otherwise sit there
 * indefinitely just because nobody new happened to connect to notice it's
 * stale. 45s is the midpoint of the hardening spec's suggested 30-60s
 * range: long enough that a producer's normal per-mutation publish cadence
 * (bounded by card-observer.ts's debounce/settle timing, well under a
 * second) never spuriously trips it, short enough that a viewer joining
 * mid-outage doesn't sit looking at a hitbox layout from a minute-old,
 * possibly completely different board state.
 *
 * Deliberately gated on producer *connection* liveness, not just elapsed
 * time — see isProducerConnectionOpen below. A perfectly healthy, still-
 * connected producer legitimately sends nothing at all for well over 45s
 * whenever the board itself is static (a slow turn, a paused test session,
 * a quiet stretch of real gameplay): OverlayStatePublisher's dedup means no
 * message is sent when nothing changed, which is correct — but treating
 * "no message in 45s" alone as "producer is gone" would then spuriously
 * clear a completely accurate, still-live overlay. This was a real bug
 * found via live testing: hitboxes disappeared after ~45s of a static
 * board with the producer still fully connected. Time-since-last-update
 * only means anything once the connection itself is actually gone.
 */
const STATE_TTL_MS = 45_000;

/** How often the sweep below checks every session against STATE_TTL_MS. A fraction of the TTL itself so the worst-case delay between "state crossed the TTL" and "already-connected viewers get cleared" stays well inside the TTL's own already-generous window, without sweeping so often it's needless overhead for what's normally an idle check over a small Map. */
const TTL_SWEEP_INTERVAL_MS = 5_000;

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
  /**
   * Overrides STATE_TTL_MS/TTL_SWEEP_INTERVAL_MS. Test-only escape hatch —
   * every real caller (index.ts) omits this and gets the real ~45s/5s
   * defaults; without it, a test proving TTL expiry behavior would need to
   * wait 45+ real seconds.
   */
  stateTtl?: { ttlMs: number; sweepIntervalMs: number };
  /**
   * Cross-instance live-state fan-out — see state-bus.ts. Omitted (every
   * real caller today, since index.ts only constructs one when REDIS_URL is
   * set, and every existing test) defaults to a fresh in-process
   * LocalStateBus per server instance, which never leaves the process and
   * behaves byte-for-byte identically to pre-StateBus code. Pass the SAME
   * LocalStateBus instance into two separate createRelayServer calls to
   * simulate two cooperating instances in a test; pass a RedisStateBus for
   * real multi-instance deployment. Not closed by attachRelayWebSocketServer
   * — it doesn't own an injected bus (two servers can share one), only
   * whoever constructed it does.
   */
  stateBus?: StateBus;
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
  const stateTtlMs = config.stateTtl?.ttlMs ?? STATE_TTL_MS;
  const ttlSweepIntervalMs = config.stateTtl?.sweepIntervalMs ?? TTL_SWEEP_INTERVAL_MS;
  const stateBus = config.stateBus ?? createLocalStateBus();
  // Per-attachRelayWebSocketServer-call identity — used only to let this
  // instance's own StateBus subscription no-op on messages it just
  // published itself (see broadcastToLocalViewers' doc comment for why
  // local delivery stays a direct call rather than round-tripping through
  // the bus even for the origin instance). Never logged/exposed elsewhere.
  const instanceId = randomUUID();
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
    const created: Session = {
      producer: null,
      viewers: new Set(),
      latestState: null,
      lastUpdatedAt: Date.now(),
      hasLocalProducerAuthority: false,
    };
    sessions.set(sessionId, created);
    return created;
  }

  /**
   * Sends `payload` to every viewer THIS instance holds a live socket for —
   * shared by the direct producer-update/sweep call sites (this instance
   * originated the update) and the StateBus-subscribe handler below (a
   * different instance originated it). Kept as a direct call rather than
   * something that itself round-trips through the bus, even for the
   * originating instance: for a RedisStateBus, publish() is a real network
   * round trip, and self-delivery through it would add latency to
   * same-instance producer-to-viewer updates that exists nowhere in today's
   * design.
   */
  function broadcastToLocalViewers(session: Session, payload: OverlayState): number {
    const encoded = JSON.stringify({ type: "overlay-state", payload });
    let delivered = 0;
    for (const viewer of session.viewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      if (isSlowConsumer(viewer.bufferedAmount)) {
        logEvent("connection_disconnected", { reason: "slow-consumer", sessionId: payload.sessionId, bytes: viewer.bufferedAmount });
        viewer.terminate();
        continue;
      }
      viewer.send(encoded);
      delivered += 1;
    }
    return delivered;
  }

  /**
   * True as long as this session's producer socket is still open — the
   * actual liveness signal STATE_TTL_MS's staleness check needs, distinct
   * from "has latestState changed recently" (see STATE_TTL_MS's doc
   * comment for the real bug this distinction fixes). Does not (and
   * cannot, with no ws-level ping/pong heartbeat in this codebase today)
   * detect a connection that's gone dead without ever firing a close event
   * — e.g. a hard network drop with no TCP FIN/RST ever reaching this
   * process — readyState would still report OPEN in that case. That
   * narrower gap is a known, separate limitation of not having an
   * application-level heartbeat, not something this check claims to solve.
   */
  function isProducerConnectionOpen(session: Session): boolean {
    return session.producer !== null && session.producer.readyState === WebSocket.OPEN;
  }

  /** Builds the TTL sweep's synthesized clear broadcast — reuses the expiring state's own protocolVersion/sourceViewport (both required, non-optional schema fields) rather than inventing placeholder values, and bumps sequence by one so a viewer watching the raw stream sees a normal-looking next state, not a repeat. */
  function synthesizeEmptyState(sessionId: string, previous: OverlayState): OverlayState {
    return {
      protocolVersion: previous.protocolVersion,
      sessionId,
      sequence: previous.sequence + 1,
      capturedAt: Date.now(),
      sourceViewport: previous.sourceViewport,
      cards: [],
    };
  }

  /**
   * Runs on a timer, independent of any single connection's activity —
   * this is what catches a session going stale even when no new viewer
   * ever connects to trigger admitViewer's own TTL gate. Only touches
   * sessions that actually have a latestState to expire; once cleared,
   * latestState is null and this stops re-triggering for that session
   * until a producer sends something new.
   */
  function sweepStaleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (!session.latestState) continue;
      // Only the instance that has/had this session's producer may judge
      // staleness — see Session.hasLocalProducerAuthority's doc comment for
      // why every other instance's session.producer being null carries no
      // information once state can arrive via the bus.
      if (!session.hasLocalProducerAuthority) continue;
      if (isProducerConnectionOpen(session)) continue; // still connected — a static board is not staleness
      if (now - session.lastUpdatedAt <= stateTtlMs) continue;

      const emptyState = synthesizeEmptyState(sessionId, session.latestState);
      session.latestState = null;
      logEvent("state_ttl_expired", { sessionId, viewers: session.viewers.size });
      broadcastToLocalViewers(session, emptyState);
      stateBus.publish({ kind: "state-expired", sessionId, originInstanceId: instanceId, emptyState });
    }
  }

  const ttlSweepInterval = setInterval(sweepStaleSessions, ttlSweepIntervalMs);

  /**
   * Applies a state update that originated on a DIFFERENT instance — see
   * broadcastToLocalViewers' doc comment for why this instance's own
   * originated updates are never round-tripped back through here. "state"
   * and "state-expired" are kept as separate message kinds (rather than
   * encoding an expiry as a "state" message with an empty-cards payload)
   * specifically so a receiving instance's own latestState reliably becomes
   * null on expiry — sweepStaleSessions' own re-fire guard (`if
   * (!session.latestState) continue`) depends on that, and storing the
   * empty state AS latestState would silently break it.
   */
  const unsubscribeFromStateBus = stateBus.subscribe((message) => {
    if (message.originInstanceId === instanceId) return; // already applied locally at the point of origin
    const session = getSession(message.sessionId);
    if (message.kind === "producer-claimed") {
      session.hasLocalProducerAuthority = false;
      return;
    }
    if (message.kind === "state") {
      session.latestState = message.state;
      session.lastUpdatedAt = Date.now();
      const delivered = broadcastToLocalViewers(session, message.state);
      logEvent("state_broadcast", {
        sessionId: message.sessionId,
        sequence: message.state.sequence,
        cards: message.state.cards.length,
        viewers: delivered,
      });
      return;
    }
    // message.kind === "state-expired"
    session.latestState = null;
    logEvent("state_ttl_expired", { sessionId: message.sessionId, viewers: session.viewers.size });
    broadcastToLocalViewers(session, message.emptyState);
  });

  function bindAuthenticatedProducer(ws: WebSocket, state: ConnectionState, binding: ProducerBinding): void {
    state.producerBinding = binding;
    const session = getSession(binding.twitchUserId);
    if (session.producer && session.producer !== ws && session.producer.readyState === WebSocket.OPEN) {
      logEvent("producer_replaced", { channelId: binding.twitchUserId, broadcasterId: binding.broadcasterId });
      session.producer.close(CLOSE_CODE.PRODUCER_REPLACED, "replaced-by-new-producer-connection");
    }
    session.producer = ws;
    session.hasLocalProducerAuthority = true;
    stateBus.publish({ kind: "producer-claimed", sessionId: binding.twitchUserId, originInstanceId: instanceId });
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
    // Belt-and-suspenders alongside sweepStaleSessions above: the sweep
    // only runs every TTL_SWEEP_INTERVAL_MS, so a state that just crossed
    // STATE_TTL_MS moments ago (with no live producer) could still be
    // sitting in latestState when a new viewer connects — this check means
    // a newly-admitted viewer never receives truly stale hitboxes
    // regardless of sweep timing. A live producer connection always means
    // the state is trusted, however long ago it last actually changed —
    // see isProducerConnectionOpen's doc comment.
    if (session.latestState && (isProducerConnectionOpen(session) || Date.now() - session.lastUpdatedAt <= stateTtlMs)) {
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
      const isNewProducerSocket = session.producer !== ws;
      session.producer = ws;
      if (isNewProducerSocket) {
        session.hasLocalProducerAuthority = true;
        stateBus.publish({ kind: "producer-claimed", sessionId: overlayState.sessionId, originInstanceId: instanceId });
      }
      session.latestState = overlayState;
      session.lastUpdatedAt = Date.now();

      const delivered = broadcastToLocalViewers(session, overlayState);
      logEvent("state_broadcast", {
        sessionId: overlayState.sessionId,
        sequence: overlayState.sequence,
        cards: overlayState.cards.length,
        viewers: delivered,
        bytes,
      });
      stateBus.publish({ kind: "state", sessionId: overlayState.sessionId, originInstanceId: instanceId, state: overlayState });
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
        // Must be cleared here, not left running — an un-cleared
        // setInterval keeps the Node process (and, in tests, the test
        // runner) alive/hanging past this close() resolving.
        clearInterval(ttlSweepInterval);
        // Only removes THIS server's own handler from the bus — a shared
        // injected bus (two createRelayServer calls sharing one
        // LocalStateBus, as the cross-instance tests do) keeps working for
        // whichever server hasn't closed yet. The bus itself is never
        // closed here — see RelayConfig.stateBus's doc comment on
        // ownership.
        unsubscribeFromStateBus();
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
