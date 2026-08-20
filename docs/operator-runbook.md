# RiftSight closed-beta operator runbook

Operational reference for running the RiftSight backend (`relay/`) in closed-beta mode. For architecture, environment variables, and how to onboard a new streamer, see the main [README.md](../README.md)'s "Closed beta" section — this document is the day-to-day "how do I actually do X" companion to it, not a replacement.

Every command below assumes you're at the repo root unless noted otherwise.

## Deploy the backend

There's no automated deploy target in this repo by design — you choose and configure the platform (see README's "Deployment" section for Fly.io/Railway notes and the repo-root `Dockerfile`; if you're deploying to Railway specifically, see [docs/railway-deployment.md](railway-deployment.md) for the platform-specific steps this doc doesn't cover). Once deployed, the process is started with:

```bash
npm run start -w relay
```

reading `RIFTSIGHT_MODE=closed-beta` and every variable in `relay/src/env.ts`'s `REQUIRED_IN_CLOSED_BETA` from the environment. The process refuses to start (nonzero exit, clear error per missing variable) rather than booting into a half-configured state — check the startup logs first if it doesn't come up.

## Run migrations

Applied automatically at every boot (idempotent — a no-op once the database is current), but you can also apply them explicitly without starting the server — useful before a first deploy, or to confirm a migration landed:

```bash
npm run migrate -w relay
```

## Add / list / remove a beta user

