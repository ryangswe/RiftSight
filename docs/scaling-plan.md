# RiftSight — Scaling Plan (multi-instance backend)

Written ahead of need, while the Twitch Extension is in Review, for once
multiple simultaneous large-viewership streamers make the current
single-instance backend a real risk, not a hypothetical one.

**Status: Stage 1 is done and verified** — code, unit/integration tests, a
real-Redis multi-instance harness (`relay/src/multi-instance.redis.test.ts`,
`npm run test:redis`), and a live two-instance browser verification (two
relay processes + local Redis + the debug viewer). It's fully opt-in and
inert until `REDIS_URL` is actually set — today's single-instance
deployment is unaffected (the full relay suite passes unmodified with no
`REDIS_URL`, which is the byte-identical-behavior proof). Everything
executable from a development machine is done, including the
`RIFTSIGHT_MIGRATE_ON_BOOT` boot-gating and the documentation sweep.
**What remains is exclusively operator/provisioning work** — nothing has
been provisioned (no Redis add-on, no Turso, no staging service, no extra
Railway replicas), deliberately held until the in-flight Twitch Extension
review lands: see "Stage 2+ operator checklist" below for the exact
sequence.

An earlier revision of this doc claimed Stage 1 done with "604/604 tests
passing" while the tree it described didn't compile (a bad merge had left
an undeclared identifier on the producer path) — a post-merge audit caught
that plus several real design gaps (a crash-stale expiry-authority design,
no restart snapshot, viewer counts not fanned out, no ioredis error
handling, unbounded cross-fleet session materialization). All of those are
fixed and re-verified in the current tree; the "What Stage 1 actually
consists of" section below reflects the design as built, not as first
attempted.

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

## Stage 1 — Cross-instance live-state fan-out (the real engineering work) — DONE

This is the piece with no existing escape hatch. `server.ts`'s `sessions`
map and its `Set<WebSocket>` of viewers only exist within one process — a
viewer connected to instance B has no way to see a producer update that
arrived on instance A.

**What Stage 1 actually consists of, as built:**

- **`StateBus` abstraction** (`relay/src/state-bus.ts`,
  `relay/src/redis-state-bus.ts`): one fixed Redis pub/sub channel carrying
  two message kinds — sanitized `OverlayState` fan-out and per-instance
  viewer-count reports — plus a TTL-bounded latest-state snapshot
  (`SET riftsight:state:<sessionId> <json> PX <ttl>` / `GET`). The local
  in-process implementation remains the default everywhere `REDIS_URL` is
  unset, byte-identical to pre-Stage-1 behavior.
- **Purely-local TTL expiry.** Each instance expires its own copy of a
  session's state on its own timer (from `lastUpdatedAt`, refreshed by both
  local producer writes and bus-received state) and tells only its own
  viewers — no cross-instance expiry coordination at all. An earlier design
  coordinated expiry through an authority flag and a claim message; it was
  scrapped because an instance crash lost the flag forever (stale state on
  every other instance) and the claim had no fencing (split-brain). Known
  accepted tradeoff: an instance without the producer socket can't tell
  quiet-but-connected from gone, so its viewers get a clear after a TTL of
  bus silence — recoverable on the next real update, unlike stale-forever.
- **Restart/rolling-deploy snapshot.** A viewer admitted on an instance
  with no fresh local copy is served from the Redis snapshot — without
  this, every viewer routed to a freshly started replica saw a blank
  overlay until the producer's next update.
- **Cross-instance viewer counts.** Each instance publishes its own local
  count per session (on change + ~5s heartbeat while nonzero); a producer
  is told the fleet-wide sum, with silent instances' reports aging out in
  ~15s (a crashed replica's viewers leave the count instead of freezing in
  it). Without this, N replicas would show a streamer ~1/N of their real
  audience.
- **Bounded memory.** Bus traffic only applies to sessions the receiving
  instance already has a local stake in — no instance materializes state
  for sessions it has no viewers or producer for.
- **Redis failure hardening.** Error listeners on both clients, every
  publish/SET caught-and-logged, subscribe failures logged not fatal:
  Redis down degrades (local viewers keep working) rather than crashing
  the relay. See the operator runbook's "Redis unavailable" section for
  the observable behavior.
- **Boot-migration gating** (`RIFTSIGHT_MIGRATE_ON_BOOT=false`) so N
  replicas can't race migrations — see docs/railway-deployment.md §7.
- **Replica-distinguishable logs**: every log line carries an 8-char
  per-boot `instanceId` (the Stage 4 quick win, done early).

