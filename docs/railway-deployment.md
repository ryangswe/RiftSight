# Deploying RiftSight's backend to Railway

Railway-specific mechanics for standing up `relay/` as the closed-beta backend. Everything provider-agnostic — required env vars, migrations, secrets hygiene, rotate/revoke, backup/restore commands themselves, day-to-day diagnosis — is documented once in [docs/operator-runbook.md](operator-runbook.md); this doc only covers what's specific to Railway as the platform. See README's "Deployment" section for the provider-agnostic overview and the other platform option (Fly.io).

Every "Settings → ..." path below reflects Railway's dashboard layout as of this writing — Railway's UI does change over time, so if a label doesn't match what you see, use their current docs/support as the source of truth rather than assuming this doc is wrong.

## 1. Create the project

From the Railway dashboard: New Project → Deploy from GitHub repo → select this repository. **Leave the service's Root Directory at the repo root (unset/`/`) — do not point it at `relay/`.** The Dockerfile is built from the monorepo root deliberately (it needs every workspace's `package.json` to resolve the npm workspace graph — see the Dockerfile's own header comment); pointing Railway's Root Directory at a subdirectory would break that build context and `railway.json` wouldn't be found at all.

Railway auto-detects the repo-root [`railway.json`](../railway.json) and [`Dockerfile`](../Dockerfile) from there — no build configuration needed. `railway.json` pins the build to the Dockerfile explicitly (`build.builder: "DOCKERFILE"`), a single replica with sleep disabled (`deploy.numReplicas: 1`, `deploy.sleepApplication: false` — see "Stay at one replica" below for why), a `/ready`-based health check (see "Health check" below), a required volume mount (`deploy.requiredMountPath: "/data"` — see step 2), and a shutdown grace period long enough for the app's own shutdown path (`deploy.drainingSeconds: 15` — see "Graceful shutdown" below).

## 2. Create and mount the persistent volume

Do this **before** the first deploy that touches the database, so the very first `RIFTSIGHT_DB_PATH=file:/data/riftsight.db` write lands on persistent storage, not the container's ephemeral filesystem.

Command Palette (⌘K / Ctrl+K) → "Create Volume", or right-click the project canvas → "Create Volume" → attach it to the relay service → set the mount path to `/data`. Railway volumes are dashboard/CLI-provisioned resources, not something expressible as plain repo config — the one exception is `railway.json`'s `deploy.requiredMountPath: "/data"` (already set), which doesn't create the volume itself but makes Railway refuse to start the service if nothing is actually mounted at `/data` — a safety net against deploying before this step, rather than a silent fall-through to ephemeral storage.

## 3. Set environment variables

Railway's Variables tab on the service — every value here is set through Railway, never committed to the repo (matches this repo's existing `.env`/`.gitignore` discipline for every other deployment target).

Required (see `relay/src/env.ts`'s `REQUIRED_IN_CLOSED_BETA` — the process refuses to start if any of these is missing):

| Variable | Value |
|---|---|
| `RIFTSIGHT_MODE` | `closed-beta` |
| `RIFTSIGHT_DB_PATH` | `file:/data/riftsight.db` — must match the volume's mount path from step 2 |
| `TWITCH_EXTENSION_SECRET` | From the Twitch Extension's Developer Console registration |
| `TWITCH_API_CLIENT_ID` / `TWITCH_API_CLIENT_SECRET` | From the separate Twitch API app registration (OAuth linking) — see README's "Don't confuse these" for why this is a different credential from the Extension secret above |
| `TWITCH_OAUTH_REDIRECT_URI` | `https://<your-railway-domain>/auth/twitch/callback` — see step 5, this needs the domain first |

`PORT` is injected automatically by Railway — do not set it yourself; `relay/src/env.ts` already prefers `PORT` over `RELAY_PORT` when both are present, matching Railway's convention. `TWITCH_EXTENSION_CLIENT_ID`, `ALLOW_LOCAL_DEBUG`, `REDIS_URL`, and `RIFTSIGHT_MIGRATE_ON_BOOT` are optional (see README's env var table) and can be left unset in closed-beta — the latter two only matter for the multi-replica path in §8.