Allowlist membership is stored by numeric Twitch user ID, never display name (a display name can change or be reused; an ID can't) — but `add`/`remove`/`credential-status` all accept a plain username too, resolved to its numeric ID automatically via Twitch's own API (using the same `TWITCH_API_CLIENT_ID`/`SECRET` already configured for OAuth linking). A streamer virtually never knows their own numeric ID offhand, so in practice you'll almost always just use their username:

```bash
npm run seed-allowlist -w relay -- add <twitchUserId-or-username> [note...]
npm run seed-allowlist -w relay -- list
npm run seed-allowlist -w relay -- remove <twitchUserId-or-username>
```

A purely-numeric argument is trusted as an ID directly (no API round trip); anything else is resolved as a username, printing the resolved ID so you can confirm it matched who you expected before it's written to the allowlist.

`remove` doesn't just stop future account linking — it blocks that broadcaster's *existing* producer credential too (see "Rotate or revoke a producer credential" below for why no separate revocation step is needed).

## Verify `/health`

Process liveness only — doesn't touch the database.

```bash
curl -i https://<backend-host>/health
```

Expect `200 {"status":"ok"}`.

## Verify `/ready`

Process liveness *and* the database actually responds to a query — point your platform's readiness/traffic-admission check here if it distinguishes readiness from liveness.

```bash
curl -i https://<backend-host>/ready
```

Expect `200 {"status":"ready"}`. A `503 {"status":"not-ready", ...}` means the process is up but can't reach its database — see "Diagnose: database unavailable" below.

## Inspect the startup configuration summary

On every boot in `closed-beta` mode, the process logs one structured `startup_summary` line — grep it out of your platform's log stream:

```bash
# example, adapt to however you view your platform's logs
<your-log-command> | grep startup_summary
```

It reports which subsystems are configured (`databaseConfigured`, `databasePersistentPath`, `localDebugEnabled`, `producerAuthRequired`, `twitchViewerAuthConfigured`, `oauthConfigured`) and the backend's own public hostname (`publicBackendOrigin`) — never a secret value, just booleans and a hostname. Use this as the first check after any deploy or restart: if something looks wrong (e.g. `oauthConfigured: false` when you expected OAuth to work), the underlying env var is missing or malformed.

## Confirm a producer connection

After a streamer clicks "Start publishing" in the extension, check the backend's logs for:

```
producer_connected  {channelId: "<their numeric Twitch ID>", broadcasterId: <n>}
```

If instead you see `producer_rejected`, the `reason` field tells you why (see "Diagnose: producer credential failure" below). If you see `producer_replaced`, a *second* connection took over — expected if the streamer reloaded the extension or has it open in two places; only a problem if they didn't expect it.

## Confirm a Twitch viewer subscription

```
viewer_admitted  {sessionId: "<channel id>", viewers: <n>}
```

`viewers` is the current count for that channel — should go from 0 to 1 (or more) shortly after a viewer's browser loads the Twitch Extension iframe. `viewer_rejected` with a `reason` (`invalid-twitch-jwt`, `channel-id-mismatch`, `twitch-extension-secret-not-configured`) means the JWT verification path is failing — check `TWITCH_EXTENSION_SECRET` first.

## Pre-flight before a large stream

The single production replica comfortably carries a 1,000–3,000-viewer
stream (see docs/scaling-plan.md, "Single-instance capacity"); the thing
worth proving the day before is the real network path, not the code.

1. Make sure the streamer is onboarded end to end: allowlisted (above),
   **Connected** in their extension popup, the Twitch Extension activated
   on their channel as a Video Overlay, calibration done if RiftAtlas
   doesn't fill their canvas, and a `producer_connected` line in the logs
   when they click Start publishing. Have them do a 5-minute private dry
   run — most "it didn't work" reports are onboarding, not capacity.
2. Run the production pre-flight from your own machine, with your own
   channel publishing from the extension so admission is proven:
   `TWITCH_EXTENSION_SECRET=… PREFLIGHT_CHANNEL_ID=<your numeric id> PREFLIGHT_VIEWERS=1000 npm run preflight-viewers -w relay`
   (secret from your password manager into the environment only). PASS =
   every socket connected, stayed open, and received state. Step up to
   2,000 if the audience might exceed 1,000 desktop viewers.
3. Check the Railway service's Metrics tab during the run: memory should
   stay flat in the low hundreds of MB, CPU low; note the egress rate —
   that, not CPU, is the resource that scales with viewers.
4. During the stream, the `state_broadcast` log line's `viewers` field is
   the live audience on the relay; `viewer_rejected` spikes mean an auth
   problem, `slow-consumer` disconnects mean a viewer's network, not yours.
5. Don't change production posture (replicas, Redis, Turso) the day before
   — the scaling plan's operator checklist is for a calm week.

## Rotate or revoke a producer credential

**Rotate** (streamer keeps access, gets a fresh credential — e.g. on suspected leak): the streamer's own extension can call this, or you can do it directly with their current credential:

```bash
curl -X POST https://<backend-host>/api/producer-credential/rotate \
  -H "Authorization: Bearer <their-current-producer-credential>"
```

Atomically invalidates the old token and returns a new one. Never ask a streamer to paste their credential to you over chat/support — if you need to force a rotation without their cooperation, remove and re-add them to the allowlist instead (below), which has the same effect (blocks the old credential; they get a fresh one next time they link).

**Revoke** (streamer should no longer be able to publish at all): remove them from the allowlist —

```bash
npm run seed-allowlist -w relay -- remove <twitchUserId-or-username>
```

Their next producer connection attempt is rejected (`producer_rejected`, `reason: "invalid, revoked, or de-allowlisted credential"`); an already-open connection isn't force-disconnected by this alone, only blocked from reconnecting.

## Credential lifecycle: long-lived, revocable, not expiring

Producer credentials are long-lived by design in this stage — there's no forced expiry, and none is planned until this moves past a manually-supported 3-10 streamer beta (see "Future work" below). What keeps this safe at this scale: every credential is revocable on demand (rotation or allowlist removal, both above), and `producer_credentials` now tracks `issued_at` (`created_at`), `last_used_at` (updated once per successful producer WebSocket authentication, never per overlay-state message), and `rotated_at` (set only when a credential was superseded by an explicit rotation, distinct from any other revocation reason) alongside the existing `revoked_at`.

Inspect a streamer's credential history (never prints a hash or the raw token):

```bash
npm run seed-allowlist -w relay -- credential-status <twitchUserId-or-username>
```

**Compromise-response procedure**, if a streamer reports (or you suspect) their credential leaked:

1. **Rotate** the credential (see above) — invalidates the old one immediately, they keep publishing with the new one, no re-linking needed.
2. **Remove allowlist access** if you believe the account itself (not just the credential) is compromised, or the streamer wants to pause entirely — this also blocks the credential from being replaced again until re-added.
3. **Verify the old credential is rejected**: `curl` the status endpoint with the old token (`GET /api/producer-credential/status`, `Authorization: Bearer <old-token>`) and confirm `"revoked_or_replaced"`, or attempt a `/ws/producer` connection with it and confirm the upgrade is refused.

**Future work (not in this stage):** automatic credential expiry with a refresh flow, before this moves to a self-service or public beta where 3-10 manually-supported streamers no longer holds. Adding forced expiry without a complete automatic refresh lifecycle first would trade a small security improvement for a much larger reliability risk (streamers silently losing publishing access with no prompt to fix it) — deliberately deferred, not forgotten.

## Restart the backend

```bash
# however your platform restarts a process — e.g. a redeploy, or:
kill -TERM <pid>   # graceful — the process handles SIGTERM itself
```

The process closes the WebSocket server, then the HTTP server, then the database, with a 10s force-exit fallback if anything hangs — safe to restart without special draining logic on your platform's side. On the next boot, pending migrations apply automatically, and a producer/viewer that were connected reconnect on their own (bounded backoff) — no manual relinking needed. The extension also forces a full, fresh snapshot the moment its connection comes back (not just a resubscribe), so a viewer who connects right after your restart doesn't have to wait for the board to actually change before seeing anything. See the README's manual acceptance test for the full expected restart-recovery sequence, including the RiftAtlas-closed-during-restart and database-unavailable variants.

## Roll back to the previous deployment

No destructive migrations exist yet (every migration so far only adds tables/columns) and there's no versioned wire-protocol break, so rolling back to a previous build of `relay/` is safe without a corresponding down-migration — a newer schema's extra columns simply go unused by an older build. Keep the previous build artifact/image available on whatever platform you use, so a rollback is "redeploy the last known-good image," not a rebuild under pressure.

## Back up the SQLite database

Simplest and safest for this scale (3–10 streamers, low write volume): stop the backend, copy the file, restart.

```bash
kill -TERM <pid>          # graceful stop — see "Restart the backend" above
cp /path/to/riftsight.db /path/to/backups/riftsight-$(date +%Y%m%d-%H%M%S).db
npm run start -w relay    # or however your platform restarts it
```

If you need a backup without stopping the process (SQLite allows a live/hot backup), and the `sqlite3` CLI is available on the host:

```bash
sqlite3 /path/to/riftsight.db ".backup /path/to/backups/riftsight-$(date +%Y%m%d-%H%M%S).db"
```

## Restore the SQLite database

Stop the backend, replace the file, restart:

```bash
kill -TERM <pid>
cp /path/to/backups/riftsight-<timestamp>.db /path/to/riftsight.db
npm run start -w relay
```

Pending migrations (if the backup predates a schema change) apply automatically on the next boot.

## Diagnosing common failures

### OAuth failure

Check for `oauth_link_failed` in the logs (status code included). Common causes: `TWITCH_API_CLIENT_ID`/`TWITCH_API_CLIENT_SECRET` wrong or unset, `TWITCH_OAUTH_REDIRECT_URI` not exactly matching what's registered in the Twitch API app (Twitch enforces an exact match — this backend can't work around a mismatch), or the streamer's Twitch account not yet on the allowlist (`403`, distinct from a genuine OAuth error — the OAuth exchange itself succeeded, the allowlist check afterward rejected it).