**Verified**: full suite green (666 tests; the no-`REDIS_URL` relay tests
unmodified, proving the single-instance default unchanged), a real-Redis
harness (`npm run test:redis`) spawning its own `redis-server` and
covering fan-out, fresh-instance snapshot recovery, viewer-count
aggregation, and independent per-instance TTL expiry, and a live
two-instance browser session verifying the same four behaviors end-to-end
(including a mid-session relay restart recovering via snapshot, and a
killed instance's viewer count pruning out after ~15s).

## Stage 2+ operator checklist (the deferred provisioning work)

Everything below is account/console/infra work, deliberately deferred
until the Twitch Extension review lands (backend changes never trigger
re-review, but a stable prod during review is the safe posture). Do the
steps in order; none of the production steps should be done piecemeal.

1. **Provision Turso** (Stage 0): create the database
   (`turso db create riftsight` or the dashboard), get the `libsql://…`
   URL + auth token. Run migrations against it once from a local machine:
   `cd relay && RIFTSIGHT_DB_PATH='libsql://…' npm run migrate`. Copy the
   current allowlist/broadcaster/credential rows from the Railway volume's
   SQLite file (backup per docs/railway-deployment.md §11, then restore
   the rows into Turso — plain SQLite-dialect SQL, wire-compatible).
2. **Provision Redis**: Railway project canvas → Create → Database →
   Redis; reference its connection string as `REDIS_URL` on the relay
   service (Railway variables support `${{Redis.REDIS_URL}}`-style
   references).
3. **Cut the relay service over**: set `RIFTSIGHT_DB_PATH` to the
   `libsql://…` URL, set `RIFTSIGHT_MIGRATE_ON_BOOT=false`, remove
   `deploy.requiredMountPath: "/data"` from `railway.json` (a code-adjacent
   edit that takes effect on deploy — bundled here deliberately, since the
   mount physically prevents a second replica), detach the volume, deploy,
   and confirm `/ready` + a producer/viewer session against the remote DB
   at **one replica** first.
4. **Staging spike for the Stage-2 open question**: create a second
   Railway service from the same repo (staging), same env but staging
   Turso/Redis, bump its `numReplicas` to 2–3, and verify Railway's load
   balancer actually distributes long-lived WebSocket connections across
   replicas and drains them gracefully on a rolling deploy rather than
   dropping them mid-stream. This is the one genuinely unverifiable-
   locally behavior — if Railway handles WS poorly, that changes the
   provider conversation independent of everything else here. The
   `instanceId` log field is how you confirm connections actually spread.
5. **Bump production `numReplicas`** only after the spike passes. Keep the
   same public hostname (see "Does this need another Twitch review cycle?"
   — changing it would trigger one).

**Rollback path at every step**: unset `REDIS_URL` and return to one
replica — the no-Redis default is the pre-Stage-1 behavior, kept working
by the entire existing test suite.

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
unchanged. Two pieces are now **done**: the instance-identifier field
(every log line carries an 8-char per-boot `instanceId`) and the raw
capacity feed — each instance emits a periodic `capacity_snapshot` log
event (`sessions`/`viewers`/`producers`, ~60s, per-`instanceId`; see the
operator runbook's log table). What remains is purely operator-side and
platform-specific: standing up a dashboard/alert **on top of** that feed
(e.g. a log-based metric on `capacity_snapshot.viewers` with a threshold
alert) so capacity pressure is visible before it becomes an incident. No
further relay code is needed for it.

## Stage 5 — Testing and rollout

- The local multi-instance test harness is **done**
  (`relay/src/multi-instance.redis.test.ts`, `npm run test:redis` — spawns
  its own `redis-server`, skips cleanly where the binary is absent), and a
  live two-instance browser verification has been performed — see the
  Stage 1 "Verified" note.
- Roll out to a separate staging Railway service first, specifically to
  observe real multi-replica WS load-balancing behavior (the Stage 2 open
  question) before touching production — step 4 of the operator checklist.
- Keep the Stage 1 no-Redis fallback as the rollback path if anything goes
  wrong post-launch.

## What does NOT change

The Chrome producer extension, the Twitch Extension frontend
(`viewer.html`/`config.html`), the wire protocol/schema, the JWT auth flow,
and every CSP-relevant domain stay exactly as they are — this is the whole
reason none of this requires a new Twitch review.

## Suggested sequencing

Stage 1 (the pub/sub redesign, the highest-effort/highest-value piece) is
done, started and finished during the Twitch review wait per the reasoning
below — it was pure backend work with zero Twitch-review implications and no
dependency on approval status. Given approval could still land in as few as
2 business days from whenever Stages 2–5 pick up, don't expect to have
those *finished* by then either — but that's fine, since single-instance
keeps working fine for normal traffic in the meantime and nothing here
blocks release.