## 4. Deploy once, then generate the public domain

The first deploy will succeed on an internal-only address. Once it's up: Settings → Networking → Generate Domain. This gives you a stable `https://<something>.up.railway.app` address (or your own custom domain if you attach one the same way) — Railway also exposes this to the service's own environment as `RAILWAY_PUBLIC_DOMAIN` automatically once generated, if you want to reference it from other Railway-side tooling.

## 5. Wire the domain into every place that needs it

This one domain feeds four separate places — none of them are the same config, so all four need updating:

- **`TWITCH_OAUTH_REDIRECT_URI`** (relay's own env var, step 3 above): `https://<your-domain>/auth/twitch/callback`, and this exact string must also be registered in the Twitch API app's Developer Console settings — Twitch enforces an exact match, so a typo here fails every OAuth linking attempt with no ambiguity about why (see the operator runbook's "OAuth failure" diagnosis section).
- **`RIFTSIGHT_BACKEND_URL`** (build-time env var for `extension/`): `https://<your-domain>` — rebuild and repackage with `RIFTSIGHT_BACKEND_URL=https://<your-domain> npm run extension:package` (writes a fresh `riftsight-extension.zip` to `~/Downloads` — see the README's "Packaging the extension"), then redistribute that zip to every streamer whose install still points at the old domain.
- **`RIFTSIGHT_RELAY_URL`** (build-time env var for `twitch-extension/`): `wss://<your-domain>` (note the scheme — `wss:`, not `https:`) — rebuild with `RIFTSIGHT_RELAY_URL=wss://<your-domain> npm run build -w twitch-extension` (or `npm run package -w twitch-extension` to also produce the `deploy/` output for your stable asset host).
- **`extension/`'s generated `host_permissions`**: no separate step needed — `extension/build.mjs`'s existing `computeHostPermissions()` (see [Hardening Stage 2](../README.md)) already derives `["https://<host>/*", "wss://<host>/*"]` from `RIFTSIGHT_BACKEND_URL` at build time in closed-beta mode, so the same rebuild above already covers this.

## 6. Health check

`railway.json` points Railway's health check at `/ready` (not `/health`): Railway primarily uses this as a deploy-cutover gate — don't route traffic to a new deployment until it passes — and `/ready` additionally confirms the database is actually reachable, which matters right after a restart where pending migrations might still be applying. `/health` alone (process liveness only) would report healthy before that's necessarily true. `healthcheckTimeout: 100` (seconds) gives migrations room to finish; this is generous at this scale (3-10 streamers, a handful of small tables — the actual migration work is milliseconds), so treat 100s as headroom, not an estimate of how long it should actually take. Adjust upward only if you ever see a deploy genuinely time out here.

## 7. Migrations run at startup (single-replica) — never add a `preDeployCommand` for this

`relay/src/index.ts` applies any pending migration automatically on every boot by default (`runMigrations()` is idempotent — a no-op once the database is current), which is what makes it safe to run this way at all: see the operator runbook's migration notes. `railway.json` deliberately has no `deploy.preDeployCommand` set, and none should be added for migrations specifically, for a concrete reason beyond just redundancy: `preDeployCommand` runs in a separate, ephemeral pre-deploy step, and it isn't guaranteed to have the same persistent volume mounted that the real running service does (the volume can only be attached to one active mount at a time, and a pre-deploy step is exactly the kind of transient, parallel-to-the-old-deployment execution that could either fail to get it or — worse — silently succeed against an empty ephemeral filesystem, creating a throwaway SQLite file that gives false confidence a migration "worked" when the real database was never touched). Running migrations inside the actual service's own startup, as this app already does, sidesteps that ambiguity entirely: the code only ever runs once it's the real process with the real volume mounted.

**Multi-replica changes this.** N replicas booting simultaneously would race the same migration statements against the shared database — migrations are not designed for concurrent execution. The multi-replica posture (see §8) is: set `RIFTSIGHT_MIGRATE_ON_BOOT=false` on the service, and run `npm run migrate -w relay` once per deploy that includes a new migration, from a local machine with `RIFTSIGHT_DB_PATH` pointed at the same remote database (a Turso `libsql://` URL — a remote database is itself a multi-replica prerequisite, so there's no volume-mount ambiguity in that flow).

## 8. One replica by default — what multi-replica actually requires

`railway.json` sets `numReplicas: 1` and `sleepApplication: false` — do not raise the replica count, enable Railway's autoscaling, or turn on the "Serverless"/app-sleeping toggle **as currently configured** (Settings → Deploy → Serverless is off by default on Railway's own Hobby-plan default, but is easy to enable later without realizing the consequences below — `sleepApplication: false` in `railway.json` is a config-level guarantee against that, not just a reminder not to click it). Sleeping is never OK for this service regardless of replica count: waking drops every connected producer/viewer WebSocket, a visible interruption to a live stream.

With the current configuration, two things make a second replica not merely unhelpful but broken:

- **Local SQLite on an exclusive volume**: `RIFTSIGHT_DB_PATH=file:/data/riftsight.db` is a single file on the one volume mounted to this one replica — and `railway.json`'s `deploy.requiredMountPath: "/data"` physically prevents Railway from starting a second replica at all (a volume attaches to one active mount at a time). That's a feature while single-instance: it turns a misclick on the replica slider into a failed deploy instead of database corruption.
- **In-memory live session state without a bus**: with `REDIS_URL` unset, `relay/src/server.ts`'s `Session` map (which producer is connected, which viewers are subscribed, the latest overlay state) lives entirely in one process's memory. A producer connecting to replica A and a viewer connecting to replica B would simply never see each other, silently, with no error on either side.

**The multi-replica path** (built and tested — see [docs/scaling-plan.md](scaling-plan.md), Stage 1 — but requiring all of the following operator changes together, none of which should be done piecemeal):

1. **Remote database**: provision Turso, run migrations against it once (`RIFTSIGHT_DB_PATH=libsql://… npm run migrate -w relay`), copy the current allowlist/broadcaster/credential rows over, and point the service's `RIFTSIGHT_DB_PATH` at the `libsql://…` URL. The local file and its volume stop being used.
2. **Remove the volume dependency**: delete `deploy.requiredMountPath: "/data"` from `railway.json` and detach the volume — with the database remote, nothing needs `/data`, and the mount is what physically blocks replica #2. (This also removes §8's redeploy-downtime caveat: stateless replicas can overlap during cutover.)
3. **Redis bus**: provision Railway's Redis add-on (project canvas → Create → Database → Redis) and set `REDIS_URL` on the relay service (Railway exposes the add-on's connection string as a referenceable variable). This carries live state, viewer counts, and restart snapshots across replicas.
4. **Migration gating**: set `RIFTSIGHT_MIGRATE_ON_BOOT=false` (see §7) and adopt the migrate-once-per-deploy flow.
5. Only then raise `deploy.numReplicas`.

Do the Stage-2 staging spike first (WS load-balancing/draining behavior — see the scaling plan's operator checklist) before touching the production service.

**A volume means brief downtime on every redeploy, even with a healthy service.** Railway will not run two deployments mounted to the same volume at once — the old one has to fully stop before the new one can start and re-attach it, so there's a short gap (typically seconds) even with `healthcheckPath` configured, unlike a stateless service that can overlap old/new instances during cutover. This is a Railway platform behavior for any volume-backed service, not something this app's code can avoid. In practice: expect every redeploy and every restart to briefly disconnect any currently-connected producer/viewer — both already reconnect on their own (bounded backoff on the producer side, an immediate resubscribe on the viewer side — see the README's restart-recovery manual test), so this is a short visible blip, not something requiring manual recovery.

## 9. Graceful shutdown

`railway.json` sets `deploy.drainingSeconds: 15` — the time Railway allows between sending SIGTERM and following up with an unconditional SIGKILL. This has to be longer than `relay/src/index.ts`'s own shutdown path: on SIGTERM it starts closing the WebSocket server, then the HTTP server, then the database, with its own internal 10-second force-exit fallback if any step hangs. 15s gives that internal 10s timer room to actually fire and self-exit cleanly in the worst case, rather than risking Railway's SIGKILL landing first — a `drainingSeconds` shorter than 10s would mean the app's own graceful-shutdown code might never get to run to completion at all. If either number changes in the future, keep `drainingSeconds` a few seconds larger than the app's own internal timeout, not equal to it.

## 10. Redeploy, restart, rollback

- **Redeploy**: push to the branch Railway is watching, or trigger a manual redeploy from the dashboard — Railway builds the Dockerfile fresh and does a cutover gated by the `/ready` health check from step 6 (with the brief volume-remount downtime noted in step 8).
- **Restart** (no code change, just cycle the process): Railway's dashboard has a Restart action on the service; equivalent to the `kill -TERM <pid>` graceful-shutdown path documented in the operator runbook — the same SIGTERM handling in `relay/src/index.ts` applies regardless of who sends the signal, bounded by the `drainingSeconds` grace period from step 9.
- **Rollback**: Railway retains previous deployments — redeploy an earlier one from the deployment history. Matches the operator runbook's existing rollback guidance: no destructive migrations exist yet, so rolling back to an older build is safe without a corresponding down-migration.

## 11. Database backup and restore

**Scheduled backups (the primary mechanism):** the volume's own Settings → Backups tab lets you enable Daily/Weekly/Monthly schedules (multiple can run simultaneously), each with its own retention window — this is Railway's native, incremental, copy-on-write volume backup feature, which covers the whole `/data` volume (the SQLite file included) without any app-specific configuration. Enable at least the daily schedule once the service is live. Confirm this is included on your Railway plan before relying on it exclusively — re-verify against Railway's current pricing/plan docs, since this is exactly the kind of thing that varies by plan tier.

**Manual/on-demand backup** (before a risky operation — a migration, a manual DB edit, testing restore itself): either trigger one from the same Backups tab, or run the same `sqlite3 .backup` approach the operator runbook documents for a plain host, against the live container:

```bash
railway run --service <your-service-name> -- sqlite3 /data/riftsight.db ".backup /data/backup-$(date +%Y%m%d-%H%M%S).db"
```

then copy the resulting file off the volume (Railway's CLI/dashboard file-browsing tooling, or a temporary one-off script that uploads it somewhere you control) rather than leaving ad hoc backups sitting on the same volume as the live database indefinitely — the native scheduled backups above already live on Railway's own storage, separate from the volume itself.

**Restore**: from the Backups tab, find the backup by timestamp and click Restore — Railway stages this as a new volume dated to the backup, mounts it in place of the current one, and leaves the original (now-unmounted) volume around rather than deleting it immediately. Restoring removes any backups newer than the one you restored to, so don't restore casually while chasing an unrelated issue. If you used the manual `sqlite3 .backup` file approach instead, restoring means copying that file back to `/data/riftsight.db` and restarting the service — pending migrations, if the backup predates a schema change, apply automatically on the next boot, exactly as documented in the operator runbook's own restore section.

**Test the restore flow once, before you need it for real.** Do this in a disposable environment — a throwaway Railway project, or a duplicated environment within this project, seeded with test data (not a real streamer's live database) — rather than the first attempt being live during an actual incident. Confirm end-to-end: a backup taken, a restore performed, and the relay comes back up cleanly afterward with `npm run seed-allowlist -w relay -- list` and `credential-status <twitchUserId>` showing exactly what you expect. Tear the disposable environment down once you've confirmed it works.

## 12. Everything else

Onboarding a streamer, rotating/revoking a producer credential, diagnosing a failure, and every other day-to-day operation are identical to any other deployment of this backend — see [docs/operator-runbook.md](operator-runbook.md), which doesn't distinguish Railway from any other host for any of that.