### Producer credential failure

Check `producer_rejected` — the `reason` field distinguishes a missing credential, an invalid/malformed one, and one that's revoked/de-allowlisted. If a streamer reports this and their allowlist entry looks fine, have them check the extension's Account section — a `credential-expired` status there means the extension itself already knows to prompt "reconnect Twitch."

The extension diagnoses this mostly on its own: after 2 consecutive failed connection attempts with a stored credential, it calls `GET /api/producer-credential/status` itself and only prompts "reconnect Twitch" if the backend confirms the credential is actually bad — a plain network blip never triggers that prompt. You can run the same check directly if you need to confirm a specific credential's state without waiting for the extension:

```bash
curl -s https://<backend-host>/api/producer-credential/status \
  -H "Authorization: Bearer <the-credential-in-question>"
# {"status":"valid" | "invalid_or_malformed" | "revoked_or_replaced" | "not_allowlisted"}
```

Rate-limited (20 requests/minute per source IP) and logged as `producer_status_check` with the outcome — the bearer credential itself never appears in that log line.

### Producer disconnected

Check for `producer_disconnected` (clean close) vs. no matching `producer_connected` at all (never reached). A clean disconnect followed by reconnect attempts (bounded backoff, up to 10s between attempts) is normal — the extension's own background worker survives Chrome suspending it and reconnects on wake. Persistent disconnection with no reconnect attempts logged at all usually means the extension itself isn't running (check the streamer restarted it) rather than a backend problem.

