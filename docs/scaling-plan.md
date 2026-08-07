# RiftSight — Scaling Plan (multi-instance backend)

Written ahead of need, while the Twitch Extension is in Review. Not yet
implemented — this is the plan to work from once multiple simultaneous
large-viewership streamers make the current single-instance backend a real
risk, not a hypothetical one. See "Suggested sequencing" at the bottom for
what's worth starting now versus waiting on.

## The actual problem

`relay/` is deliberately single-instance today (`railway.json`'s
`numReplicas: 1`) because two things assume it: a local SQLite file
(`RIFTSIGHT_DB_PATH`), and live `OverlayState` held in a process-local
`Map<string, Session>` (`server.ts`) where each `Session.viewers` is a
`Set<WebSocket>` — actual live socket objects, which by definition can't be
shared across processes. One popular streamer's viewer count is fine on one
instance; several simultaneous popular streamers each pushing hundreds-to-
low-thousands of viewer connections, plus the JSON/dedup work per producer
update, is the scenario that needs more than one process.

## Does this need another Twitch review cycle?

No — confirmed against Twitch's own extension life-cycle docs. Review is
triggered by submitting a **new extension version** (changed frontend files,
changed declared Capabilities, changed CSP-relevant domains). Twitch's own
guidance explicitly assumes your backend evolves independently: *"Ensure
your Extension Backend Service (EBS) can handle traffic from older versions
that are not yet refreshed."* Everything in this plan is backend-only:
`viewer.html`/`config.html`, the wire protocol, the JWT auth flow, and the
CSP domain allowlists (`assets.riftatlas-workers.com`,
`wss://riftsightrelay-production.up.railway.app`) all stay exactly as they
are.

**This is a hard constraint on the plan below, not just an observation**:
the public relay hostname must not change. If scaling work ever needs a load
balancer or a new domain in front of the relay, keep the same public
`riftsightrelay-production.up.railway.app` hostname pointing at it —
changing that hostname would mean re-declaring the URL Fetching Domains
allowlist, which *would* require a new version and a new review.

## Stage 0 — Already solved, just needs doing (no code changes)

The database layer already isn't SQLite-specific: `relay/src/db/client.ts`
wraps `@libsql/client`, whose whole point (per its own header comment) is
that a local file, `:memory:`, or a remote libSQL/Turso URL are all the same
`DbClient` — "none of the code above this module needs to change for that
swap." The migrations (`relay/src/db/migrations/*.sql`) are plain
SQLite-dialect SQL, which Turso is wire-compatible with directly, no
rewrite. So the persistent-data half of scaling is an **ops task, not an
engineering task**: provision a Turso database, run the existing migrations
against it once, copy over current allowlist/broadcaster/credential rows,
point `RIFTSIGHT_DB_PATH` at the `libsql://...` URL. Multiple relay
instances can then safely share one persistent store with zero application
code changes.

## Stage 1 — Cross-instance live-state fan-out (the real engineering work)

This is the piece with no existing escape hatch. `server.ts`'s `sessions`
map and its `Set<WebSocket>` of viewers only exist within one process — a
viewer connected to instance B has no way to see a producer update that
arrived on instance A.

Plan: add a pub/sub layer (Redis is the obvious choice — cheap, a supported
Railway add-on, and a pub/sub API simple enough not to need much new
abstraction) so that:
- Each instance keeps holding its own locally-connected producer and viewer
  `WebSocket`s exactly as today (sockets still can't cross processes — that
  doesn't change).
- When an instance receives a validated state update from *its* producer, it
  publishes the already-sanitized `OverlayState` to a Redis channel keyed by
  session/channel ID, instead of (or alongside) writing directly into a
  local map.
- Every instance subscribes to channels for sessions it has local viewers
  for, and forwards each message to its own locally-connected `viewers` set
  — same fan-out logic that exists today, just fed from a subscription
  instead of a local write.
- This removes any need for sticky routing: a producer or viewer can land on
  *any* instance behind the load balancer, since pub/sub — not which
  process happens to hold which socket — is what carries state across.

Secondary pieces that ride along with this:
- The stale-session TTL sweep (`sweepStaleSessions`) is naturally
  per-producer-connection already (a producer's socket is only ever held by
  one instance at a time), so this likely needs no redesign — worth
  confirming during implementation, not assuming.
- Keep a **graceful no-Redis fallback**: if `REDIS_URL` (or equivalent) is
  unset, behave exactly as today (single process, local map, no pub/sub) —
  matching this codebase's existing pattern of optional-env-var-gated
  features (`TWITCH_EXTENSION_CLIENT_ID`, `ALLOW_LOCAL_DEBUG`). This keeps
  local dev and small deployments simple, and gives a clean rollback path if
  multi-instance mode ever needs to be disabled in a hurry.

## Stage 2 — Infra changes

- Bump `railway.json`'s `numReplicas` above 1, provision the Redis add-on.
- **Open question worth a spike before committing further**: does Railway's
  own load balancer correctly distribute long-lived WebSocket connections
  across replicas, and drain connections gracefully on a rolling deploy
  rather than dropping them? Needs verifying against Railway's actual
  behavior, not assumed — if it doesn't handle WS well, that changes the
  provider conversation independent of everything else in this plan.
- Provision the Turso database (Stage 0) and do the one-time data copy.

## Stage 3 — Rate limiting: accept the tradeoff, don't rebuild it yet

`relay/src/rate-limit.ts`'s fixed-window counters are per-process, so N
replicas means a client could reach roughly N× the intended limit by
spreading requests across instances. At the realistic replica counts this
scenario needs (a handful, not hundreds), moving rate limiting to a shared
store (Redis again, but a second real subsystem to build and reason about)
is probably not worth doing preemptively — recommend documenting the
per-instance tradeoff and revisiting only if it's actually exploited, rather
than building distributed rate limiting against a threat that hasn't
materialized.

## Stage 4 — Observability

Structured JSON logging (`relay/src/logging.ts`) already exists and Railway
aggregates logs across replicas automatically, so this mostly carries over
unchanged. Worth adding: an instance identifier field to log lines (nothing
currently distinguishes which replica logged what), and a basic
dashboard/alert on concurrent viewer/producer counts so capacity pressure is
visible before it becomes an incident rather than after.

## Stage 5 — Testing and rollout

- A new local multi-instance test harness: two relay processes plus a local
  Redis, confirming a producer connected to instance A correctly reaches a
  viewer connected to instance B. Likely an extension of the existing
  `server.test.ts` integration-test pattern rather than a new framework.
- Roll out to a separate staging Railway service first, specifically to
  observe real multi-replica WS load-balancing behavior (the Stage 2 open
  question) before touching production.
- Keep the Stage 1 no-Redis fallback as the rollback path if anything goes
  wrong post-launch.

## What does NOT change

The Chrome producer extension, the Twitch Extension frontend
(`viewer.html`/`config.html`), the wire protocol/schema, the JWT auth flow,
and every CSP-relevant domain stay exactly as they are — this is the whole
reason none of this requires a new Twitch review.

## Suggested sequencing

Given approval could land in as few as 2 business days, this plan almost
certainly won't be *finished* by then — but it doesn't need to be, since
single-instance keeps working fine for normal traffic in the meantime; nothing
here blocks release. Stage 1 (the pub/sub redesign) is the highest-effort,
highest-value piece, is pure backend work with zero Twitch-review
implications, and doesn't depend on approval status at all — worth starting
during the review wait rather than after it, if there's appetite to begin
before this plan gets formally kicked off.
