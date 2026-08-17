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
  YouTubeSubscribeMessageSchema,
  type OverlayState,
  type SubscribeRejectedReason,
} from "@riftsight/protocol";
import { verifyTwitchJwt } from "./twitch-auth.js";
import type { DbClient } from "./db/client.js";
import { authenticateProducerUpgrade, isProducerUpgradePath } from "./ws/producer-auth.js";
import { logEvent as emitLogEvent, type LogFields } from "./logging.js";
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
  WS_CONNECTION_LIMIT,
  type RateLimiter,
} from "./rate-limit.js";

interface Session {
  producer: WebSocket | null;
  viewers: Set<WebSocket>;
  latestState: OverlayState | null;
  /** Set whenever latestState is — either a real producer update or the synthesized empty-cards state the TTL sweep below broadcasts. Refreshed by local producer writes AND by state received over the StateBus, which is what lets each instance expire its own copy on its own timer (see sweepStaleSessions) with no cross-instance coordination. Drives both admitViewer's "don't hand a new viewer stale hitboxes" gate and the sweep's own "has this crossed STATE_TTL_MS" check. */
  lastUpdatedAt: number;
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

/** How often this instance re-publishes its local viewer count for every session it holds viewers for, even when nothing changed — the liveness signal that lets OTHER instances treat silence as this instance being gone (see REMOTE_VIEWER_COUNT_FRESHNESS_MS). Only sessions with a nonzero local count heartbeat: a zero is published once on the change itself and then aging-out keeps it zero everywhere. */
const VIEWER_COUNT_HEARTBEAT_MS = 5_000;

/** How stale a remote instance's viewer-count report may be before it stops counting toward the sum a local producer is told. Three missed heartbeats — generous enough that one delayed/dropped pub/sub message doesn't flap the streamer's count, short enough that a crashed replica's viewers disappear from the count within ~15s rather than forever. */
const REMOTE_VIEWER_COUNT_FRESHNESS_MS = 15_000;

/** How often this instance emits a `capacity_snapshot` log line — a regular sample of its own concurrency (sessions/viewers/producers) for a capacity dashboard (see docs/scaling-plan.md Stage 4). A minute is plenty of resolution for capacity-pressure trends and keeps it to ~1 line/min/instance; it's a periodic time-series sample (emitted even at zero, so a flat idle line is visible rather than an ambiguous gap), not an on-change event. */
const CAPACITY_SNAPSHOT_INTERVAL_MS = 60_000;

/** Hard per-session viewer ceiling, per instance — memory/fan-out protection for the public youtube-subscribe path (which explicitly rejects with "at-capacity"), enforced identically-but-silently on the legacy/Twitch paths (those clients have no rejection vocabulary; silence there matches every other rejection they already get). At the fleet level the effective cap is N-replicas × this, which is fine — it exists to bound one instance's blast radius, not to meter the product. */
const MAX_VIEWERS_PER_SESSION = 2_000;

/** Application-level keepalive cadence for youtube-path viewer sockets only (see protocol's PingMessageSchema for the MV3 service-worker rationale). Well under Chrome's ~30s worker idle-reap so a quiet board never lets the extension's socket die, and cheap: one tiny frame per viewer per interval. */
const VIEWER_PING_INTERVAL_MS = 20_000;

/** How long one platform-channel resolution (hit OR authoritative miss) is served from memory before the DB is asked again — shared by the youtube-subscribe and twitch-subscribe resolution paths. Bounds DB load under a viewer connection storm on one channel (the popular-streamer case) while keeping "streamer just linked their channel" latency to a refresh's wait. Resolver ERRORS are deliberately not cached — a transient DB blip shouldn't blank a channel for a whole window. */
const PLATFORM_RESOLUTION_CACHE_MS = 30_000;

interface ProducerBinding {
  broadcasterId: number;
}

/**
 * The session key for an authenticated broadcaster — the internal,
 * platform-neutral broadcaster id, stringified (sessionId is a free-text
 * string end to end). Since the identity refactor this is what BOTH viewer
 * paths resolve their platform channel ids to: twitch-subscribe's
 * channel_id and youtube-subscribe's UC-id each map through
 * platform_identities to this same key, so a Twitch viewer and a YouTube
 * viewer of the same streamer land in the same session. Unauthenticated
 * dev/legacy producers keep their client-asserted free-text sessionIds,
 * which can't collide with these in practice (and all authenticated
 * routing goes through DB resolution regardless).
 */
function sessionKeyForBroadcaster(broadcasterId: number): string {
  return String(broadcasterId);
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
  /** This client IP opened more WebSocket connections per window than WS_CONNECTION_LIMIT allows. */
  CONNECTION_RATE_LIMITED: 4429,
} as const;

export interface RelayServer {
  port: number;
  close(): Promise<void>;
  /** Test/diagnostic-only: how many sessions this instance currently holds in memory. Exposed so tests can prove the reaping sweep actually shrinks the sessions map back to baseline (the map is otherwise closure-private); every real caller ignores it. */
  debugSessionCount(): number;
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
   * Overrides VIEWER_COUNT_HEARTBEAT_MS/REMOTE_VIEWER_COUNT_FRESHNESS_MS.
   * Test-only escape hatch, exactly like stateTtl above — every real
   * caller omits it and gets the real ~5s/15s defaults.
   */
  viewerCountFanout?: { heartbeatMs: number; freshnessMs: number };
  /**
   * Overrides CAPACITY_SNAPSHOT_INTERVAL_MS. Test-only escape hatch, same
   * shape as stateTtl/viewerCountFanout above — every real caller omits it
   * and gets the real ~60s default; a test wanting to observe a snapshot
   * without waiting a minute sets a small interval.
   */
  capacitySnapshot?: { intervalMs: number };
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
  /**
   * Resolves a (schema-validated) YouTube channel id to the broadcaster
   * session key it should subscribe to, or null for "no such mapping" —
   * the youtube-subscribe path is refused outright ("unknown-channel")
   * when this is omitted, which is every mode that has no DB to resolve
   * against. index.ts wires it to db/identities.ts's findIdentity
   * (yielding sessionKeyForBroadcaster of the owning broadcaster); tests
   * inject counters/fakes. Results (including null) are cached for
   * PLATFORM_RESOLUTION_CACHE_MS; thrown errors are treated as
   * "unknown-channel" for the one request but never cached.
   */
  resolveYouTubeChannel?: (youtubeChannelId: string) => Promise<string | null>;
  /**
   * Twitch counterpart of resolveYouTubeChannel for the twitch-subscribe
   * path: maps a JWT-verified Twitch channel_id to the broadcaster session
   * key. OMITTED (dev servers, every pre-identity-refactor test) the path
   * falls back to the LEGACY behavior — admitting the channel id directly
   * as the session key — which is also what unauthenticated dev producers
   * publish under, so local workflows keep working with zero setup. In
   * production index.ts always wires this, so real sessions key on the
   * internal broadcaster id and a Twitch channel with no linked
   * broadcaster admits nobody (previously it created an empty session per
   * curious viewer). Same caching/error contract as the YouTube resolver.
   */
  resolveTwitchChannel?: (twitchChannelId: string) => Promise<string | null>;
  /** Overrides MAX_VIEWERS_PER_SESSION. Test-only escape hatch, same shape as stateTtl above. */
  maxViewersPerSession?: number;
  /** Overrides VIEWER_PING_INTERVAL_MS. Test-only escape hatch. */
  viewerPing?: { intervalMs: number };
  /** Overrides WS_CONNECTION_LIMIT (per-client-IP upgrade acceptances per window). Test-only escape hatch. */
  wsConnectionLimit?: { maxEvents: number; windowMs: number };
}

/**
 * The client identity the per-IP connection limiter keys on: the first
 * X-Forwarded-For hop when present (behind Railway's proxy every socket's
 * remoteAddress is the LB, which would lump all real viewers into one
 * bucket), else the socket address (direct/local connections, tests).
 * XFF is client-forgeable when the relay is reached directly — accepted:
 * a forger can only spread themselves across buckets, i.e. evade their own
 * throttle, not collapse anyone else's, and the per-socket/-session limits
 * behind this are unaffected.
 */
function clientIpOf(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/**
 * Attaches producer/viewer WebSocket handling to an already-created
 * http.Server. Does not call server.listen() itself — the caller owns the
 * listen lifecycle (index.ts listens once, after also attaching the HTTP
 * router; createRelayServer below listens immediately since it owns its
 * own private server). Returns only a close() — there's no "port" to
 * report here since this function never bound one itself.
 */
export function attachRelayWebSocketServer(httpServer: HttpServer, config: RelayConfig = {}): { close(): Promise<void>; debugSessionCount(): number } {
  const allowLocalDebug = config.allowLocalDebug ?? true;
  const stateTtlMs = config.stateTtl?.ttlMs ?? STATE_TTL_MS;
  const ttlSweepIntervalMs = config.stateTtl?.sweepIntervalMs ?? TTL_SWEEP_INTERVAL_MS;
  const viewerCountHeartbeatMs = config.viewerCountFanout?.heartbeatMs ?? VIEWER_COUNT_HEARTBEAT_MS;
  const remoteViewerCountFreshnessMs = config.viewerCountFanout?.freshnessMs ?? REMOTE_VIEWER_COUNT_FRESHNESS_MS;
  const capacitySnapshotIntervalMs = config.capacitySnapshot?.intervalMs ?? CAPACITY_SNAPSHOT_INTERVAL_MS;
  const maxViewersPerSession = config.maxViewersPerSession ?? MAX_VIEWERS_PER_SESSION;
  const viewerPingIntervalMs = config.viewerPing?.intervalMs ?? VIEWER_PING_INTERVAL_MS;
  const wsConnectionLimiter = createRateLimiter(config.wsConnectionLimit ?? WS_CONNECTION_LIMIT);
  const stateBus = config.stateBus ?? createLocalStateBus();
  // Per-attachRelayWebSocketServer-call identity, used three ways: to let
  // this instance's own StateBus subscription no-op on messages it just
  // published itself (see broadcastToLocalViewers' doc comment), as the
  // originInstanceId keying other instances' remoteViewerCounts tables,
  // and (as a short prefix) on every log line so interleaved replica logs
  // are distinguishable.
  const instanceId = randomUUID();
  // See logging.ts's ALLOWED_LOG_FIELDS note on "instanceId" — every log
  // line from this attach carries the short id; shadowing the import keeps
  // all the existing call sites below untouched.
  const logEvent = (event: string, fields: LogFields = {}): void => emitLogEvent(event, { ...fields, instanceId: instanceId.slice(0, 8) });
  const sessions = new Map<string, Session>();
  /**
   * sessionId -> (remote instanceId -> that instance's last self-reported
   * viewer count and when it arrived). Fed by "viewer-count" bus messages;
   * read by sendViewerCount to tell a locally-connected producer the
   * fleet-wide total rather than only this instance's own socket count
   * (which under N replicas would show the streamer ~1/N of the real
   * audience). Entries older than remoteViewerCountFreshnessMs are ignored
   * on read and pruned by the sweep — silence means the reporting instance
   * is gone (see VIEWER_COUNT_HEARTBEAT_MS), and its viewers with it.
   */
  const remoteViewerCounts = new Map<string, Map<string, { count: number; at: number }>>();
  // Set during verifyClient (upgrade time), consumed once in the
  // "connection" handler for the same request — this is how the resolved
  // identity crosses from the async pre-accept check into the now-accepted
  // socket, since ws's verifyClient and connection handlers don't
  // otherwise share a channel.
  const pendingProducerAuth = new WeakMap<IncomingMessage, ProducerBinding>();
  const connectionStates = new WeakMap<WebSocket, ConnectionState>();
  /** Sockets admitted via youtube-subscribe — the only ones that receive the application-level keepalive ping (see VIEWER_PING_INTERVAL_MS); legacy/Twitch viewers never see a message shape their parser doesn't know. Entries are removed on socket close. */
  const youtubePingTargets = new Set<WebSocket>();
  /** "platform:externalId" -> last resolution (session key, or null for an authoritative "no mapping") and when it was resolved — see PLATFORM_RESOLUTION_CACHE_MS. */
  const platformResolutionCache = new Map<string, { sessionId: string | null; at: number }>();

  function getSession(sessionId: string): Session {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: Session = {
      producer: null,
      viewers: new Set(),
      latestState: null,
      lastUpdatedAt: Date.now(),
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

  /** This instance's local sockets plus every OTHER instance's last fresh self-report — the number a streamer should actually see under N replicas. Stale remote entries are skipped (not trusted) here and physically pruned by the sweep. */
  function totalViewerCount(sessionId: string, session: Session): number {
    let total = session.viewers.size;
    const remote = remoteViewerCounts.get(sessionId);
    if (remote) {
      const now = Date.now();
      for (const { count, at } of remote.values()) {
        if (now - at <= remoteViewerCountFreshnessMs) total += count;
      }
    }
    return total;
  }

  /** Tells the producer how many viewers are currently subscribed fleet-wide (see totalViewerCount) — the only thing the relay ever sends back to a producer socket (see ViewerCountMessageSchema's own doc comment for why). A no-op if there's no open producer connection to tell; callers don't need to check isProducerConnectionOpen themselves first. Wire protocol to the extension is unchanged — only what the count means grew. */
  function sendViewerCount(sessionId: string, session: Session): void {
    if (!isProducerConnectionOpen(session)) return;
    session.producer!.send(JSON.stringify({ type: "viewer-count", count: totalViewerCount(sessionId, session) }));
  }

  /** Reports this instance's OWN local socket count for the session to the rest of the fleet — on every local change (admit/disconnect) and from the heartbeat below. Deliberately the raw local count, never totalViewerCount: publishing sums of sums would double-count every other instance's viewers back at them. */
  function publishLocalViewerCount(sessionId: string, session: Session): void {
    stateBus.publish({ kind: "viewer-count", sessionId, originInstanceId: instanceId, count: session.viewers.size });
  }

  /** Builds the TTL sweep's synthesized clear broadcast — reuses the expiring state's own protocolVersion/sourceViewport (both required, non-optional schema fields) rather than inventing placeholder values, and bumps sequence by one so a viewer watching the raw stream sees a normal-looking next state, not a repeat. overlayConfig is carried forward too — a quiet board clears its CARDS, not the broadcaster's calibration; dropping it here would silently de-calibrate every non-Twitch viewer until the next real update (the exact trap protocol's OverlayStateSchema doc comment warns synthesizers about). */
  function synthesizeEmptyState(sessionId: string, previous: OverlayState): OverlayState {
    return {
      protocolVersion: previous.protocolVersion,
      sessionId,
      sequence: previous.sequence + 1,
      capturedAt: Date.now(),
      sourceViewport: previous.sourceViewport,
      cards: [],
      overlayConfig: previous.overlayConfig,
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
    // Prune remote viewer-count entries whose reporting instance has gone
    // silent past the freshness window (crashed, partitioned, or simply no
    // longer running) — totalViewerCount already ignores them on read, but
    // leaving them in the map would grow it forever across dead instances,
    // and a locally-connected producer should also be TOLD its audience
    // shrank, not just have the next incidental recount reflect it.
    for (const [sessionId, remote] of remoteViewerCounts) {
      let pruned = false;
      for (const [remoteInstanceId, entry] of remote) {
        if (now - entry.at > remoteViewerCountFreshnessMs) {
          remote.delete(remoteInstanceId);
          pruned = true;
        }
      }
      if (remote.size === 0) remoteViewerCounts.delete(sessionId);
      if (pruned) {
        const session = sessions.get(sessionId);
        if (session) sendViewerCount(sessionId, session);
      }
    }
    for (const [sessionId, session] of sessions) {
      // Reap any session this instance no longer has a local stake in — no
      // local producer socket AND no local viewers. This is the cleanup
      // half of the no-materialization rule (see the StateBus subscribe
      // handler): that rule refuses to CREATE a Session for bus traffic
      // nothing here is watching, and this removes one that has BECOME
      // stakeless. Without it, `sessions` only ever grew — one entry per
      // distinct channel id this process ever saw, each pinned in memory
      // holding a full `latestState` that the bus kept refreshing for an
      // audience that had already left (a producer on another instance
      // keeps publishing; this instance keeps applying it to zero local
      // viewers). Dropping it is safe precisely because state is no longer
      // process-local truth: a returning local viewer reconstructs the
      // session and reloads the current board from the snapshot store (see
      // admitViewer), and the bus handler ignores traffic for a session it
      // no longer holds. Deleting the current key mid-iteration is safe for
      // a Map. Note `latestState` is intentionally NOT part of the
      // condition: with zero local consumers, retained state serves nobody,
      // so its freshness is irrelevant to whether this instance should keep
      // the entry.
      if (session.producer === null && session.viewers.size === 0) {
        sessions.delete(sessionId);
        remoteViewerCounts.delete(sessionId); // no local producer to report a count to; a bus report would re-create this lazily if one ever reappears
        logEvent("session_reaped", { sessionId });
        continue;
      }
      if (!session.latestState) continue;
      if (isProducerConnectionOpen(session)) continue; // still connected — a static board is not staleness
      if (now - session.lastUpdatedAt <= stateTtlMs) continue;

      // Expiry is purely local: this instance expires only ITS OWN copy and
      // tells only ITS OWN viewers — nothing is published to the bus. Every
      // other instance runs the same sweep against its own lastUpdatedAt
      // (refreshed by bus-received state), so a genuinely dead session ages
      // out everywhere within one TTL without any coordination, and a
      // crashed instance can't strand the fleet holding stale state (the
      // failure mode of the earlier cross-instance "authority" design this
      // replaced). Known tradeoff: an instance that does NOT hold the
      // producer socket can't see that the producer is merely quiet-but-
      // connected (a static board), so its viewers get a clear after
      // STATE_TTL_MS of bus silence while the producer's own instance
      // correctly keeps serving — recoverable (the next real update
      // repopulates everyone), unlike stale-forever.
      const emptyState = synthesizeEmptyState(sessionId, session.latestState);
      session.latestState = null;
      logEvent("state_ttl_expired", { sessionId, viewers: session.viewers.size });
      broadcastToLocalViewers(session, emptyState);
    }
  }

  const ttlSweepInterval = setInterval(sweepStaleSessions, ttlSweepIntervalMs);

  // The liveness half of the viewer-count contract (see
  // VIEWER_COUNT_HEARTBEAT_MS): re-publish every session this instance
  // holds viewers for, so other instances' freshness windows keep being
  // refreshed exactly as long as — and no longer than — this instance is
  // actually alive and holding sockets.
  const viewerCountHeartbeatInterval = setInterval(() => {
    for (const [sessionId, session] of sessions) {
      if (session.viewers.size > 0) publishLocalViewerCount(sessionId, session);
    }
  }, viewerCountHeartbeatMs);

  /**
   * Periodic capacity sample for an operator dashboard (Stage 4): this
   * instance's own concurrency, distinguishable per replica by the
   * instanceId every log line already carries. `viewers`/`producers` are
   * summed across sessions rather than per-session so one line answers "how
   * loaded is this replica right now"; `sessions` is the map size, which is
   * also the memory-footprint signal the reaping sweep keeps bounded.
   */
  // Keepalive for youtube-path sockets only — see youtubePingTargets. Sent
  // regardless of board activity; a dead socket's send is a no-op and the
  // close handler prunes the set.
  const viewerPingInterval = setInterval(() => {
    const encoded = JSON.stringify({ type: "ping" });
    for (const viewer of youtubePingTargets) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(encoded);
    }
  }, viewerPingIntervalMs);

  const capacitySnapshotInterval = setInterval(() => {
    let viewers = 0;
    let producers = 0;
    for (const session of sessions.values()) {
      viewers += session.viewers.size;
      if (isProducerConnectionOpen(session)) producers += 1;
    }
    logEvent("capacity_snapshot", { sessions: sessions.size, viewers, producers });
  }, capacitySnapshotIntervalMs);

  /**
   * Applies bus traffic that originated on a DIFFERENT instance — see
   * broadcastToLocalViewers' doc comment for why this instance's own
   * originated updates are never round-tripped back through here. Note
   * there is deliberately no expiry message kind to handle: TTL expiry is
   * purely local (see sweepStaleSessions).
   *
   * Only sessions that already exist locally (a viewer or producer here
   * created them) are touched — `sessions.get`, never getSession. Without
   * that, every instance would materialize a Session (holding a full
   * OverlayState) for every session fleet-wide and never delete it,
   * unbounded memory for state nobody here is looking at. An instance
   * with no local stake needs none of this traffic: a viewer arriving
   * later is covered by the snapshot store (see admitViewer), and
   * viewer counts for a session with no local producer inform nobody.
   */
  const unsubscribeFromStateBus = stateBus.subscribe((message) => {
    if (message.originInstanceId === instanceId) return; // already applied locally at the point of origin
    const session = sessions.get(message.sessionId);
    if (!session) return;
    if (message.kind === "viewer-count") {
      let remote = remoteViewerCounts.get(message.sessionId);
      if (!remote) {
        remote = new Map();
        remoteViewerCounts.set(message.sessionId, remote);
      }
      remote.set(message.originInstanceId, { count: message.count, at: Date.now() });
      // Recompute immediately so a locally-connected producer's popup
      // tracks remote joins/leaves at change speed, not sweep speed.
      sendViewerCount(message.sessionId, session);
      return;
    }
    session.latestState = message.state;
    session.lastUpdatedAt = Date.now();
    const delivered = broadcastToLocalViewers(session, message.state);
    logEvent("state_broadcast", {
      sessionId: message.sessionId,
      sequence: message.state.sequence,
      cards: message.state.cards.length,
      viewers: delivered,
    });
  });

  function bindAuthenticatedProducer(ws: WebSocket, state: ConnectionState, binding: ProducerBinding): void {
    state.producerBinding = binding;
    const sessionId = sessionKeyForBroadcaster(binding.broadcasterId);
    const session = getSession(sessionId);
    if (session.producer && session.producer !== ws && session.producer.readyState === WebSocket.OPEN) {
      logEvent("producer_replaced", { sessionId, broadcasterId: binding.broadcasterId });
      session.producer.close(CLOSE_CODE.PRODUCER_REPLACED, "replaced-by-new-producer-connection");
    }
    session.producer = ws;
    logEvent("producer_connected", { sessionId, broadcasterId: binding.broadcasterId });
    sendViewerCount(sessionId, session);
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
            pendingProducerAuth.set(req, { broadcasterId: result.broadcasterId });
            callback(true);
          });
        }
      : undefined,
  });