### Viewer subscription rejected

Check `viewer_rejected`'s `reason`. `channel-id-mismatch` means the viewer's Twitch JWT is valid but for a different channel than requested — not something either side can misconfigure; if you see this, something is wrong with how the Twitch Extension itself resolved the channel, worth escalating to Twitch's own status rather than debugging this backend. `twitch-extension-secret-not-configured` means `TWITCH_EXTENSION_SECRET` is missing — every viewer on every channel would be affected, not just one streamer.

### Database unavailable

`/ready` returns `503`. Check the database file's mount is actually present (a persistent-volume misconfiguration on your platform), and that `RIFTSIGHT_DB_PATH` points at it correctly — the `startup_summary` log line's `databaseConfigured`/`databasePersistentPath` fields are the fastest way to confirm the backend's own view of its configuration without needing filesystem access to the host.

### Redis unavailable (multi-replica deployments only)

Only applies when `REDIS_URL` is set (see [docs/scaling-plan.md](scaling-plan.md)); single-instance deployments have no Redis to lose. **A Redis outage never crashes or restarts the relay** — every Redis operation is fire-and-forget or degrade-to-nothing by design, and connection errors are logged (`redis_error`, `redis_reconnecting`) rather than thrown. What degrades while Redis is down, per instance:

- Viewers keep receiving updates **from a producer connected to the same instance** — the local path never touches Redis.
- Cross-instance fan-out pauses: a viewer on a different instance than the producer stops receiving updates, and after the staleness TTL of silence that instance clears its viewers' overlays (the same `state_ttl_expired` mechanism as a vanished producer — correct behavior, since from that instance's view the state really is unverifiable).
- Streamer viewer counts drop toward each instance's local count as other instances' reports age out (~15s).
- A freshly restarted instance can't load state snapshots, so viewers landing there see a blank overlay until the producer's next update.

Everything above self-heals when Redis returns — ioredis reconnects and re-subscribes on its own; the next producer update repopulates state and snapshots fleet-wide. No manual intervention beyond fixing/restarting Redis itself. A burst of `redis_error` lines during a blip is expected; continuous `redis_reconnecting` for minutes means Redis itself (or its network path) needs attention.

### Stale RiftAtlas state

A viewer sees hitboxes that don't match what's actually happening in the stream. First check whether the streamer's RiftSight extension is still actually detecting RiftAtlas (the extension's own Account/status section should say so) — if RiftAtlas was closed or the tab navigated away, the extension clears the retained overlay automatically within a bounded period. If it doesn't clear on its own, the backend's own freshness TTL is the defense-in-depth backstop for a producer that's genuinely gone (crashed, force-quit, network dropped mid-close) without ever sending that explicit clear — **but only once the producer's WebSocket connection has actually closed.** A still-connected producer whose board simply hasn't changed in a while (a slow turn, a paused session) is never treated as stale, however long it's been quiet — the TTL means "the producer disappeared," not "nothing changed recently." If a viewer is seeing genuinely wrong (not just old) hitboxes while the streamer's extension shows an active, connected producer, that's worth escalating as a bug rather than assumed to be TTL-related.

## Log event names

Every event below is emitted via `relay/src/logging.ts`'s `logEvent()` — structured JSON, one line per event, only fields from an explicit allowlist ever get logged (see "Secrets" below for what that guarantees).

