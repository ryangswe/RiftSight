import { createServer } from "node:http";
import { validateEnv } from "./env.js";
import { createDbClient } from "./db/client.js";
import { loadMigrations, runMigrations } from "./db/migrate.js";
import { createStateStore } from "./auth/state-store.js";
import { createLinkHandoffStore } from "./auth/link-handoff.js";
import type { TwitchOAuthConfig } from "./auth/twitch-oauth.js";
import { createHttpRouter } from "./http/server.js";
import { attachRelayWebSocketServer } from "./server.js";

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

// Applied at every boot, not just via the standalone `npm run migrate`
// command — runMigrations() only ever applies pending (not-yet-recorded)
// migrations, so this is a safe no-op once a deploy's already current, and
// it means a fresh single-instance beta deployment can't accidentally
// start against an un-migrated database. The standalone command (see
// scripts/migrate.ts, documented in the deployment docs) remains the
// explicit "I want to migrate without starting the server" path.
const migrations = await loadMigrations();
const { applied } = await runMigrations(db, migrations);
if (applied.length > 0) {
  console.log(`[relay] applied migrations: ${applied.join(", ")}`);
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

const httpServer = createServer(
  createHttpRouter({
    db,
    stateStore,
    linkHandoff,
    oauthConfig,
  })
);

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
});

httpServer.on("error", (err) => {
  console.error("[relay] server error:", err);
  process.exit(1);
});

httpServer.listen(config.port, () => {
  console.log(`[relay] listening on http://localhost:${config.port} (mode: ${config.mode})`);
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
