import { createServer } from "node:http";
import { validateEnv } from "./env.js";
import { createDbClient } from "./db/client.js";
import { loadMigrations, runMigrations } from "./db/migrate.js";
import { createStateStore } from "./auth/state-store.js";
import { createLinkHandoffStore } from "./auth/link-handoff.js";
import type { TwitchOAuthConfig } from "./auth/twitch-oauth.js";
import { createHttpRouter } from "./http/server.js";
import { attachRelayWebSocketServer } from "./server.js";
import { createRedisStateBus, type RedisStateBus } from "./redis-state-bus.js";
import { logEvent } from "./logging.js";

const result = validateEnv(process.env);

if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[relay] ${error}`);
  }
  console.error("[relay] refusing to start due to invalid configuration. See .env.example.");
  process.exit(1);
}

for (const warning of result.warnings) {
  console.warn(`[relay] ${warning}`);
}

const { config } = result;
console.log(`[relay] starting in "${config.mode}" mode`);

const db = createDbClient(config.dbUrl);

// Applied at every boot by default, not just via the standalone `npm run
// migrate` command — runMigrations() only ever applies pending
// (not-yet-recorded) migrations, so this is a safe no-op once a deploy's
// already current, and it means a fresh single-instance beta deployment
// can't accidentally start against an un-migrated database. Multi-replica
// deployments set RIFTSIGHT_MIGRATE_ON_BOOT=false (see RelayEnvConfig.
// migrateOnBoot for the boot-race rationale) and run the standalone
// command (scripts/migrate.ts, documented in the deployment docs) once
// against the shared database instead.
if (config.migrateOnBoot) {
  const migrations = await loadMigrations();
  const { applied } = await runMigrations(db, migrations);
  if (applied.length > 0) {
    console.log(`[relay] applied migrations: ${applied.join(", ")}`);
  }
} else {
  console.log("[relay] RIFTSIGHT_MIGRATE_ON_BOOT=false — skipping boot-time migrations (run `npm run migrate -w relay` once per deploy instead)");
}

// Only wired up once all three OAuth env vars are present — see
// http/server.ts's HttpRouterDeps doc comment for what happens to the
// OAuth routes when this is undefined (503, not 404).
const oauthConfig: TwitchOAuthConfig | undefined =
  config.twitchApiClientId && config.twitchApiClientSecret && config.twitchOAuthRedirectUri
    ? { clientId: config.twitchApiClientId, clientSecret: config.twitchApiClientSecret, redirectUri: config.twitchOAuthRedirectUri }
    : undefined;

const stateStore = createStateStore();
const linkHandoff = createLinkHandoffStore();

// Sanitized, closed-beta-only startup snapshot — booleans and a bare
// hostname only, so it's safe to leave in any log stream by default. The
// first thing an operator should check after a deploy/restart (see
// docs/operator-runbook.md's "Inspect the startup configuration summary").
if (config.mode === "closed-beta") {
  logEvent("startup_summary", {
    mode: config.mode,
    databaseConfigured: config.dbUrl.length > 0,
    // A heuristic, not a guarantee this code can actually verify (it has
    // no way to know whether a given path is on a mounted volume) — true
    // for an absolute file path or a remote libsql/https URL, false for
    // the relative-to-cwd default, which is the shape most likely to be
    // silently ephemeral inside a container.
    databasePersistentPath: !config.dbUrl.startsWith("file:./"),
    localDebugEnabled: config.allowLocalDebug,
    producerAuthRequired: config.mode === "closed-beta",
    twitchViewerAuthConfigured: Boolean(config.twitchExtensionSecret),
    oauthConfigured: Boolean(oauthConfig),
    publicBackendOrigin: config.twitchOAuthRedirectUri ? new URL(config.twitchOAuthRedirectUri).hostname : undefined,
  });
}

const httpServer = createServer(
  createHttpRouter({
    db,
    stateStore,
    linkHandoff,
    oauthConfig,
  })
);

// Cross-instance live-state fan-out (see docs/scaling-plan.md's "Stage 1")
// is entirely opt-in: unset REDIS_URL means attachRelayWebSocketServer gets
// no stateBus at all and falls back to its own default (a fresh in-process
// LocalStateBus), identical to every deployment before this existed. Only
// constructed here — server.ts never closes an injected bus, since it
// doesn't own one it didn't create.
const redisStateBus: RedisStateBus | undefined = config.redisUrl ? createRedisStateBus(config.redisUrl) : undefined;

const { close: closeWebSocketServer } = attachRelayWebSocketServer(httpServer, {
  twitchExtensionClientId: config.twitchExtensionClientId,
  twitchExtensionSecret: config.twitchExtensionSecret,
  allowLocalDebug: config.allowLocalDebug,
  // The authenticated /ws/producer endpoint is always attached (so a
  // producer credential works regardless of mode), but it's only REQUIRED
  // — i.e. the legacy unauthenticated bare-socket producer path is only
  // disabled — in closed-beta, matching development/twitch-local-test's
  // "fast local iteration / existing tunnel workflow remains unchanged"
  // requirements.
  producerAuth: { db, required: config.mode === "closed-beta" },
  stateBus: redisStateBus,
  // Only pass an override when the operator actually set one — undefined
  // lets server.ts fall through to WS_CONNECTION_LIMIT's default.
  wsConnectionLimit:
    config.wsConnectionsPerMinute !== undefined ? { maxEvents: config.wsConnectionsPerMinute, windowMs: 60_000 } : undefined,
});

httpServer.on("error", (err) => {
  console.error("[relay] server error:", err);
  process.exit(1);
});

// Explicit host bind rather than Node's platform-dependent default —
// Railway (and most PaaS platforms) require binding 0.0.0.0 specifically
// for their proxy to reach the container.
httpServer.listen(config.port, "0.0.0.0", () => {
  console.log(`[relay] listening on http://0.0.0.0:${config.port} (mode: ${config.mode})`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] received ${signal}, shutting down gracefully`);

  const forceExitTimer = setTimeout(() => {
    console.error("[relay] graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  try {
    await closeWebSocketServer();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await redisStateBus?.close();
    db.close();
    clearTimeout(forceExitTimer);
    console.log("[relay] shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[relay] error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