  /** admitViewer's freshness gate over this instance's own copy, shared with the snapshot-fallback re-check below. A live producer connection always means the state is trusted, however long ago it last actually changed — see isProducerConnectionOpen's doc comment. */
  function hasFreshLocalState(session: Session): boolean {
    return session.latestState !== null && (isProducerConnectionOpen(session) || Date.now() - session.lastUpdatedAt <= stateTtlMs);
  }

  /** One instance's per-session viewer ceiling — see MAX_VIEWERS_PER_SESSION. Checked by every subscribe path before admitViewer; only the youtube path can SAY so to the client (subscribe-rejected), the legacy/Twitch paths reject with the same silence as their other refusals. */
  function sessionAtCapacity(session: Session): boolean {
    return session.viewers.size >= maxViewersPerSession;
  }

  /** Explicit refusal for the youtube path only — the one viewer vocabulary that includes subscribe-rejected (see protocol's SubscribeRejectedMessageSchema). Never sent to legacy/Twitch sockets: their parsers would just warn-and-drop it. */
  function sendSubscribeRejected(ws: WebSocket, reason: SubscribeRejectedReason): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe-rejected", reason }));
  }

  // Shared by both the plain (local-debug) and Twitch-authenticated
  // subscribe paths once each has independently decided the request is
  // trusted — this function itself does no authorization, it only admits.
  // Async only for the snapshot fallback at the bottom; admission itself
  // (viewers.add and the counted log/viewer-count send) happens
  // synchronously before the first await, so a producer update arriving
  // mid-load still reaches this viewer via broadcastToLocalViewers.
  // Capacity is the caller's check (sessionAtCapacity), not repeated here —
  // callers need the answer BEFORE deciding how to refuse.
  async function admitViewer(ws: WebSocket, sessionId: string): Promise<void> {
    const session = getSession(sessionId);
    session.viewers.add(ws);
    logEvent("viewer_admitted", { sessionId, viewers: session.viewers.size });
    sendViewerCount(sessionId, session);
    publishLocalViewerCount(sessionId, session);
    // Belt-and-suspenders alongside sweepStaleSessions above: the sweep
    // only runs every TTL_SWEEP_INTERVAL_MS, so a state that just crossed
    // STATE_TTL_MS moments ago (with no live producer) could still be
    // sitting in latestState when a new viewer connects — this check means
    // a newly-admitted viewer never receives truly stale hitboxes
    // regardless of sweep timing.
    if (hasFreshLocalState(session)) {
      ws.send(JSON.stringify({ type: "overlay-state", payload: session.latestState }));
      return;
    }
    // No fresh local copy — the case a freshly started/restarted instance
    // is in for EVERY session (routine during rolling deploys, where a
    // viewer routed here would otherwise stare at a blank overlay until
    // the producer's next real update). The bus's snapshot store holds the
    // producer's last publish, TTL-bounded, so a hit here is fresh by
    // definition. loadSnapshot never rejects (see the StateBus contract).
    const snapshot = await stateBus.loadSnapshot(sessionId);
    // Re-check after the await: a real producer update (local or bus) that
    // landed while the load was in flight is newer than any snapshot and
    // was already sent to this viewer by broadcastToLocalViewers — sending
    // the snapshot on top would regress the viewer to older state.
    if (hasFreshLocalState(session)) return;
    if (snapshot === null || ws.readyState !== WebSocket.OPEN) return;
    // Seed this instance's own copy so (a) the next viewer admits without
    // a round trip, and (b) the local TTL sweep takes ownership of
    // clearing what was just delivered — without this, a snapshot-served
    // overlay on an instance that never hears from the bus again would
    // linger on the viewer's screen forever. lastUpdatedAt = now (not the
    // producer's original publish time, which this instance can't know)
    // stretches worst-case staleness to snapshot-TTL + sweep-TTL — two
    // recoverable TTL windows, accepted over adding clocks to the wire.
    session.latestState = snapshot;
    session.lastUpdatedAt = Date.now();
    ws.send(JSON.stringify({ type: "overlay-state", payload: snapshot }));
  }

  /**
   * Cached channel->session resolution shared by both platform viewer
   * paths. A cache entry (hit or authoritative null) is served for
   * PLATFORM_RESOLUTION_CACHE_MS; resolver errors fail this one request
   * closed without being cached, so a transient DB blip doesn't blank a
   * channel for a whole window.
   */
  async function resolvePlatformSession(
    platform: "twitch" | "youtube",
    externalId: string,
    resolver: (externalId: string) => Promise<string | null>
  ): Promise<string | null> {
    const cacheKey = `${platform}:${externalId}`;
    const cached = platformResolutionCache.get(cacheKey);
    if (cached && Date.now() - cached.at <= PLATFORM_RESOLUTION_CACHE_MS) return cached.sessionId;
    try {
      const sessionId = await resolver(externalId);
      platformResolutionCache.set(cacheKey, { sessionId, at: Date.now() });
      return sessionId;
    } catch {
      logEvent("viewer_rejected", { reason: `${platform}-resolution-failed`, youtubeChannelId: platform === "youtube" ? externalId : undefined, channelId: platform === "twitch" ? externalId : undefined });
      return null;
    }
  }

  /**
   * The twitch-subscribe admission flow post-JWT-verification: resolve the
   * verified channel_id to the broadcaster's internal session (see
   * RelayConfig.resolveTwitchChannel — absent, the legacy direct-keying
   * behavior applies for dev/tests), then admit through the same
   * admitViewer as every other path. Rejections stay SILENT on this path —
   * the Twitch viewer's parser has no rejection vocabulary, and silence is
   * its established contract.
   */
  async function admitTwitchViewer(ws: WebSocket, channelId: string): Promise<void> {
    const resolver = config.resolveTwitchChannel;
    const sessionId = resolver ? await resolvePlatformSession("twitch", channelId, resolver) : channelId;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (sessionId === null) {
      logEvent("viewer_rejected", { reason: "unknown-twitch-channel", channelId });
      return;
    }
    if (sessionAtCapacity(getSession(sessionId))) {
      logEvent("viewer_rejected", { reason: "session-at-capacity", sessionId, channelId });
      return;
    }
    await admitViewer(ws, sessionId);
  }

  /**
   * The youtube-subscribe admission flow: resolve the public channel id to
   * a broadcaster session (streamer-claimed mapping — see
   * /api/youtube-channel), refuse explicitly when there's no mapping or
   * the session is full, otherwise admit through the exact same
   * admitViewer every other path uses (snapshot fallback included) and
   * start keepalive pings for this socket. The viewer stays anonymous
   * throughout — nothing about them is read or stored beyond the socket
   * itself.
   */
  async function admitYouTubeViewer(ws: WebSocket, youtubeChannelId: string): Promise<void> {
    const resolver = config.resolveYouTubeChannel;
    const sessionId = resolver ? await resolvePlatformSession("youtube", youtubeChannelId, resolver) : null;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (sessionId === null) {
      logEvent("viewer_rejected", { reason: config.resolveYouTubeChannel ? "unknown-youtube-channel" : "youtube-resolver-not-configured", youtubeChannelId });
      sendSubscribeRejected(ws, "unknown-channel");
      return;
    }
    const session = getSession(sessionId);
    if (sessionAtCapacity(session)) {
      logEvent("viewer_rejected", { reason: "session-at-capacity", sessionId, youtubeChannelId });
      sendSubscribeRejected(ws, "at-capacity");
      return;
    }
    youtubePingTargets.add(ws);
    await admitViewer(ws, sessionId);
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

      // An authenticated producer's session is resolved once, server-side,
      // from its credential (the internal broadcaster id — see
      // sessionKeyForBroadcaster) — the message's own sessionId is never
      // trusted for that socket, exactly mirroring the viewer JWT path's
      // channel_id-claim-over-client-value discipline. Unauthenticated
      // (legacy/dev) producers keep today's behavior unchanged: whatever
      // sessionId the message itself claims.
      const overlayState = binding
        ? { ...producerMessage.data.payload, sessionId: sessionKeyForBroadcaster(binding.broadcasterId) }
        : producerMessage.data.payload;
      const session = getSession(overlayState.sessionId);
      // Last producer to send for a session wins — no arbitration between
      // multiple producers targeting the same *unauthenticated* session.
      // Authenticated producers are arbitrated earlier, at connection time,
      // by bindAuthenticatedProducer's replace-on-reconnect.
      const isNewProducerBinding = session.producer !== ws;
      session.producer = ws;
      session.latestState = overlayState;
      session.lastUpdatedAt = Date.now();
      // Only on a genuinely new binding (not every publish from an
      // already-bound producer) — sendViewerCount is idempotent either
      // way, this just avoids a redundant message on every single publish
      // tick from a producer that's been connected the whole time.
      if (isNewProducerBinding) sendViewerCount(overlayState.sessionId, session);

      const delivered = broadcastToLocalViewers(session, overlayState);
      logEvent("state_broadcast", {
        sessionId: overlayState.sessionId,
        sequence: overlayState.sequence,
        cards: overlayState.cards.length,
        viewers: delivered,
        bytes,
      });
      stateBus.publish({ kind: "state", sessionId: overlayState.sessionId, originInstanceId: instanceId, state: overlayState });
      // Same TTL as the sweep: the snapshot must never outlive what this
      // instance itself would be willing to hand a late-joining viewer.
      stateBus.saveSnapshot(overlayState.sessionId, overlayState, stateTtlMs);
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
      if (sessionAtCapacity(getSession(subscribeMessage.data.sessionId))) {
        logEvent("viewer_rejected", { reason: "session-at-capacity", sessionId: subscribeMessage.data.sessionId });
        return;
      }
      state.invalidMessageCount = 0;
      void admitViewer(ws, subscribeMessage.data.sessionId);
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
      void admitTwitchViewer(ws, channelId);
      return;
    }

    const youtubeSubscribeMessage = YouTubeSubscribeMessageSchema.safeParse(parsed);
    if (youtubeSubscribeMessage.success) {
      state.subscribeAttempts += 1;
      if (state.subscribeAttempts > MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET) {
        logEvent("connection_disconnected", { reason: "too-many-subscribe-attempts", count: state.subscribeAttempts });
        ws.close(CLOSE_CODE.TOO_MANY_SUBSCRIBE_ATTEMPTS, "too-many-subscribe-attempts");
        return;
      }
      state.invalidMessageCount = 0;
      void admitYouTubeViewer(ws, youtubeSubscribeMessage.data.channelId);
      return;
    }

    // A youtube-subscribe whose channelId flunks the UC... pattern fails
    // the schema parse above, but unlike other malformed traffic the
    // client is a well-meaning viewer extension that deserves an explicit
    // answer (a typo'd claim/odd page shouldn't look like a dead relay).
    // Still counted as a subscribe attempt so a channel-guessing socket
    // burns its attempt budget, not the invalid-message one.
    if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "youtube-subscribe") {
      state.subscribeAttempts += 1;
      if (state.subscribeAttempts > MAX_SUBSCRIBE_ATTEMPTS_PER_SOCKET) {
        logEvent("connection_disconnected", { reason: "too-many-subscribe-attempts", count: state.subscribeAttempts });
        ws.close(CLOSE_CODE.TOO_MANY_SUBSCRIBE_ATTEMPTS, "too-many-subscribe-attempts");
        return;
      }
      logEvent("viewer_rejected", { reason: "invalid-youtube-channel-id" });
      sendSubscribeRejected(ws, "invalid-channel");
      return;
    }

    markInvalid(ws, state, "schema-validation-failed");
  }

  wss.on("connection", (ws, req) => {
    // Connection-level throttle, before any per-socket bookkeeping — a
    // client IP churning connections gets each new socket closed
    // immediately with a distinct code, bounding both socket count and
    // the handler work a storm can cause. See WS_CONNECTION_LIMIT and
    // clientIpOf for the X-Forwarded-For keying rationale.
    if (!wsConnectionLimiter.tryConsume(clientIpOf(req))) {
      logEvent("connection_disconnected", { reason: "connection-rate-limited", remoteAddress: clientIpOf(req) });
      ws.close(CLOSE_CODE.CONNECTION_RATE_LIMITED, "connection-rate-limited");
      return;
    }

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
      youtubePingTargets.delete(ws);
      for (const [sessionId, session] of sessions) {
        if (session.producer === ws) {
          session.producer = null;
          logEvent("producer_disconnected", { channelId: sessionId });
        }
        if (session.viewers.delete(ws)) {
          logEvent("viewer_disconnected", { sessionId, viewers: session.viewers.size });
          sendViewerCount(sessionId, session);
          publishLocalViewerCount(sessionId, session);
        }
      }
    });
  });

  return {
    debugSessionCount: () => sessions.size,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Must be cleared here, not left running — an un-cleared
        // setInterval keeps the Node process (and, in tests, the test
        // runner) alive/hanging past this close() resolving.
        clearInterval(ttlSweepInterval);
        clearInterval(viewerCountHeartbeatInterval);
        clearInterval(viewerPingInterval);
        clearInterval(capacitySnapshotInterval);
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
    const { close: closeWs, debugSessionCount } = attachRelayWebSocketServer(httpServer, config);

    httpServer.on("error", reject);
    httpServer.listen(port, () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      console.log(`[relay] listening on ws://localhost:${boundPort}`);
      resolve({
        port: boundPort,
        debugSessionCount,
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