| Event | Meaning |
|---|---|
| `startup_summary` | Sanitized configuration snapshot, closed-beta mode only, once per boot. |
| `oauth_link_succeeded` / `oauth_link_failed` | Result of a `/auth/twitch/callback` exchange. |
| `oauth_link_rejected` | The OAuth start endpoint itself was rate-limited. |
| `producer_connected` / `producer_disconnected` | An authenticated producer WebSocket opened/closed. |
| `producer_replaced` | A newer producer connection took over from an existing one for the same channel. |
| `producer_rejected` | A producer WebSocket upgrade or message was refused — `reason` field has specifics. |
| `producer_status_check` | The extension polled `/api/producer-credential/status` to disambiguate a connection failure. |
| `viewer_admitted` / `viewer_disconnected` | A viewer WebSocket subscribed/unsubscribed. |
| `viewer_rejected` | A viewer subscribe attempt was refused — `reason` field has specifics. |
| `credential_rotated` / `credential_rotate_failed` | Result of `POST /api/producer-credential/rotate`. |
| `credential_rotate_rejected` | The rotate endpoint itself was rate-limited. |
| `validation_failure` | A WebSocket message failed schema/size validation. |
| `connection_disconnected` | A socket was force-closed (too many invalid messages, too many subscribe attempts, a chronically slow viewer). |
| `state_broadcast` | A producer's state was accepted and forwarded to its subscribed viewers. Carries `viewers` (local recipients), `bytes` (inbound producer message size, producer-path lines only), and `outBytes` (the encoded outbound message size — multiply by `viewers` for that broadcast's egress). |
| `state_ttl_expired` | A session's retained state sat unrefreshed past the staleness TTL — an empty-cards clear was synthesized and broadcast to that session's locally-connected viewers. On the instance holding the producer socket, this only fires once that socket is actually gone (a still-connected, merely quiet producer never triggers it). On a multi-replica deployment, an instance that does NOT hold the producer judges by bus silence instead, so each instance fires its own copy of this event on its own timer. Expected occasionally (a crashed extension, a force-quit browser); frequent occurrences for one broadcaster are worth investigating. |
| `session_reaped` | A session was dropped from an instance's memory after it had no local producer and no local viewers left — routine cleanup (a streamer went offline, or all viewers on this instance left), not an error. Keeps memory bounded; a returning viewer reconstructs the session from the snapshot store. |
| `capacity_snapshot` | A periodic (~60s) sample of one instance's concurrency: `sessions` (in-memory session count), `viewers` (summed across all its sessions), `producers` (sessions with a live local producer), and `egressBytes` (application-payload bytes sent to viewers since the previous snapshot — the raw feed for egress-cost tracking; sum across snapshots for a stream-day total). Emitted continuously, including at zero. This is the raw feed for a capacity dashboard/alert — chart it per `instanceId` to see load spread across replicas. |
| `snapshot_lookup` | A newly admitted viewer had no fresh local state, so the bus snapshot store was consulted — `reason` is `hit` (snapshot served) or `miss` (nothing to serve; the viewer waits for the producer's next update). A rising miss rate during deploys is normal for a few seconds; sustained misses mean the snapshot store isn't being written (check Redis). |
| `redis_error` | A Redis operation or connection failed (multi-replica only — see "Redis unavailable" above). `reason` names the client role or operation. Logged and dropped, never fatal. |
| `redis_reconnecting` | ioredis is retrying a dropped Redis connection (multi-replica only). Bursts during a blip are normal; continuous occurrences mean Redis itself needs attention. |

Every log line also carries an `instanceId` field (an 8-character per-boot identifier) so interleaved logs from multiple replicas are distinguishable — on a single-instance deployment it simply changes on each restart.

## Secrets — never copy these into logs or support messages

- **Producer credentials** (the raw token, in any form — including a partial/truncated one). If a streamer pastes theirs into a support channel, tell them to rotate it (see above) rather than using the pasted value for anything.
- **The Twitch Extension shared secret** (`TWITCH_EXTENSION_SECRET`) and **Twitch API Client Secret** (`TWITCH_API_CLIENT_SECRET`) — backend-only, never needed to diagnose a streamer's individual issue.
- **Twitch Extension JWTs** (viewer auth tokens) — short-lived and never persisted, but also never worth pasting anywhere; if you need to debug one, decode its non-sensitive claims (e.g. `channel_id`) locally rather than sharing the raw token.
- **Database credential hashes** (`producer_credentials.token_hash`) — not a secret in the sense of granting access on their own (they're one-way hashes), but there's no legitimate reason to share one either; if you're looking at raw DB rows for debugging, treat the whole table as sensitive.

`relay/src/logging.ts`'s `logEvent()` structurally drops any field not on its explicit allowlist — none of the above can end up in a `logEvent()` call by accident, only by a future call site explicitly adding one of these names to the allowlist, which should never happen. Anything printed via a bare `console.log`/`console.error` outside that mechanism doesn't have this guarantee — if you're adding a new log line anywhere in this codebase, route it through `logEvent()`.
